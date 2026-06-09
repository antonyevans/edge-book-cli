import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-dialout-esc-"));
}

// FakeSocket that acks hello AND mailbox_send, so the relay's sendEnvelope resolves.
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
  addEventListener(event: string, handler: (event?: unknown) => void): void {
    (this.listeners[event] ||= []).push(handler);
  }
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

test("answering a remote escalation in the reader auto-relays the response over the dial-out channel", async () => {
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") }); // requester
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });     // answerer (dialed out)
  await alice.init({ handle: "alice.local", ownerLabel: "Alice H" });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob H" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const aliceId = aliceCard.agent_id;
  const bobId = bobCard.agent_id;

  // Alice raises an escalation to Bob's human; Bob receives it.
  const { escalation, envelope } = await alice.raiseEscalation({ kind: "input", subject: "Entity?", body: "for NDA", to: bobId });
  await bob.receiveEscalation(envelope!);

  // Bob is dialed out. His human answers in the reader (an api_request POST over the channel).
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
      request_id: "ans",
      method: "POST",
      path: `/api/escalations/${encodeURIComponent(escalation.escalation_id)}/answer`,
      body_b64: Buffer.from(JSON.stringify({ text: "Acme LLC" }), "utf8").toString("base64"),
    });

    // The client should both answer (api_response) AND relay a mailbox_send.
    await waitFor(() => socket!.sent.some((f) => f.type === "mailbox_send"));
    const relay = socket!.sent.find((f) => f.type === "mailbox_send") as { to: string; blob_b64: string };
    assert.equal(relay.to, aliceId, "response routes back to the requesting agent");
    const routed = JSON.parse(Buffer.from(relay.blob_b64, "base64").toString("utf8")) as MessageEnvelope;
    assert.equal(routed.type, "escalation_response");
    assert.equal(routed.to_agent_id, aliceId);

    // Alice can apply it.
    await alice.applyEscalationResponse(routed);
    assert.equal((await alice.escalations())[escalation.escalation_id].status, "answered");
    assert.equal((await alice.escalations())[escalation.escalation_id].answer_text, "Acme LLC");
  } finally {
    await client.stop();
  }
});
