import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";

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
