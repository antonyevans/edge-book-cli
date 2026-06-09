import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-abuse-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("reportPeer records evidence and can auto-block", async () => {
  const { alice, bob } = await pair();
  const aliceId = (await alice.identity()).agent_id;
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const rec = await bob.reportPeer(aliceId, "spam", { block: true });
  assert.equal(rec.peer_agent_id, aliceId);
  assert.equal(rec.reason, "spam");
  assert.equal(rec.blocked, true);
  assert.equal((await bob.reports()).length, 1);
  assert.equal((await bob.contacts())[aliceId].relationship_state, "blocked");
});

test("invite-only drops a cold unsolicited request; open (default) accepts it", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  // default open
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  assert.equal((await bob.pendingFriendRequests()).length, 1);
  // flip to invite-only
  const { alice: a2, bob: b2 } = await pair();
  const b2Card = await b2.writeCard();
  await b2.updateConfig({ open_friend_requests: false });
  const req = await a2.createFriendRequest(b2Card);
  await assert.rejects(
    () => b2.receiveFriendRequest(req),
    (e: unknown) => e instanceof EdgeBookError && e.code === "unsolicited_dropped",
  );
});

test("invite-only accepts a request carrying a valid minted invite code (single use)", async () => {
  const { alice, bob } = await pair();
  await bob.updateConfig({ open_friend_requests: false });
  const bobCard = await bob.writeCard();
  const invite = await bob.mintInviteCode({ maxUses: 1 });
  // Requester includes the code; createFriendRequest takes it as 3rd arg.
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard, "hi", invite.code)); // accepted
  assert.equal((await bob.pendingFriendRequests()).length, 1);
  // code is now consumed → a second cold request from a different peer is dropped
  const carolRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eb-carol-"));
  const carol = new EdgeBookStore({ home: path.join(carolRoot, "c") });
  await carol.init({ handle: "carol.openclaw.local", displayName: "Carol" });
  const carolReq = await carol.createFriendRequest(bobCard, "hi", invite.code);
  await assert.rejects(
    () => bob.receiveFriendRequest(carolReq),
    (e: unknown) => e instanceof EdgeBookError && e.code === "unsolicited_dropped",
  );
});

test("inbound friend_request throttle drops a per-peer flood with rate_limited", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  await bob.updateConfig({ inbound_max_per_peer: 2, inbound_window_ms: 3_600_000 });
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)); // 1
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)); // 2
  const req3 = await alice.createFriendRequest(bobCard); // 3 — pre-create
  await assert.rejects(
    () => bob.receiveFriendRequest(req3),
    (e: unknown) => e instanceof EdgeBookError && e.code === "rate_limited",
  );
});

// FIX 1: invite-only allow-set — rejected peer re-requesting is dropped
test("invite-only drops a re-request from a peer whose state is 'rejected'", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  // Bob is open by default — receive alice's initial request, then reject her.
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.rejectFriend((await alice.identity()).agent_id);
  // Now bob flips to invite-only.
  await bob.updateConfig({ open_friend_requests: false });
  // Alice tries again (no invite code). Her state is "rejected" → must NOT bypass.
  const req2 = await alice.createFriendRequest(bobCard);
  await assert.rejects(
    () => bob.receiveFriendRequest(req2),
    (e: unknown) => e instanceof EdgeBookError && e.code === "unsolicited_dropped",
  );
});

// FIX 1: invite-only allow-set — request_sent peer IS allowed (solicited reply)
test("invite-only allows a request from a peer we already reached out to (request_sent)", async () => {
  const { alice, bob } = await pair();
  // Bob reaches out to alice first → alice's state in bob's contacts becomes "request_sent".
  const aliceCard = await alice.writeCard();
  await bob.createFriendRequest(aliceCard); // sets alice → request_sent in bob's store
  // Bob then flips to invite-only.
  await bob.updateConfig({ open_friend_requests: false });
  // Now alice replies with her own friend request (no invite code). Bob set request_sent
  // first, so this is a solicited reply and must be allowed through.
  const bobCard = await bob.writeCard();
  await alice.receiveFriendRequest(await bob.createFriendRequest(aliceCard)); // alice sees bob's req
  // The key assertion: alice sends her request back to bob (invite-only) without a code.
  const aliceReply = await alice.createFriendRequest(bobCard);
  await assert.doesNotReject(() => bob.receiveFriendRequest(aliceReply));
  assert.equal((await bob.pendingFriendRequests()).length, 1);
});

// FIX 4: global cap — 3rd distinct peer is rate_limited when global cap is 2
test("global inbound cap drops requests beyond the configured inbound_max_global", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-gcap-"));
  const recipient = new EdgeBookStore({ home: path.join(root, "recipient") });
  await recipient.init({ handle: "recipient.openclaw.local", displayName: "Recipient" });
  await recipient.updateConfig({ inbound_max_global: 2, inbound_window_ms: 3_600_000 });
  const recipientCard = await recipient.writeCard();

  // Three distinct senders.
  const senders = await Promise.all(
    ["s1", "s2", "s3"].map(async (name) => {
      const s = new EdgeBookStore({ home: path.join(root, name) });
      await s.init({ handle: `${name}.openclaw.local`, displayName: name });
      return s;
    }),
  );
  // First two succeed.
  await recipient.receiveFriendRequest(await senders[0].createFriendRequest(recipientCard));
  await recipient.receiveFriendRequest(await senders[1].createFriendRequest(recipientCard));
  // Third (distinct peer) must hit the global cap.
  const req3 = await senders[2].createFriendRequest(recipientCard);
  await assert.rejects(
    () => recipient.receiveFriendRequest(req3),
    (e: unknown) => e instanceof EdgeBookError && e.code === "rate_limited",
  );
});

// FIX 4: expired invite code is not consumable — request is dropped
test("invite-only drops a request carrying an expired invite code", async () => {
  const { alice, bob } = await pair();
  await bob.updateConfig({ open_friend_requests: false });
  const bobCard = await bob.writeCard();
  // Mint a code that expires in 1 ms.
  const invite = await bob.mintInviteCode({ ttlMs: 1 });
  // Wait long enough for the code to expire.
  await new Promise((r) => setTimeout(r, 10));
  const req = await alice.createFriendRequest(bobCard, "hi", invite.code);
  await assert.rejects(
    () => bob.receiveFriendRequest(req),
    (e: unknown) => e instanceof EdgeBookError && e.code === "unsolicited_dropped",
  );
});
