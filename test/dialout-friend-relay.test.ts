import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-dialout-fr-"));
}

// FakeSocket acks hello + mailbox_send so the relay's sendEnvelope resolves.
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1500) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// End-to-end of the host→agent→relay seam: a POST /api/friend/request arriving
// over the channel makes the agent issue a friend request AND relay it back via
// the existing maybeRelayResponseEnvelope path (no friend-specific relay code).
test("POST /api/friend/request over the dial-out channel auto-relays the friend_request", async () => {
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.local", ownerLabel: "Alice" });
  const aliceCard = await alice.writeCard();
  const aliceId = aliceCard.agent_id;
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(aliceCard), "utf8").toString("base64url")}`;

  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob" });

  let socket: FakeSocket | undefined;
  const client = new EdgeBookDialoutClient({
    home: bob.home,
    host: "ws://host.test/agent",
    socketFactory: (() => { socket = new FakeSocket(); queueMicrotask(() => socket!.emit("open")); return socket!; }) as never,
    heartbeatMs: 10_000,
  });
  await client.start();
  try {
    socket!.receive({
      type: "api_request",
      request_id: "fr",
      method: "POST",
      path: "/api/friend/request",
      body_b64: Buffer.from(JSON.stringify({ invite }), "utf8").toString("base64"),
    });

    await waitFor(() => socket!.sent.some((f) => f.type === "mailbox_send"));
    const relay = socket!.sent.find((f) => f.type === "mailbox_send") as { to: string; blob_b64: string };
    assert.equal(relay.to, aliceId, "friend request routes to the target agent");
    const routed = JSON.parse(Buffer.from(relay.blob_b64, "base64").toString("utf8")) as MessageEnvelope;
    assert.equal(routed.type, "friend_request");
    assert.equal(routed.to_agent_id, aliceId);
  } finally {
    await client.stop();
  }
});
