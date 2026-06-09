import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody, type MessageEnvelope } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";
import { EdgeBookDialoutClient } from "../src/dialout.ts";

// FakeSocket that acks hello AND mailbox_send (copied from dialout-escalation-relay.test.ts)
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

function baseUrlOf(server: { address(): unknown }): string {
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: { close(cb: (e?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
}
async function loginTo(baseUrl: string): Promise<Record<string, string>> {
  const r = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth_method: "dev-bypass" }) });
  const b = await r.json() as { session_id: string; csrf_token: string };
  return { "x-openclaw-session": b.session_id, "x-openclaw-csrf": b.csrf_token };
}
async function postApi(store: EdgeBookStore, urlPath: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const server = await startEdgeBookServer({ home: store.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await loginTo(baseUrl);
    const r = await fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  } finally {
    await closeServer(server);
  }
}

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-appr-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("receiveFriendRequest creates a pending friend_accept approval", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const approvals = Object.values(await bob.approvals());
  const fa = approvals.find((a) => a.type === "friend_accept");
  assert.ok(fa, "expected a friend_accept approval");
  assert.equal(fa!.object_type, "contact");
  assert.equal(fa!.object_id, aliceCard.agent_id);
  assert.equal(fa!.status, "pending");
  assert.match(fa!.summary, /Alice Agent/);
});

test("rejectFriend sets rejected and returns a signed accepted:false response", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const envelope = await bob.rejectFriend(aliceCard.agent_id, "no thanks");
  const body = envelope.body as unknown as FriendResponseBody;
  assert.equal(body.accepted, false);
  assert.equal(envelope.type, "friend_response");
  assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "rejected");
  // Requester applies it and ends rejected, no follow-up.
  const followUp = await alice.applyFriendResponse(envelope);
  assert.equal(followUp, null);
  assert.equal((await alice.contacts())[(await bob.writeCard()).agent_id].relationship_state, "rejected");
});

test("resolving a friend_accept approval (approve) makes friends + returns response_envelope", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const approval = Object.values(await bob.approvals()).find((a) => a.type === "friend_accept")!;

  const { json } = await postApi(bob, `/api/approvals/${approval.approval_id}/resolve`, { approved: true });
  assert.equal((json.approval as { status: string }).status, "approved");
  assert.equal((json.response_envelope as { type: string }).type, "friend_response");
  assert.equal(((json.response_envelope as { body: { accepted: boolean } }).body).accepted, true);
  assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "friend");
});

test("duplicate friend requests from the same peer produce exactly one pending friend_accept approval", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const aliceId = aliceCard.agent_id;

  // First request: bob receives, creating a pending approval.
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const afterFirst = Object.values(await bob.approvals()).filter(
    (a) => a.type === "friend_accept" && a.status === "pending",
  );
  assert.equal(afterFirst.length, 1, "should have exactly 1 pending friend_accept after first request");

  // Simulate revoke + re-request: alice's contact is revoked, then a fresh inbound arrives.
  await bob.revoke(aliceId);
  // Upsert contact back to request_received (simulates the fresh inbound request arriving).
  await bob.upsertContactFromCard(aliceCard, "request_received");
  // Receive a second request envelope — fresh message_id, passes replay guard.
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));

  const afterSecond = Object.values(await bob.approvals()).filter(
    (a) => a.type === "friend_accept" && a.status === "pending" && a.object_id === aliceId,
  );
  assert.equal(afterSecond.length, 1, "should still have exactly 1 pending friend_accept after re-request (no duplicate)");
});

test("resolving a friend_accept approval (reject) returns accepted:false friend_response", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const approval = Object.values(await bob.approvals()).find((a) => a.type === "friend_accept")!;

  const { json } = await postApi(bob, `/api/approvals/${approval.approval_id}/resolve`, { approved: false });
  assert.equal((json.approval as { status: string }).status, "rejected");
  assert.equal((json.response_envelope as { type: string }).type, "friend_response");
  assert.equal(((json.response_envelope as { body: { accepted: boolean } }).body).accepted, false);
  assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "rejected");
});

test("approving a friend_accept in the reader auto-relays the friend_response over the dial-out channel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-appr-relay-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") }); // requester
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });     // reviewee (dialed out)
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const aliceId = aliceCard.agent_id;

  // Alice sends a friend request; Bob receives it (creates a friend_accept approval).
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const approval = Object.values(await bob.approvals()).find((a) => a.type === "friend_accept")!;

  // Bob is dialed out. His human approves in the reader (api_request POST over the channel).
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
      request_id: "frq",
      method: "POST",
      path: `/api/approvals/${encodeURIComponent(approval.approval_id)}/resolve`,
      body_b64: Buffer.from(JSON.stringify({ approved: true }), "utf8").toString("base64"),
    });

    // The client should both respond (api_response) AND relay a mailbox_send.
    await waitFor(() => socket!.sent.some((f) => f.type === "mailbox_send"));
    const relay = socket!.sent.find((f) => f.type === "mailbox_send") as { to: string; blob_b64: string };
    assert.equal(relay.to, aliceId, "friend_response routes back to the requesting agent");
    const routed = JSON.parse(Buffer.from(relay.blob_b64, "base64").toString("utf8")) as MessageEnvelope;
    assert.equal(routed.type, "friend_response");
    assert.equal(routed.to_agent_id, aliceId);

    // Alice can apply it and becomes friends.
    await alice.applyFriendResponse(routed);
    assert.equal((await alice.contacts())[bobCard.agent_id].relationship_state, "friend");
  } finally {
    await client.stop();
  }
});
