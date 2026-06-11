// ea-claude-138 — envelope trace correlation ids end-to-end.
//
// Covers: outbound stamping inside the signed payload, inbound propagation to
// the event log (received / dedup_hit / signature_failed / friend.*),
// back-compat with pre-trace peers (no trace_id still verifies + processes),
// the mailbox_send frame sibling field the relay correlates by, and the
// doctor "recent traces" view.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signPayload, withoutSignature } from "../src/crypto.ts";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { recentTraces } from "../src/doctor.ts";
import { EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";
import { readEvents } from "../src/event-log.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-trace-"));
}

async function pair(root: string): Promise<{ alice: EdgeBookStore; bob: EdgeBookStore; bobCard: Awaited<ReturnType<EdgeBookStore["writeCard"]>> }> {
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob" });
  return { alice, bob, bobCard: await bob.writeCard() };
}

test("signEnvelope stamps a trace_id inside the signed payload and it verifies", async () => {
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  const envelope = await alice.createFriendRequest(bobCard);
  assert.match(String(envelope.trace_id), /^trace_[A-Za-z0-9_-]+$/, "URL-safe trace id, repo id convention");
  // The signature covers trace_id: the receiver verifies the envelope as-is.
  await bob.receiveEnvelope(envelope); // throws on bad signature
});

test("inbound trace_id propagates to event-log entries for that envelope", async () => {
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  const envelope = await alice.createFriendRequest(bobCard);
  await bob.receiveEnvelope(envelope);

  // friend.request_received carries the trace.
  const events = await readEvents(bob);
  const received = events.find((e) => e.kind === "friend.request_received");
  assert.equal(received?.trace_id, envelope.trace_id);

  // Replay → dedup_hit carries the trace.
  await assert.rejects(() => bob.receiveEnvelope(envelope), /Replay/);
  const dedup = (await readEvents(bob)).find((e) => e.kind === "envelope.dedup_hit");
  assert.equal(dedup?.trace_id, envelope.trace_id);
});

test("tampered envelope logs signature_failed with the trace_id", async () => {
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  const envelope = await alice.createFriendRequest(bobCard);
  const tampered = { ...envelope, body: { ...envelope.body, note: "evil" } } as MessageEnvelope;
  await assert.rejects(() => bob.receiveEnvelope(tampered), /signature/);
  const failed = (await readEvents(bob)).find((e) => e.kind === "envelope.signature_failed");
  assert.equal(failed?.trace_id, envelope.trace_id);
});

test("back-compat: an envelope WITHOUT trace_id (old peer) still verifies and processes", async () => {
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  // Simulate an edge-book@0.11.x/0.12.x sender: same envelope shape, no
  // trace_id, signed over exactly the fields it carries.
  const modern = await alice.createFriendRequest(bobCard);
  const legacyUnsigned = withoutSignature({ ...modern });
  delete (legacyUnsigned as Partial<MessageEnvelope>).trace_id;
  const identity = await alice.identity();
  const legacy = { ...legacyUnsigned, signature: signPayload(legacyUnsigned, identity.private_key_pem) } as MessageEnvelope;

  const contact = await bob.receiveEnvelope(legacy);
  assert.ok(contact, "legacy envelope applied");
  const received = (await readEvents(bob)).find((e) => e.kind === "friend.request_received");
  assert.ok(received, "event still logged");
  assert.equal(received?.trace_id, undefined, "trace_id stays unset for old peers");
});

test("back-compat pin: an envelope carrying an UNKNOWN field still verifies (canonicalize covers every parsed field)", async () => {
  // Proxy pin for the new->old direction: a 0.11.x/0.12.x verifier runs this
  // same canonicalization code, so if an unknown signed field survives HERE,
  // it survives there. Guards against a future strict-parse/schema change
  // silently stripping unknown keys and breaking trace_id back-compat.
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  const modern = await alice.createFriendRequest(bobCard);
  const futureUnsigned = withoutSignature({ ...modern, future_field: "from-a-newer-version" } as unknown as MessageEnvelope);
  const identity = await alice.identity();
  const future = { ...futureUnsigned, signature: signPayload(futureUnsigned, identity.private_key_pem) } as MessageEnvelope;
  const contact = await bob.receiveEnvelope(future);
  assert.ok(contact, "envelope with unknown signed field applied");
});

test("caller-supplied trace_id is clamped to 128 chars; empty falls back to a generated id", async () => {
  const root = await tempRoot();
  const { alice, bobCard } = await pair(root);
  const base = { to_agent_id: bobCard.agent_id, type: "friend_request" as const, body: { note: "" } as unknown as MessageEnvelope["body"] };
  const clamped = await alice.signEnvelope({ ...base, trace_id: "x".repeat(300) });
  assert.equal(clamped.trace_id?.length, 128);
  const generated = await alice.signEnvelope({ ...base, trace_id: "" });
  assert.ok(generated.trace_id && generated.trace_id.startsWith("trace_"), "empty trace_id replaced with generated id");
});

// FakeSocket acks hello + mailbox_send (pattern: test/dialout-friend-relay.test.ts).
class FakeSocket {
  sent: Record<string, unknown>[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "ch", server_time: new Date().toISOString() }));
    if (frame.type === "mailbox_send") queueMicrotask(() => this.receive({ type: "mailbox_send_ok", request_id: frame.request_id, id: "host-msg-1" }));
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (event?: unknown) => void): void { (this.listeners[event] ||= []).push(handler); }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

test("end-to-end shape: ONE trace_id on sender log, relay frame, and receiver log", async () => {
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  const envelope = await alice.createFriendRequest(bobCard);
  const trace = envelope.trace_id!;

  // 1) Sender: dial-out delivery stamps the frame sibling + envelope.sent.
  let socket: FakeSocket | undefined;
  const client = new EdgeBookDialoutClient({
    home: alice.home,
    host: "ws://host.test/agent",
    socketFactory: (() => { socket = new FakeSocket(); queueMicrotask(() => socket!.emit("open")); return socket!; }) as never,
    reconnect: false,
    openLocalApi: false,
    heartbeatMs: 10_000,
  });
  await client.start();
  try {
    await client.sendEnvelope(envelope);
  } finally {
    await client.stop();
  }
  const frame = socket!.sent.find((f) => f.type === "mailbox_send")!;
  assert.equal(frame.trace_id, trace, "relay-visible sibling matches the signed trace_id");
  const senderEvents = await readEvents(alice);
  assert.equal(senderEvents.find((e) => e.kind === "envelope.sent")?.trace_id, trace);

  // 2) Receiver: applying the (still-signed) blob logs the same trace.
  const delivered = JSON.parse(Buffer.from(String(frame.blob_b64), "base64").toString("utf8")) as MessageEnvelope;
  await bob.receiveEnvelope(delivered);
  const receiverEvents = await readEvents(bob);
  assert.equal(receiverEvents.find((e) => e.kind === "friend.request_received")?.trace_id, trace);
});

test("doctor recentTraces: newest-per-trace, distinct, capped, direction inferred", async () => {
  const root = await tempRoot();
  const { alice, bob, bobCard } = await pair(root);
  const envelope = await alice.createFriendRequest(bobCard);
  await bob.receiveEnvelope(envelope);
  const traces = recentTraces(await readEvents(bob));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].trace_id, envelope.trace_id);
  assert.equal(traces[0].direction, "in");
  assert.equal(traces[0].kind, "friend.request_received");

  // Synthetic: cap + distinctness + out-direction.
  const synthetic = Array.from({ length: 15 }, (_, i) => ({
    ts: new Date(2026, 0, i + 1).toISOString(),
    kind: "envelope.sent",
    trace_id: `trace_${i}`,
  }));
  const capped = recentTraces([...synthetic, ...synthetic]);
  assert.equal(capped.length, 10);
  assert.equal(capped[9].trace_id, "trace_14", "newest last");
  assert.equal(capped[0].direction, "out");
});
