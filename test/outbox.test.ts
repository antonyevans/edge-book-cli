import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OUTBOX_CAP, formatAge, readOutbox, recordOutboxEntry, staleQueueMs } from "../src/store-outbox.ts";

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-outbox-"));
}

// ── spec-097 C.1: outbox ledger ──────────────────────────────────────────────

test("recordOutboxEntry appends in order and readOutbox round-trips, including recipient_live", async () => {
  const home = await tempHome();
  await recordOutboxEntry(home, { id: "m0", to_agent_id: "did:openclaw:peer", envelope_type: "friend_request", recipient_live: false });
  await recordOutboxEntry(home, { id: "m1", to_agent_id: "did:openclaw:peer", envelope_type: "object_share", recipient_live: true });
  await recordOutboxEntry(home, { id: "m2", to_agent_id: "did:openclaw:peer", envelope_type: "object_share" }); // old host: no recipient_live
  const entries = await readOutbox(home);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.id, "m0");
  assert.equal(entries[0]!.recipient_live, false);
  assert.equal(entries[1]!.recipient_live, true);
  assert.ok(!("recipient_live" in entries[2]!), "absent field stays absent (old-host send)");
  assert.ok(entries[2]!.sent_at, "sent_at stamped");
  // outbox.json is a sibling of identity.json in the agent home.
  await fs.access(path.join(home, "outbox.json"));
});

test("outbox cap: the 201st entry evicts the oldest (drop-front)", async () => {
  const home = await tempHome();
  for (let i = 0; i <= OUTBOX_CAP; i++) {
    await recordOutboxEntry(home, { id: `m${i}`, to_agent_id: "did:openclaw:peer", envelope_type: "object_share" });
  }
  const entries = await readOutbox(home);
  assert.equal(entries.length, OUTBOX_CAP);
  assert.equal(entries[0]!.id, "m1", "m0 dropped from the front");
  assert.equal(entries[OUTBOX_CAP - 1]!.id, `m${OUTBOX_CAP}`);
});

test("staleQueueMs defaults to 10 minutes and honors EDGE_BOOK_STALE_QUEUE_MS", () => {
  const prev = process.env.EDGE_BOOK_STALE_QUEUE_MS;
  try {
    delete process.env.EDGE_BOOK_STALE_QUEUE_MS;
    assert.equal(staleQueueMs(), 10 * 60 * 1000);
    process.env.EDGE_BOOK_STALE_QUEUE_MS = "5000";
    assert.equal(staleQueueMs(), 5000);
    process.env.EDGE_BOOK_STALE_QUEUE_MS = "not-a-number";
    assert.equal(staleQueueMs(), 10 * 60 * 1000, "garbage falls back to the default");
  } finally {
    if (prev === undefined) delete process.env.EDGE_BOOK_STALE_QUEUE_MS;
    else process.env.EDGE_BOOK_STALE_QUEUE_MS = prev;
  }
});

test("formatAge renders seconds, minutes, hours, days", () => {
  assert.equal(formatAge(30_000), "30s");
  assert.equal(formatAge(5 * 60_000), "5m");
  assert.equal(formatAge(3 * 3_600_000), "3h");
  assert.equal(formatAge(2 * 86_400_000), "2d");
});

// ── spec-097 fakes: FakeMailboxHost/FakeSocket (mvp-mailbox.test.ts pattern)
// extended with recipient_live on send acks and the mailbox_status RPC pair.
// Modes: "receipts" (new host), "legacy-error" (old host — echoes the wire-
// protocol unknown-type error frame, the REAL deployed behavior: edge-book-host
// channels.ts always echoed ref), "legacy-silent" (lost frame — forces the
// client timeout path).
import { deliverEnvelopeViaMailbox, mailboxStatus } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

type FakeHostMode = "receipts" | "legacy-error" | "legacy-silent";

class FakeStatusHost {
  channels = new Map<string, FakeSocket>(); // by channel_id AND agent_did
  queue: Array<{ id: string; to: string; from: string; blob_b64: string; ts: number }> = [];
  statuses = new Map<string, { state: string; queued_ms?: number; recipient_live?: boolean }>();
  liveRecipients = new Set<string>();
  statusRequests = 0;
  private seq = 0;

  mode: FakeHostMode;

  constructor(mode: FakeHostMode = "receipts") { this.mode = mode; }

  attach(socket: FakeSocket, channelId: string, agentDid: string): void {
    this.channels.set(channelId, socket);
    if (agentDid) this.channels.set(agentDid, socket);
    socket.host = this;
    this.deliver(channelId);
    if (agentDid) this.deliver(agentDid);
  }

  onSend(from: string, frame: { request_id: string; to: string; blob_b64: string }): void {
    const id = `m${this.seq++}`;
    this.queue.push({ id, to: frame.to, from, blob_b64: frame.blob_b64, ts: Date.now() });
    const ok: Record<string, unknown> = { type: "mailbox_send_ok", request_id: frame.request_id, id };
    if (this.mode === "receipts") {
      ok.recipient_live = this.liveRecipients.has(frame.to) || this.channels.has(frame.to);
    }
    this.channels.get(from)?.receive(ok);
    this.deliver(frame.to);
  }

  onStatus(from: string, frame: { request_id: string; ids: string[] }): void {
    this.statusRequests++;
    const socket = this.channels.get(from);
    if (!socket) return;
    if (this.mode === "legacy-silent") return;
    if (this.mode === "legacy-error") {
      // What a pre-receipts edge-book-host actually sends for an unknown type.
      socket.receive({ type: "error", error: "unknown_message_type", ref: "mailbox_status" });
      return;
    }
    const statuses = frame.ids.map((id) => ({ id, ...(this.statuses.get(id) ?? { state: "unknown" }) }));
    socket.receive({ type: "mailbox_status_ok", request_id: frame.request_id, statuses });
  }

  onAck(id: string): void {
    this.queue = this.queue.filter((m) => m.id !== id);
  }

  private deliver(to: string): void {
    const socket = this.channels.get(to);
    if (!socket) return;
    for (const m of this.queue.filter((q) => q.to === to)) {
      socket.receive({ type: "mailbox_deliver", id: m.id, from: m.from, blob_b64: m.blob_b64, ts: m.ts });
    }
  }
}

class FakeSocket {
  host?: FakeStatusHost;
  fromDid = "";
  channelId = "";
  listeners: Record<string, Array<(e?: unknown) => void>> = {};
  readyState = 1;

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.type === "hello") {
      this.fromDid = frame.agent_did || "";
      this.channelId = `chan-${this.fromDid}`;
      queueMicrotask(() => {
        this.receive({ type: "hello_ok", channel_id: this.channelId, server_time: new Date().toISOString() });
        this.host?.attach(this, this.channelId, this.fromDid);
      });
    }
    if (frame.type === "mailbox_send") this.host?.onSend(this.channelId, frame);
    if (frame.type === "mailbox_status") this.host?.onStatus(this.channelId, frame);
    if (frame.type === "mailbox_ack") this.host?.onAck(frame.id);
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (e?: unknown) => void): void { (this.listeners[event] ||= []).push(handler); }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

function factoryFor(host: FakeStatusHost): (url: string) => FakeSocket {
  return (_url: string) => { const s = new FakeSocket(); s.host = host; queueMicrotask(() => s.emit("open")); return s; };
}

// Two friended agent homes wired to one fake host (mvp-mailbox.test.ts setup).
async function friendedPair(host: FakeStatusHost): Promise<{ root: string; aliceHome: string; bobHome: string; bobId: string; factory: (url: string) => FakeSocket }> {
  const root = await tempHome();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const bobStore = new EdgeBookStore({ home: bobHome });
  await aliceStore.init({ handle: "alice.local", displayName: "Alice", ownerLabel: "Alice" });
  await bobStore.init({ handle: "bob.local", displayName: "Bob", ownerLabel: "Bob" });
  const aliceCard = await aliceStore.writeCard();
  const bobCard = await bobStore.writeCard();
  await bobStore.receiveFriendRequest(await aliceStore.createFriendRequest(bobCard));
  await aliceStore.applyFriendResponse(await bobStore.acceptFriend(aliceCard.agent_id));
  const bobId = (await bobStore.identity()).agent_id;
  return { root, aliceHome, bobHome, bobId, factory: factoryFor(host) };
}

// ── spec-097 C.2: dialout client ─────────────────────────────────────────────

test("send ack surfaces recipient_live through deliverEnvelopeViaMailbox (false / true / absent)", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  // Recipient not connected and not in liveRecipients → false.
  const env1 = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack1 = await deliverEnvelopeViaMailbox({ home: aliceHome, host: "ws://fake", socketFactory: factory, envelope: env1 });
  assert.equal(ack1.recipient_live, false);

  // Host says the recipient is live → true.
  host.liveRecipients.add(bobId);
  const env2 = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack2 = await deliverEnvelopeViaMailbox({ home: aliceHome, host: "ws://fake", socketFactory: factory, envelope: env2 });
  assert.equal(ack2.recipient_live, true);

  // Old host omits the field → absent on the resolved ack.
  const legacyHost = new FakeStatusHost("legacy-error");
  const env3 = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack3 = await deliverEnvelopeViaMailbox({ home: aliceHome, host: "ws://fake", socketFactory: factoryFor(legacyHost), envelope: env3 });
  assert.ok(ack3.id);
  assert.ok(!("recipient_live" in ack3), "old host: recipient_live absent, not false");
});

test("mailboxStatusAndWait resolves statuses from mailbox_status_ok", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, factory } = await friendedPair(host);
  host.statuses.set("m0", { state: "queued", queued_ms: 1234, recipient_live: false });
  host.statuses.set("m1", { state: "acked" });
  const statuses = await mailboxStatus({ home: aliceHome, host: "ws://fake", socketFactory: factory, ids: ["m0", "m1", "m2"] });
  assert.ok(statuses, "receipts host answers");
  assert.deepEqual(statuses![0], { id: "m0", state: "queued", queued_ms: 1234, recipient_live: false });
  assert.deepEqual(statuses![1], { id: "m1", state: "acked" });
  assert.deepEqual(statuses![2], { id: "m2", state: "unknown" });
});

test("old-host error frame (ref=mailbox_status) resolves the pending RPC to null FAST — no timeout wait", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, factory } = await friendedPair(host);
  const started = Date.now();
  // Default timeout is 5s; the error-frame fast path must beat it by a mile.
  const statuses = await mailboxStatus({ home: aliceHome, host: "ws://fake", socketFactory: factory, ids: ["m0"] });
  assert.equal(statuses, null, "degrades to local-only");
  assert.ok(Date.now() - started < 2000, `resolved in ${Date.now() - started}ms — error frame fast path, not the 5s timeout`);
  assert.equal(host.statusRequests, 1, "exactly one mailbox_status was attempted");
});

test("lost-frame path: a silent host resolves to null after the RPC timeout", async () => {
  const host = new FakeStatusHost("legacy-silent");
  const { aliceHome, factory } = await friendedPair(host);
  const statuses = await mailboxStatus({ home: aliceHome, host: "ws://fake", socketFactory: factory, ids: ["m0"], timeoutMs: 100 });
  assert.equal(statuses, null, "timeout degrades to local-only, same as the error frame");
});

// ── spec-097 C.3: honest --deliver wording + ledger recording ────────────────

test("--deliver with recipient_live=false prints Queued/NOT connected, never Delivered, and records the ledger entry", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  const result = await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.match(result.text, /Queued/);
  assert.match(result.text, /NOT connected/);
  assert.match(result.text, /edge-book outbox/);
  assert.doesNotMatch(result.text, /Delivered/, "the word Delivered no longer appears at enqueue time");

  const entries = await readOutbox(aliceHome);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, "m0", "host-assigned id recorded");
  assert.equal(entries[0]!.envelope_type, "object_share");
  assert.equal(entries[0]!.to_agent_id, bobId);
  assert.equal(entries[0]!.recipient_live, false);
});

test("--deliver with recipient_live=true prints the Sent wording", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  host.liveRecipients.add(bobId);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  const result = await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.match(result.text, /Sent/);
  assert.match(result.text, /recipient's agent is connected/);
  const entries = await readOutbox(aliceHome);
  assert.equal(entries[0]!.recipient_live, true);
});

test("old-host send (no recipient_live) keeps the legacy wording and still records the entry", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  const result = await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.match(result.text, /Shared object .* over the mailbox \(host id m0\)/, "graceful degradation: current wording unchanged");
  const entries = await readOutbox(aliceHome);
  assert.equal(entries.length, 1);
  assert.ok(!("recipient_live" in entries[0]!));
});

test("friend request --deliver over the mailbox uses honest wording and records the entry", async () => {
  const host = new FakeStatusHost("receipts");
  const { bobHome, factory } = await friendedPair(host);
  // A fresh pair NOT yet friended for a clean friend_request; reuse bob's card file.
  const bobStore = new EdgeBookStore({ home: bobHome });
  const bobCard = await bobStore.writeCard();
  const root = await tempHome();
  const carolHome = path.join(root, "carol");
  const carolStore = new EdgeBookStore({ home: carolHome });
  await carolStore.init({ handle: "carol.local", ownerLabel: "Carol" });
  const cardPath = path.join(root, "bob-card.json");
  await fs.writeFile(cardPath, JSON.stringify(bobCard), "utf8");

  const result = await handleCli(["friend", "request", cardPath, "--deliver", "--host", "ws://fake"],
    { home: carolHome, socketFactory: factory });

  assert.match(result.text, /Queued|Sent/, "state-accurate wording on the friend path too");
  assert.doesNotMatch(result.text, /Delivered/);
  const entries = await readOutbox(carolHome);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.envelope_type, "friend_request");
});

test("profile broadcast --deliver records one outbox entry per friend (mailbox fallback appends, spec-097 §C.1)", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);

  const result = await handleCli(["profile", "broadcast", "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.equal(result.text, "Broadcast profile to 1 friend(s)", "aggregate output line unchanged");
  const entries = await readOutbox(aliceHome);
  assert.equal(entries.length, 1, "one ledger entry per friend delivered over the mailbox");
  assert.equal(entries[0]!.envelope_type, "profile_share");
  assert.equal(entries[0]!.to_agent_id, bobId);
  assert.equal(entries[0]!.recipient_live, false, "recipient_live captured per send");
});

// ── spec-097 C.3: the `edge-book outbox` command ─────────────────────────────

test("outbox prints per-entry state and a LOUD warning for stale-queued mail; --json round-trips", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  // Send one (records m0), then make the host report it stale-queued.
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });
  host.statuses.set("m0", { state: "queued", queued_ms: 11 * 60 * 1000, recipient_live: false });

  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.match(result.text, /object_share/);
  assert.match(result.text, /queued/);
  assert.match(result.text, /⚠ undelivered for /, "loud stale warning present");
  assert.match(result.text, /different identity; ask them for a fresh invite/, "the June 9 diagnosis, automated");

  const jsonResult = await handleCli(["outbox", "--json", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  const parsed = JSON.parse(jsonResult.text) as { entries: Array<{ id: string; state: string; stale: boolean; queued_ms?: number }> };
  assert.equal(parsed.entries[0]!.id, "m0");
  assert.equal(parsed.entries[0]!.state, "queued");
  assert.equal(parsed.entries[0]!.stale, true);
  assert.equal(parsed.entries[0]!.queued_ms, 11 * 60 * 1000);
});

test("outbox warns when recipient_live=false even under the stale-time threshold", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });
  host.statuses.set("m0", { state: "queued", queued_ms: 5_000, recipient_live: false });

  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.match(result.text, /⚠ undelivered/, "recipient_live=false alone triggers the warning");
});

test("outbox shows contact display names where known and acked state for delivered mail", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });
  host.statuses.set("m0", { state: "acked" });

  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.match(result.text, /acked/);
  const contacts = await aliceStore.contacts();
  const display = contacts[bobId]?.display_name;
  assert.ok(display, "test pair has a contact display name");
  assert.ok(result.text.includes(display!), "recipient shown by display name, not bare DID");
  assert.doesNotMatch(result.text, /⚠/, "acked mail never warns");
});

test("outbox with an empty ledger says so and exits cleanly", async () => {
  const home = await tempHome();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "lonely.local" });
  const result = await handleCli(["outbox", "--host", "ws://fake"], { home, socketFactory: factoryFor(new FakeStatusHost("receipts")) });
  assert.match(result.text, /Outbox is empty/);
});

// ── spec-097 §D: old-host degradation for the outbox command ─────────────────

test("outbox against an old host (error frame) prints local-only unknown states immediately, exit 0", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  const started = Date.now();
  // handleCli resolving (not throwing) IS exit 0 — runCli only sets exitCode on throw.
  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.ok(Date.now() - started < 2000, "error-frame fast path: no 5s timeout wait");
  assert.match(result.text, /unknown \(host does not support receipts\)/);
  assert.match(result.text, /object_share/, "local ledger entries still listed");
  assert.doesNotMatch(result.text, /⚠/, "no stale warning without host truth");
});

test("outbox --json against an old host marks every entry unknown-unsupported", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  const result = await handleCli(["outbox", "--json", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  const parsed = JSON.parse(result.text) as { entries: Array<{ state: string; stale: boolean }> };
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]!.state, "unknown (host does not support receipts)");
  assert.equal(parsed.entries[0]!.stale, false);
});

test("outbox against an unreachable host says 'could not reach the host', not 'does not support receipts', exit 0", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  // Record an entry while the host is up...
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  // ...then the host becomes unreachable: the socket factory itself fails.
  const failingFactory = (_url: string): FakeSocket => { throw new Error("connect ECONNREFUSED 127.0.0.1:443"); };
  // handleCli resolving (not throwing) IS exit 0 — runCli only sets exitCode on throw.
  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: failingFactory });
  assert.match(result.text, /unknown \(could not reach the host\)/);
  assert.doesNotMatch(result.text, /does not support receipts/, "unreachable ≠ old host");
  assert.match(result.text, /object_share/, "local ledger entries still listed");
  assert.doesNotMatch(result.text, /⚠/, "no stale warning without host truth");
});
