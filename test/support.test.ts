// spec-134 / ea-claude-139 — `doctor --send` support-bundle delivery + the
// operator support inbox (support pending/read/dismiss).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { handleCli } from "../src/cli.ts";
import { buildDoctorReport } from "../src/doctor.ts";
import { buildSupportBundleEnvelope, renderConsentPrompt, runDoctorSend, SUPPORT_BUNDLE_MAX_BYTES } from "../src/doctor-send.ts";
import { EdgeBookError, EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";
import { readEvents } from "../src/event-log.ts";
import { receiveSupportBundle, saveSupportBundles, supportBundles, SUPPORT_BUNDLE_KEEP } from "../src/store-support.ts";

const SECRET_BODY = "SECRET-BODY-MARKER-must-never-leak-9f2c";
const NOTIFY_TOKEN = "NOTIFY-TOKEN-MARKER-must-never-leak-41ab";

// FakeSocket acks hello + mailbox_send so deliverEnvelopeViaMailbox resolves
// (pattern: test/dialout-friend-relay.test.ts).
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: Record<string, unknown>[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;
  constructor() { FakeSocket.all.push(this); }
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "ch", server_time: new Date().toISOString() }));
    if (frame.type === "mailbox_send") queueMicrotask(() => this.receive({ type: "mailbox_send_ok", request_id: frame.request_id, id: "host-msg-support-1" }));
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (event?: unknown) => void): void { (this.listeners[event] ||= []).push(handler); }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

function lastMailboxSend(): { to: string; blob_b64: string; trace_id?: string } | undefined {
  for (let i = FakeSocket.all.length - 1; i >= 0; i--) {
    const frame = FakeSocket.all[i]!.sent.find((f) => f.type === "mailbox_send");
    if (frame) return frame as { to: string; blob_b64: string; trace_id?: string };
  }
  return undefined;
}

// Minimal relay stand-in: answers GET / (doctor reachability) and
// GET /support/recipient with the configured DID (or 404 when unset).
async function startFakeRelay(supportDid: string | null): Promise<{ host: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/support/recipient") {
      if (!supportDid) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "not_found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, did: supportDid }));
      return;
    }
    res.writeHead(200); res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    host: `ws://127.0.0.1:${port}/agent/ws`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// A user store seeded the way doctor.test.ts seeds: a friend who sent a
// privileged message with a known secret body, plus a secret-marked post.
async function seededUser(): Promise<EdgeBookStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-support-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const user = new EdgeBookStore({ home: path.join(root, "user") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  const userId = await user.init({ handle: "user.openclaw.local", displayName: "User Agent" });
  const userCard = await user.writeCard();
  await user.receiveFriendRequest(await alice.createFriendRequest(userCard));
  const response = await user.acceptFriend((await alice.identity()).agent_id);
  await alice.applyFriendResponse(response);
  const message = await alice.sendPrivilegedMessage(userId.agent_id, { text: SECRET_BODY });
  await user.receivePrivilegedMessage(message);
  await user.createPost({ title: "draft", body: SECRET_BODY });
  // notify_cmd can embed a channel token — doctor must only ever echo a
  // boolean for it. The marker pins the sent-bytes assertion below.
  await user.updateConfig({ notify_cmd: `notify.sh --token ${NOTIFY_TOKEN}` });
  return user;
}

async function operatorStore(name: string, inboxOn = true): Promise<EdgeBookStore> {
  const op = new EdgeBookStore({ home: await fs.mkdtemp(path.join(os.tmpdir(), `eb-op-${name}-`)) });
  await op.init({ handle: `${name}.openclaw.local`, displayName: "Operator Support" });
  if (inboxOn) await op.updateConfig({ support_inbox: true });
  return op;
}

test("doctor --send fails with a clear message when no support recipient is configured", async () => {
  const user = await seededUser();
  const relay = await startFakeRelay(null);
  try {
    await assert.rejects(
      handleCli(["doctor", "--send", "--yes", "--home", user.home, "--host", relay.host]),
      (error: unknown) => {
        assert.ok(error instanceof EdgeBookError);
        assert.equal(error.code, "no_support_recipient");
        assert.match(error.message, /SUPPORT_DID|support recipient/i);
        return true;
      },
    );
  } finally {
    await relay.close();
  }
});

test("doctor --send fails closed without consent in a non-interactive run", async () => {
  const user = await seededUser();
  const relay = await startFakeRelay(null);
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await assert.rejects(
      handleCli(["doctor", "--send", "--to", "did:openclaw:op", "--home", user.home, "--host", relay.host]),
      (error: unknown) => error instanceof EdgeBookError && error.code === "confirmation_required",
    );
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    await relay.close();
  }
});

test("consent prompt names the recipient, the bundle sections, and the size; declining sends nothing", async () => {
  const user = await seededUser();
  const relay = await startFakeRelay(null);
  let promptText = "";
  const sendsBefore = FakeSocket.all.length;
  try {
    const result = await runDoctorSend(user, user.home, {
      host: relay.host,
      yes: false,
      to: "did:openclaw:op-consent",
      confirmImpl: async (prompt) => { promptText = prompt; return false; },
      socketFactory: () => { throw new Error("must not dial out when consent is declined"); },
    });
    assert.equal(result.text, "Aborted — nothing was sent.");
    assert.equal(FakeSocket.all.length, sendsBefore, "no socket opened");
    assert.ok(promptText.includes("did:openclaw:op-consent"), "prompt names the recipient");
    for (const section of ["identity", "relay reachability", "friend-request counts", "event-log tail", "notification settings", "store counts"]) {
      assert.ok(promptText.includes(section), `prompt lists section: ${section}`);
    }
    assert.match(promptText, /KiB \(cap 256 KiB\)/, "prompt states the size and cap");
    assert.ok(!promptText.includes(SECRET_BODY));
  } finally {
    await relay.close();
  }
});

test("doctor --send --yes delivers the sanitized bundle, prints the support reference, and logs support.sent", async () => {
  const user = await seededUser();
  const relay = await startFakeRelay("did:openclaw:discovered-op");
  try {
    const identity = await user.identity();
    const result = await handleCli([
      "doctor", "--send", "--yes", "--note", "dialout drops every 5 min",
      "--home", user.home, "--host", relay.host,
    ], { socketFactory: (() => { const s = new FakeSocket(); queueMicrotask(() => s.emit("open")); return s; }) as never });

    // Recipient came from relay discovery (GET /support/recipient).
    const frame = lastMailboxSend();
    assert.ok(frame, "a mailbox_send frame left the agent");
    assert.equal(frame!.to, "did:openclaw:discovered-op");

    const envelope = JSON.parse(Buffer.from(frame!.blob_b64, "base64").toString("utf8")) as MessageEnvelope;
    assert.equal(envelope.type, "support_bundle");
    assert.equal(envelope.to_agent_id, "did:openclaw:discovered-op");
    assert.ok(envelope.trace_id, "envelope carries a trace_id");
    assert.equal(frame!.trace_id, envelope.trace_id, "trace_id mirrored on the frame for relay correlation");

    // The printed support reference IS the envelope trace_id.
    assert.ok(result.text.includes(`support reference: ${envelope.trace_id}`), `reference printed: ${result.text}`);

    // Sanitization inherited from buildDoctorReport: same assertions as the
    // doctor paste-safety test, applied to the bytes that actually left.
    const blob = Buffer.from(frame!.blob_b64, "base64").toString("utf8");
    assert.ok(!blob.includes(SECRET_BODY), "message/post body leaked into the sent bundle");
    assert.ok(!blob.includes(NOTIFY_TOKEN), "notify_cmd token leaked into the sent bundle");
    assert.ok(!blob.includes("PRIVATE KEY"), "PEM private key header leaked into the sent bundle");
    for (const line of identity.private_key_pem.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("-----")) continue;
      assert.ok(!blob.includes(trimmed), "private key material leaked into the sent bundle");
    }
    // The user's own consented note rides along.
    assert.ok(blob.includes("dialout drops every 5 min"));

    // Flight recorder: support.sent with the same trace.
    const events = await readEvents(user);
    const sent = events.find((e) => e.kind === "support.sent");
    assert.ok(sent, "support.sent event logged");
    assert.equal(sent!.trace_id, envelope.trace_id);
  } finally {
    await relay.close();
  }
});

test("oversize bundles are rejected client-side with a graceful error", async () => {
  const user = await seededUser();
  const report = await buildDoctorReport(user, { host: "ws://127.0.0.1:9/agent/ws", fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch, hermesRunner: { hermesBin: null, list: () => "", create: () => undefined, getPrompt: () => null, remove: () => undefined } });
  const hugeNote = "x".repeat(SUPPORT_BUNDLE_MAX_BYTES + 1);
  await assert.rejects(
    buildSupportBundleEnvelope(user, "did:openclaw:op", report, hugeNote),
    (error: unknown) => error instanceof EdgeBookError && error.code === "support_bundle_too_large" && /256 KiB/.test(error.message),
  );
});

test("receiver rejects oversize bundles independently of the sender cap (--to bypass)", async () => {
  const user = await seededUser();
  const op = await operatorStore("sizeop", true);
  const opDid = (await op.identity()).agent_id;
  const report = await buildDoctorReport(user, { host: "ws://127.0.0.1:9/agent/ws", fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch, hermesRunner: { hermesBin: null, list: () => "", create: () => undefined, getPrompt: () => null, remove: () => undefined } });
  // Build a small valid envelope, then inflate the signed body out-of-band the
  // way a hostile sender (not using our client) could: sign over a huge note.
  const envelope = await user.signEnvelope({ to_agent_id: opDid, type: "support_bundle", body: { card: await user.writeCard(), report, note: "y".repeat(SUPPORT_BUNDLE_MAX_BYTES + 1) } as unknown as MessageEnvelope["body"] });
  await assert.rejects(
    receiveSupportBundle(op, envelope),
    (error: unknown) => error instanceof EdgeBookError && error.code === "support_bundle_too_large",
  );
});

test("retention: the inbox holds at most SUPPORT_BUNDLE_KEEP records, evicting dismissed-then-oldest", async () => {
  const user = await seededUser();
  const op = await operatorStore("keepop", true);
  const opDid = (await op.identity()).agent_id;
  const report = await buildDoctorReport(user, { host: "ws://127.0.0.1:9/agent/ws", fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch, hermesRunner: { hermesBin: null, list: () => "", create: () => undefined, getPrompt: () => null, remove: () => undefined } });
  // Seed KEEP records directly (cheap), mark the very first dismissed, then
  // receive one more real envelope — the dismissed one must be evicted.
  const seeded: Record<string, import("../src/types.ts").SupportBundleRecord> = {};
  for (let i = 0; i < SUPPORT_BUNDLE_KEEP; i++) {
    const id = `msg_seed_${String(i).padStart(4, "0")}`;
    seeded[id] = { bundle_id: id, from_agent_id: "did:openclaw:seeder", received_at: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, status: i === 0 ? "dismissed" : "pending", report } as import("../src/types.ts").SupportBundleRecord;
  }
  await saveSupportBundles(op, seeded);
  const envelope = await buildSupportBundleEnvelope(user, opDid, report);
  await receiveSupportBundle(op, envelope);
  const all = await supportBundles(op);
  assert.equal(Object.keys(all).length, SUPPORT_BUNDLE_KEEP, "inbox stays at the cap");
  assert.ok(!all["msg_seed_0000"], "dismissed record evicted first");
  assert.ok(all[envelope.message_id], "newest arrival survives");
});

test("operator roundtrip: receive → pending → read → dismiss; inbox is fail-closed by default", async () => {
  const user = await seededUser();
  const op = await operatorStore("ops", true);
  const opDid = (await op.identity()).agent_id;
  const report = await buildDoctorReport(user, { host: "ws://127.0.0.1:9/agent/ws", fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch, hermesRunner: { hermesBin: null, list: () => "", create: () => undefined, getPrompt: () => null, remove: () => undefined } });

  // Fail closed: an agent that never opted in rejects the bundle outright.
  const bystander = await operatorStore("bystander", false);
  const strayEnvelope = await buildSupportBundleEnvelope(user, (await bystander.identity()).agent_id, report);
  await assert.rejects(
    receiveSupportBundle(bystander, strayEnvelope),
    (error: unknown) => error instanceof EdgeBookError && error.code === "support_inbox_disabled",
  );

  // Two bundles arrive at the opted-in operator (file-hop via `support receive`).
  const envelopeA = await buildSupportBundleEnvelope(user, opDid, report, "first ticket");
  const envelopeB = await buildSupportBundleEnvelope(user, opDid, report);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eb-support-env-"));
  await fs.writeFile(path.join(dir, "a.json"), JSON.stringify(envelopeA), "utf8");
  await fs.writeFile(path.join(dir, "b.json"), JSON.stringify(envelopeB), "utf8");
  await handleCli(["support", "receive", path.join(dir, "a.json"), "--home", op.home]);
  await handleCli(["support", "receive", path.join(dir, "b.json"), "--home", op.home]);

  // Pending lists both, oldest first, with the support reference.
  const pending = await handleCli(["support", "pending", "--home", op.home]);
  assert.ok(pending.text.includes(envelopeA.message_id));
  assert.ok(pending.text.includes(envelopeB.message_id));
  assert.ok(pending.text.includes(`ref=${envelopeA.trace_id}`), `listing shows the support reference: ${pending.text}`);
  assert.ok(pending.text.includes("User Agent"), "listing shows the sender display name");

  // Read shows the report and marks it read.
  const read = await handleCli(["support", "read", envelopeA.message_id, "--home", op.home]);
  assert.ok(read.text.includes("(marked read)"));
  assert.ok(read.text.includes("note:    first ticket"));
  assert.ok(read.text.includes('"pending_requests"'), "report JSON rendered");

  // Dismiss the second; the pending queue is now empty.
  await handleCli(["support", "dismiss", envelopeB.message_id, "--home", op.home]);
  const after = await handleCli(["support", "pending", "--home", op.home]);
  assert.equal(after.text, "No pending support bundles.");

  // `support list` keeps the audit view; the operator event log recorded both.
  const list = await handleCli(["support", "list", "--home", op.home]);
  assert.ok(list.text.includes("read"));
  assert.ok(list.text.includes("dismissed"));
  const events = await readEvents(op);
  assert.equal(events.filter((e) => e.kind === "support.received").length, 2);

  // Replay of an already-applied bundle is rejected (dedupe by message_id).
  await assert.rejects(
    receiveSupportBundle(op, envelopeA),
    (error: unknown) => error instanceof EdgeBookError && error.code === "replay",
  );
});

test("consent prompt renderer is exact about recipient and note", async () => {
  const user = await seededUser();
  const report = await buildDoctorReport(user, { host: "ws://127.0.0.1:9/agent/ws", fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch, hermesRunner: { hermesBin: null, list: () => "", create: () => undefined, getPrompt: () => null, remove: () => undefined } });
  const prompt = renderConsentPrompt(report, "did:openclaw:op", 12_345, "my note");
  assert.ok(prompt.includes("recipient: did:openclaw:op"));
  assert.ok(prompt.includes('your note: "my note"'));
  assert.ok(prompt.includes("12.1 KiB"));
});
