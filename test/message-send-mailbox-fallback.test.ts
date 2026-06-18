/**
 * Regression: `edge-book message send --deliver` must fall back to the host
 * mailbox when the peer's card advertises only a `local` transport (no direct
 * or relay endpoint). Before the fix it threw "No direct or relay endpoint"
 * for every default peer, even though friend requests / objects / posts already
 * route over the mailbox. Run: node --test test/message-send-mailbox-fallback.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

// Minimal in-test stand-in for edge-book-host's mailbox: acks the sender's
// mailbox_send so deliverEnvelopeViaMailbox resolves. (Copied from
// mvp-mailbox.test.ts — the harness is not exported.)
class FakeMailboxHost {
  private channels = new Map<string, FakeSocket>();
  private queue: Array<{ id: string; to: string; from: string; blob_b64: string; ts: number }> = [];
  private seq = 0;

  attach(socket: FakeSocket, channelId: string, agentDid: string): void {
    this.channels.set(channelId, socket);
    if (agentDid) this.channels.set(agentDid, socket);
    socket.host = this;
  }

  onSend(from: string, frame: { request_id: string; to: string; blob_b64: string }): void {
    const id = `m${this.seq++}`;
    this.queue.push({ id, to: frame.to, from, blob_b64: frame.blob_b64, ts: Date.now() });
    this.channels.get(from)?.receive({ type: "mailbox_send_ok", request_id: frame.request_id, id });
  }

  onAck(id: string): void {
    this.queue = this.queue.filter((m) => m.id !== id);
  }
}

class FakeSocket {
  host?: FakeMailboxHost;
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
    if (frame.type === "mailbox_ack") this.host?.onAck(frame.id);
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (e?: unknown) => void): void { (this.listeners[event] ||= []).push(handler); }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

test("message send --deliver falls back to the host mailbox for a local-only peer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-msg-fallback-"));
  const host = new FakeMailboxHost();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const bobStore = new EdgeBookStore({ home: bobHome });
  await aliceStore.init({ handle: "alice.local", displayName: "Alice" });
  await bobStore.init({ handle: "bob.local", displayName: "Bob" });

  // Full friend handshake so Alice holds Bob's message.friend grant.
  const aliceCard = await aliceStore.writeCard();
  const bobCard = await bobStore.writeCard();
  await bobStore.receiveFriendRequest(await aliceStore.createFriendRequest(bobCard));
  await aliceStore.applyFriendResponse(await bobStore.acceptFriend(aliceCard.agent_id));
  const bobId = (await bobStore.identity()).agent_id;

  // Precondition: Bob's contact card advertises ONLY a local endpoint — the
  // exact case that used to throw "No direct or relay endpoint".
  const contacts = await aliceStore.contacts();
  const modes = contacts[bobId].known_endpoints.map((e) => e.mode);
  assert.deepEqual(modes, ["local"], "precondition: peer is local-only");

  const factory = (_url: string) => {
    const s = new FakeSocket();
    s.host = host;
    queueMicrotask(() => s.emit("open"));
    return s;
  };

  const result = await handleCli(
    ["message", "send", bobId, "--body", "ping", "--deliver", "--home", aliceHome, "--host", "ws://fake"],
    { socketFactory: factory },
  );

  // Must NOT throw, and must report mailbox delivery (host-assigned id).
  assert.match(result.text, /over the mailbox/i, "fell back to the mailbox path");
  assert.match(result.text, /host id/i, "host assigned a message id");
  assert.equal((result.json as { type?: string }).type, "privileged_message");
});
