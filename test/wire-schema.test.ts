// Wire-frame contract schema tests (ea-claude-152, cli half):
//   (a) generated embed (src/wire-schema.ts) ↔ vendored JSON artifact sync
//   (b) validator unit cases (accept/reject per the schema subset)
//   (c) OUTBOUND contract: frames exactly as dialout.ts constructs them
//       validate against the vendored host schema (cross-repo contract test)
//   (d) inbound gate: invalid host frames are dropped fail-closed (deliver not
//       acked, rpc replies not resolved) and logged as frame.invalid
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WIRE_FRAMES_SCHEMA } from "../src/wire-schema.ts";
import { validateWireFrame, gateHostFrame } from "../src/frame-validate.ts";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { readEvents } from "../src/event-log.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── (a) Embed ↔ vendored JSON artifact sync ──────────────────────────────────
test("src/wire-schema.ts embeds exactly schemas/wire-frames.schema.json", () => {
  const json = JSON.parse(fsSync.readFileSync(path.join(ROOT, "schemas", "wire-frames.schema.json"), "utf8"));
  assert.deepEqual(WIRE_FRAMES_SCHEMA, json);
});

test("schema defines every wire frame plus the WireFrame union", () => {
  const defs = (WIRE_FRAMES_SCHEMA as { definitions: Record<string, unknown> }).definitions;
  for (const name of [
    "MailboxSendFrame", "MailboxSendOkFrame", "MailboxSendErrFrame", "MailboxDeliverFrame",
    "MailboxAckFrame", "MailboxStatusFrame", "MailboxStatusOkFrame", "MailboxStatusErrFrame",
    "MailboxStatusEntry", "HandleClaimFrame", "HandleClaimOkFrame", "HandleClaimErrFrame",
    "MailboxMessage", "WireFrame",
  ]) assert.ok(defs[name], `missing definition ${name}`);
});

test("schema never sets additionalProperties:false (forward compatibility)", () => {
  assert.ok(!JSON.stringify(WIRE_FRAMES_SCHEMA).includes('"additionalProperties":false'));
});

// Guard against silent false-accepts: the runtime validator interprets only a
// keyword subset. If a vendored schema update introduces a keyword outside
// this allowlist (pattern, minimum, oneOf, allOf, ...), this test fails
// instead of the validator silently ignoring the constraint. Keep identical
// to the host's allowlist (edge-book-host test/wire-schema.test.ts).
const VALIDATOR_KEYWORDS = new Set([
  "$ref", "$schema", "$id", "anyOf", "const", "enum", "type",
  "required", "properties", "items", "definitions", "additionalProperties",
  "description", "title", "default",
]);
test("schema uses only keywords the runtime validator interprets", () => {
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${at}[${i}]`)); return; }
    if (!node || typeof node !== "object") return;
    const inProperties = at.endsWith(".properties") || at.endsWith(".definitions");
    for (const [key, value] of Object.entries(node)) {
      if (!inProperties && !VALIDATOR_KEYWORDS.has(key)) {
        assert.fail(`unsupported schema keyword "${key}" at ${at} — extend src/frame-validate.ts or the allowlist`);
      }
      walk(value, `${at}.${key}`);
    }
  };
  walk(WIRE_FRAMES_SCHEMA, "$");
});

// ── (b) Validator unit cases ──────────────────────────────────────────────────
const VALID_FRAMES: Record<string, Record<string, unknown>> = {
  MailboxSendFrame: { type: "mailbox_send", request_id: "r1", to: "chanB", blob_b64: "aGk=" },
  MailboxSendOkFrame: { type: "mailbox_send_ok", request_id: "r1", id: "m1" },
  MailboxSendErrFrame: { type: "mailbox_send_err", request_id: "r1", error: "blob_too_large" },
  MailboxDeliverFrame: { type: "mailbox_deliver", id: "m1", from: "chanA", blob_b64: "aGk=", ts: 1 },
  MailboxAckFrame: { type: "mailbox_ack", id: "m1" },
  MailboxStatusFrame: { type: "mailbox_status", request_id: "r1", ids: ["m1", "m2"] },
  MailboxStatusOkFrame: { type: "mailbox_status_ok", request_id: "r1", statuses: [{ id: "m1", state: "queued", queued_ms: 5, recipient_live: false }] },
  MailboxStatusErrFrame: { type: "mailbox_status_err", request_id: "r1", error: "invalid_mailbox_status" },
  HandleClaimFrame: { type: "handle_claim", request_id: "r1", handle: "alice-smith", card: { agent_id: "did:openclaw:a" }, claimed_at: 1, claim_sig: "s" },
  HandleClaimOkFrame: { type: "handle_claim_ok", request_id: "r1", handle: "alice-smith" },
  HandleClaimErrFrame: { type: "handle_claim_err", request_id: "r1", reason: "taken" },
};

test("every valid frame is accepted (optional fields absent)", () => {
  for (const [def, frame] of Object.entries(VALID_FRAMES)) {
    assert.deepEqual(validateWireFrame(def, frame), { ok: true }, def);
    assert.deepEqual(validateWireFrame("WireFrame", frame), { ok: true }, `WireFrame anyOf: ${def}`);
  }
});

test("unknown extra fields pass (old/new client skew tolerated)", () => {
  const frame = { ...VALID_FRAMES.MailboxDeliverFrame, future_field: { nested: true }, v: 2 };
  assert.deepEqual(validateWireFrame("MailboxDeliverFrame", frame), { ok: true });
});

test("missing required / wrong type / bad const-enum are rejected; errors cap at 5", () => {
  const missing = validateWireFrame("MailboxSendOkFrame", { type: "mailbox_send_ok", request_id: "r1" });
  assert.equal(missing.ok, false);
  assert.match((missing as { errors: string[] }).errors.join(), /"id"/);
  assert.equal(validateWireFrame("MailboxDeliverFrame", { ...VALID_FRAMES.MailboxDeliverFrame, ts: "soon" }).ok, false);
  assert.equal(validateWireFrame("MailboxAckFrame", { type: "mailbox_nack", id: "m1" }).ok, false);
  assert.equal(validateWireFrame("HandleClaimErrFrame", { type: "handle_claim_err", request_id: "r1", reason: "exploded" }).ok, false);
  const r = validateWireFrame("MailboxSendFrame", {});
  assert.equal(r.ok, false);
  assert.ok((r as { errors: string[] }).errors.length <= 5);
  assert.equal(validateWireFrame("NoSuchFrame", {}).ok, false);
});

test("gateHostFrame: covered inbound types gate, uncovered/outbound pass, no contents leak", () => {
  assert.deepEqual(gateHostFrame(VALID_FRAMES.MailboxDeliverFrame), { ok: true });
  assert.deepEqual(gateHostFrame({ type: "ping" }), { ok: true }); // uncovered → pass
  assert.deepEqual(gateHostFrame({ type: "mailbox_send", bogus: true }), { ok: true }); // agent→host type: not gated inbound
  const bad = gateHostFrame({ type: "mailbox_deliver", id: "m1", from: "chanA", blob_b64: "U0VDUkVU", ts: "yesterday" });
  assert.equal(bad.ok, false);
  assert.equal((bad as { frameType: string }).frameType, "mailbox_deliver");
  assert.equal((bad as { errorPaths: string }).errorPaths, "$.ts");
  assert.ok(!JSON.stringify(bad).includes("U0VDUkVU"), "blob contents never in gate result");
});

// ── (c+d) Dial-out client: outbound contract + inbound fail-closed gate ──────
class FakeSocket {
  sent: Record<string, unknown>[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "test-channel" }));
    if (frame.type === "mailbox_send") queueMicrotask(() => this.receive({ type: "mailbox_send_ok", request_id: frame.request_id, id: "m-1", recipient_live: true }));
    if (frame.type === "mailbox_status") queueMicrotask(() => this.receive({ type: "mailbox_status_ok", request_id: frame.request_id, statuses: [{ id: "m-1", state: "acked" }] }));
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (event?: unknown) => void): void {
    (this.listeners[event] ||= []).push(handler);
  }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

async function startClient(): Promise<{ client: EdgeBookDialoutClient; socket: FakeSocket; store: EdgeBookStore }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-wire-test-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "wire-contract-agent" }); // valid slug → handle_claim fires
  let socket!: FakeSocket;
  const client = new EdgeBookDialoutClient({
    home, host: "ws://host.test/agent", openLocalApi: false, reconnect: false, heartbeatMs: 60_000,
    socketFactory: () => { socket = new FakeSocket(); queueMicrotask(() => socket.emit("open")); return socket; },
  });
  await client.start();
  return { client, socket, store };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("OUTBOUND contract: frames as dialout.ts constructs them validate against the vendored schema", async () => {
  const { client, socket } = await startClient();
  try {
    await client.sendMailbox("did:openclaw:peer", Buffer.from("hi"));
    await client.sendMailbox("did:openclaw:peer", Buffer.from("hi"), 5_000, "trace-1");
    await client.transport().ack("m-1");
    assert.deepEqual(await client.mailboxStatusAndWait(["m-1"]), [{ id: "m-1", state: "acked" }]);
    await waitFor(() => socket.sent.some((f) => f.type === "handle_claim"));

    const byType = (t: string) => socket.sent.filter((f) => f.type === t);
    const defFor: Record<string, string> = { mailbox_send: "MailboxSendFrame", mailbox_ack: "MailboxAckFrame", mailbox_status: "MailboxStatusFrame", handle_claim: "HandleClaimFrame" };
    for (const [type, def] of Object.entries(defFor)) {
      const frames = byType(type);
      assert.ok(frames.length > 0, `captured at least one ${type}`);
      for (const frame of frames) {
        assert.deepEqual(validateWireFrame(def, frame), { ok: true }, `${type}: ${JSON.stringify(frame)}`);
        assert.deepEqual(validateWireFrame("WireFrame", frame), { ok: true }, `WireFrame: ${type}`);
      }
    }
    const sends = byType("mailbox_send");
    assert.equal(sends.length, 2);
    assert.ok(!("trace_id" in sends[0]!) && sends[1]!.trace_id === "trace-1", "with and without trace_id");
    assert.equal(typeof byType("handle_claim")[0]!.discoverable, "boolean", "handle_claim carries discoverable");
  } finally {
    await client.stop();
  }
});

test("inbound gate: invalid mailbox_deliver is ignored (NOT acked) and logs frame.invalid; valid one delivers", async () => {
  const { client, socket, store } = await startClient();
  try {
    socket.receive({ type: "mailbox_deliver", id: "bad-1", from: "chanA", blob_b64: "aGk=", ts: "yesterday" });
    await new Promise((r) => setTimeout(r, 50)); // settle: give the (dropped) frame time to be mishandled
    assert.ok(!socket.sent.some((f) => f.type === "mailbox_ack"), "invalid deliver must not be acked");
    const events = await readEvents(store);
    const invalid = events.find((e) => e.kind === "frame.invalid");
    assert.ok(invalid, "frame.invalid logged");
    assert.equal(invalid!.frame_type, "mailbox_deliver");
    assert.equal(invalid!.errors, "$.ts");
    assert.ok(!JSON.stringify(invalid).includes("aGk="), "log never carries blob_b64 contents");

    socket.receive({ type: "mailbox_deliver", id: "good-1", from: "chanA", blob_b64: Buffer.from("{}").toString("base64"), ts: Date.now() });
    await waitFor(() => socket.sent.some((f) => f.type === "mailbox_ack" && f.id === "good-1"));
  } finally {
    await client.stop();
  }
});

test("inbound gate: invalid mailbox_send_ok does not resolve the pending send (timeout fires)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-wire-test-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "wire-rpc-agent" });
  let socket!: FakeSocket;
  const client = new EdgeBookDialoutClient({
    home, host: "ws://host.test/agent", openLocalApi: false, reconnect: false, heartbeatMs: 60_000,
    socketFactory: () => {
      socket = new FakeSocket();
      // Reply to mailbox_send with an INVALID ack (id missing).
      socket.send = function (data: string) {
        const frame = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(frame);
        if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "c" }));
        if (frame.type === "mailbox_send") queueMicrotask(() => this.receive({ type: "mailbox_send_ok", request_id: frame.request_id }));
      };
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  await client.start();
  try {
    await assert.rejects(
      client.sendMailbox("did:openclaw:peer", Buffer.from("hi"), 150),
      (e: Error & { code?: string }) => e.code === "mailbox_send_timeout",
    );
    const events = await readEvents(store);
    assert.ok(events.some((e) => e.kind === "frame.invalid" && e.frame_type === "mailbox_send_ok"), "invalid rpc reply logged");
  } finally {
    await client.stop();
  }
});
