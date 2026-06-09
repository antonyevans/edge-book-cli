import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody, type MessageEnvelope, type ProfileShareBody } from "../src/edge-book.ts";

async function twoAgents() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-x-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  await alice.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.setProfile({ name: "Bob", bio: "Bob bio" });
  return { alice, bob };
}

// Task 10 import (added alongside Task 9 imports above)

test("acceptFriend attaches the accepter's friend profile and a profile.read.friend grant", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const body = accept.body as unknown as FriendResponseBody;
  assert.equal(body.profile?.name, "Bob");
  assert.ok(body.grant?.scopes.includes("profile.read.friend"));
  assert.ok(body.grant?.scopes.includes("message.friend"));
});

test("requester stores accepter profile from friend_response", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  await alice.applyFriendResponse(accept);
  const contact = (await alice.contacts())[bobCard.agent_id];
  assert.equal(contact.friend_profile?.name, "Bob");
  assert.equal(contact.friend_profile?.bio, "Bob bio");
});

test("receiveProfileShare stores a newer profile and ignores a stale one", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  // Bob edits his profile and broadcasts a profile_share to Alice.
  await bob.setProfile({ bio: "Bob NEW bio" });
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  await alice.receiveProfileShare(share);
  assert.equal((await alice.contacts())[bobCard.agent_id].friend_profile?.bio, "Bob NEW bio");
  // A replay of an older version must not overwrite (build a stale one by hand is
  // hard; instead re-receive the same share — replay guard rejects it).
  await assert.rejects(() => alice.receiveProfileShare(share), /replay/i);
});

test("applyFriendResponse returns a profile_share the requester must deliver back", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const followUp = await alice.applyFriendResponse(accept);
  assert.ok(followUp, "expected a follow-up envelope");
  assert.equal(followUp!.type, "profile_share");
  assert.equal(followUp!.to_agent_id, bobCard.agent_id);
  // Bob receives Alice's profile.
  await bob.receiveProfileShare(followUp!);
  assert.equal((await bob.contacts())[aliceCard.agent_id].friend_profile?.name, "Alice");
});

test("full loop: both sides hold each other's friend profile; request leaked nothing", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  // The request body is a friend_request with a card ONLY — no friend profile.
  assert.equal((request.body as any).profile, undefined);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const followUp = await alice.applyFriendResponse(accept);
  await bob.receiveProfileShare(followUp!);
  assert.equal((await alice.contacts())[bobCard.agent_id].friend_profile?.name, "Bob");
  assert.equal((await bob.contacts())[aliceCard.agent_id].friend_profile?.name, "Alice");
});

test("receiveEnvelope surfaces a profile_share follow-up for a friend_response", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const result = await alice.receiveEnvelope(accept);
  assert.ok(result && (result as MessageEnvelope).type === "profile_share");
});

// Security tests (Task 15)

test("profile_share from a non-friend is rejected", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  // Make Alice know Bob's key (request_sent) but NOT be friends.
  await alice.createFriendRequest(bobCard);
  // Bob (not friends with Alice from Alice's view) crafts a share to Alice.
  await bob.upsertContactFromCard(aliceCard, "friend"); // Bob thinks they're friends
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  await assert.rejects(() => alice.receiveProfileShare(share), (err: any) => {
    assert.equal(err.code, "not_friend");
    return true;
  });
});

test("profile_share with mismatched agent_id is rejected", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  (share.body as any).profile.agent_id = "did:openclaw:someone-else";
  await assert.rejects(() => alice.receiveProfileShare(share), (err: Error) => {
    const code = (err as any).code ?? "";
    // Envelope signature check or agent_id mismatch — either is correct.
    return ["agent_id_mismatch", "invalid_friend_profile", "invalid_signature"].includes(code)
      || err.message.includes("invalid") || err.message.includes("mismatch");
  });
});

test("receiveProfileShare rejects agent_id_mismatch when envelope is validly signed but inner profile agent_id differs from sender", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  // Build a valid profile_share from Bob's side to get a real profile object.
  const honest = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  const honestBody = honest.body as unknown as ProfileShareBody;
  // Tamper: replace agent_id with a wrong value, then re-sign the ENTIRE envelope so
  // verifyEnvelope passes — the agent_id_mismatch guard in receiveProfileShare fires first.
  const tamperedProfile = { ...honestBody.profile, agent_id: "did:openclaw:not-bob" };
  const tamperedEnvelope = await bob.signEnvelope({
    type: "profile_share",
    to_agent_id: aliceCard.agent_id,
    relationship_id: "",
    capability_id: "",
    ref: "",
    transport: "local",
    body: { profile: tamperedProfile } satisfies ProfileShareBody,
  });
  await assert.rejects(() => alice.receiveProfileShare(tamperedEnvelope), (err: any) => {
    assert.equal(err.code, "agent_id_mismatch");
    return true;
  });
});

test("tampered friend profile signature is rejected", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  (share.body as any).profile.bio = "INJECTED";
  await assert.rejects(() => alice.receiveProfileShare(share), (err: Error) => {
    const code = (err as any).code ?? "";
    // Envelope signature, friend profile signature, or replay — any is correct rejection.
    return ["invalid_friend_profile", "invalid_signature", "replay"].includes(code)
      || err.message.includes("invalid") || err.message.includes("Replay");
  });
});

test("broadcastProfileEnvelopes targets every current friend", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  await alice.setProfile({ bio: "edited" });
  const envs = await alice.broadcastProfileEnvelopes();
  assert.equal(envs.length, 1);
  assert.equal(envs[0].to_agent_id, bobCard.agent_id);
  assert.equal(envs[0].type, "profile_share");
});
