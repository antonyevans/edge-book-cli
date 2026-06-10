import assert from "node:assert/strict";
import test from "node:test";
import { EdgeBookError } from "../src/edge-book.ts";
import { makeFriends, publishFriendPost, pullAndImport } from "./lib/feed-fixtures.ts";

test("after alice revokes bob, his feed pull is denied but his imported copies persist", async () => {
  const { alice, bob, bobId } = await makeFriends();
  await publishFriendPost(alice);
  const imported = await pullAndImport(alice, bob, bobId);
  assert.equal(imported.length, 1);

  await alice.revoke(bobId);

  // revoke() flips relationship_state to "revoked", so the gate in
  // visiblePostsForPeer hits the not_friend branch before it reaches the
  // grant check. (Blocked peers hit their own earlier guard with code "blocked".)
  await assert.rejects(
    () => alice.visiblePostsForPeer(bobId),
    (e: unknown) => e instanceof EdgeBookError && e.code === "not_friend"
  );

  // The grant half of the cascade: revoke must also kill the grants, not just
  // flip relationship_state (the not_friend guard shadows the grant check above).
  const grants = Object.values(await alice.grants());
  assert.ok(grants.length >= 1, "at least one grant exists to assert against");
  assert.ok(grants.every((g) => g.status === "revoked"), "all of alice's grants revoked");

  // Graceful degrade: bob's already-imported items remain in HIS local feed —
  // revocation stops future pulls, it does not reach into a peer's store.
  const items = Object.values(await bob.feedItems());
  assert.equal(items.length, 1);
  assert.equal(items[0].post_id, imported[0].post_id);
});
