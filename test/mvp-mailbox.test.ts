import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-mvp-mailbox-"));
}

// A tiny in-test stand-in for edge-book-host's mailbox: store-and-forward keyed
// by recipient (channel_id or DID), enqueue→deliver-on-connect→ack→delete. It
// connects two FakeSockets so a `mailbox_send` from A is delivered to B.
class FakeMailboxHost {
  private channels = new Map<string, FakeSocket>(); // by channel_id AND agent_did
  private queue: Array<{ id: string; to: string; from: string; blob_b64: string; ts: number }> = [];
  private seq = 0;

  attach(socket: FakeSocket, channelId: string, agentDid: string): void {
    this.channels.set(channelId, socket);
    if (agentDid) this.channels.set(agentDid, socket);
    socket.host = this;
    this.flush(channelId, agentDid);
  }

  onSend(from: string, frame: { request_id: string; to: string; blob_b64: string }): void {
    const id = `m${this.seq++}`;
    this.queue.push({ id, to: frame.to, from, blob_b64: frame.blob_b64, ts: Date.now() });
    // ack the sender
    this.channels.get(from)?.receive({ type: "mailbox_send_ok", request_id: frame.request_id, id });
    this.deliver(frame.to);
  }

  onAck(id: string): void {
    this.queue = this.queue.filter((m) => m.id !== id);
  }

  private flush(channelId: string, agentDid: string): void {
    this.deliver(channelId);
    if (agentDid) this.deliver(agentDid);
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

async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Two agents, each on a dial-out client wired to the shared fake host. Alice
// shares an object to Bob over the mailbox; Bob auto-applies and can read it.
test("object share is delivered over the mailbox transport and auto-applied", async () => {
  const root = await tempRoot();
  const host = new FakeMailboxHost();
  const aliceStore = new EdgeBookStore({ home: path.join(root, "alice") });
  const bobStore = new EdgeBookStore({ home: path.join(root, "bob") });
  await aliceStore.init({ handle: "alice.local", ownerLabel: "Alice" });
  await bobStore.init({ handle: "bob.local", ownerLabel: "Bob" });
  // Friend them first (object sharing requires friendship).
  const aliceCard = await aliceStore.writeCard();
  const bobCard = await bobStore.writeCard();
  await bobStore.receiveFriendRequest(await aliceStore.createFriendRequest(bobCard));
  await aliceStore.applyFriendResponse(await bobStore.acceptFriend(aliceCard.agent_id));
  const bobId = (await bobStore.identity()).agent_id;

  const factory = (_url: string) => { const s = new FakeSocket(); s.host = host; queueMicrotask(() => s.emit("open")); return s; };
  const alice = new EdgeBookDialoutClient({ home: aliceStore.home, host: "ws://fake", reconnect: false, openLocalApi: false, socketFactory: factory });
  const received: MessageEnvelope[] = [];
  const bob = new EdgeBookDialoutClient({
    home: bobStore.home, host: "ws://fake", reconnect: false, openLocalApi: false, socketFactory: factory,
    onEnvelope: (env, result) => { if (result.applied) received.push(env); }
  });
  await alice.start();
  await bob.start();
  await waitFor(() => Boolean((alice as unknown as { socket?: FakeSocket }).socket));

  // Alice creates + shares an object addressed to Bob's DID.
  const object = await aliceStore.createObject({ title: "Need a review", body: "Please look at this." });
  const shareEnv = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack = await alice.sendEnvelope(shareEnv);
  assert.ok(ack.id, "host assigned a message id");

  // Bob receives + auto-applies; he can now read the object.
  await waitFor(() => received.length === 1);
  assert.equal(received[0].type, "object_share");
  assert.equal(await bobStore.canReadObject(object.object_id, bobId), true);
  const read = await bobStore.readObject(object.object_id, bobId);
  assert.equal(read.request.title, "Need a review");

  await alice.stop();
  await bob.stop();
});

// Bob offline at share time → host queues → Bob connects → delivered (the
// keystone store-and-forward path, agent side).
test("queued share is delivered when the recipient connects later", async () => {
  const root = await tempRoot();
  const host = new FakeMailboxHost();
  const aliceStore = new EdgeBookStore({ home: path.join(root, "alice") });
  const bobStore = new EdgeBookStore({ home: path.join(root, "bob") });
  await aliceStore.init({ handle: "alice.local" });
  await bobStore.init({ handle: "bob.local" });
  const aliceCard = await aliceStore.writeCard();
  const bobCard = await bobStore.writeCard();
  await bobStore.receiveFriendRequest(await aliceStore.createFriendRequest(bobCard));
  await aliceStore.applyFriendResponse(await bobStore.acceptFriend(aliceCard.agent_id));
  const bobId = (await bobStore.identity()).agent_id;

  const factory = (_url: string) => { const s = new FakeSocket(); s.host = host; queueMicrotask(() => s.emit("open")); return s; };
  const alice = new EdgeBookDialoutClient({ home: aliceStore.home, host: "ws://fake", reconnect: false, openLocalApi: false, socketFactory: factory });
  await alice.start();

  // Alice shares while Bob is OFFLINE — queued on the host.
  const object = await aliceStore.createObject({ title: "Offline test", body: "for later" });
  await alice.sendEnvelope(await aliceStore.shareObjectEnvelope(bobId, object.object_id));
  assert.equal(await bobStore.canReadObject(object.object_id, bobId), false, "not yet delivered");

  // Bob connects now → host flushes the queue → delivered + applied.
  const received: MessageEnvelope[] = [];
  const bob = new EdgeBookDialoutClient({
    home: bobStore.home, host: "ws://fake", reconnect: false, openLocalApi: false, socketFactory: factory,
    onEnvelope: (env, result) => { if (result.applied) received.push(env); }
  });
  await bob.start();
  await waitFor(() => received.length === 1);
  assert.equal(await bobStore.canReadObject(object.object_id, bobId), true);

  await alice.stop();
  await bob.stop();
});
