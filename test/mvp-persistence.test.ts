import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";

// ea-claude-044 — persistence audit. The agent's social graph (identity,
// contacts/friends, grants, objects, posts, audit) is file-based JSON under the
// home dir. This proves it survives a process restart: build a full graph, then
// open a FRESH store on the same home (= a restart) and assert nothing is lost.

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-persist-"));
}

test("the social graph survives a restart (fresh store on the same home)", async () => {
  const root = await tempRoot();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");

  // Build a full graph across two agents.
  {
    const alice = new EdgeBookStore({ home: aliceHome });
    const bob = new EdgeBookStore({ home: bobHome });
    const aliceId = (await alice.init({ handle: "alice.local", ownerLabel: "Alice" })).agent_id;
    const bobId = (await bob.init({ handle: "bob.local", ownerLabel: "Bob" })).agent_id;
    const aliceCard = await alice.writeCard();
    const bobCard = await bob.writeCard();
    await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
    await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
    // A post and a shared object + grant.
    await alice.createPost({ title: "Draft note", body: "remember this" });
    const obj = await alice.createObject({ title: "Review the contract", body: "two clauses" });
    await bob.receiveObjectShare(await alice.shareObjectEnvelope(bobId, obj.object_id));
    // sanity within the same process
    assert.equal((await alice.contacts())[bobId].relationship_state, "friend");
    assert.equal(await bob.canReadObject(obj.object_id, bobId), true);
  }

  // ── "Restart": brand-new store instances reading the same home dirs ──
  const alice2 = new EdgeBookStore({ home: aliceHome });
  const bob2 = new EdgeBookStore({ home: bobHome });

  const aliceId = (await alice2.identity()).agent_id;
  const bobId = (await bob2.identity()).agent_id;

  // Identity survives (and the private key — so the agent is still itself).
  assert.ok(aliceId.startsWith("did:openclaw:"), "Alice identity persisted");
  assert.ok((await alice2.identity()).private_key_pem.includes("PRIVATE KEY"), "private key persisted");

  // Friendship survives on BOTH sides.
  assert.equal((await alice2.contacts())[bobId].relationship_state, "friend", "Alice still sees Bob as friend");
  assert.equal((await bob2.contacts())[aliceId].relationship_state, "friend", "Bob still sees Alice as friend");

  // Posts survive.
  assert.equal(Object.values(await alice2.posts()).length, 1, "Alice's post persisted");

  // Objects + grants survive, and Bob can still read the shared object.
  const objId = Object.keys(await bob2.objects())[0]!;
  assert.ok(objId, "shared object persisted on Bob's side");
  assert.equal(await bob2.canReadObject(objId, bobId), true, "grant persisted → Bob can still read");

  // Audit trail survives.
  assert.ok((await alice2.auditEvents()).length > 0, "Alice's audit log persisted");
  assert.ok((await bob2.auditEvents()).some((e) => e.action === "object.receive"), "Bob's audit persisted");
});

test("revocation persists across a restart (forward-looking denial is durable)", async () => {
  const root = await tempRoot();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: aliceHome });
  const bob = new EdgeBookStore({ home: bobHome });
  await alice.init({ handle: "a" });
  const bobId = (await bob.init({ handle: "b" })).agent_id;
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const obj = await alice.createObject({ title: "x", body: "y" });
  await bob.receiveObjectShare(await alice.shareObjectEnvelope(bobId, obj.object_id));
  await bob.receiveObjectRevoke(await alice.revokeObjectEnvelope(bobId, obj.object_id));
  assert.equal(await bob.canReadObject(obj.object_id, bobId), false, "denied after revoke");

  // Restart: the revoke must stick (not silently re-grant access).
  const bob2 = new EdgeBookStore({ home: bobHome });
  assert.equal(await bob2.canReadObject(obj.object_id, bobId), false, "still denied after restart");
});
