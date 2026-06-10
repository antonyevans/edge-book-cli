import assert from "node:assert/strict";
import test from "node:test";
import { makeFriends, publishFriendPost, pullAndImport } from "./lib/feed-fixtures.ts";

test("editing a friends post to private removes it from the peer-visible feed", async () => {
  const { alice, bobId } = await makeFriends();
  const post = await publishFriendPost(alice);
  assert.equal((await alice.visiblePostsForPeer(bobId)).length, 1);
  await alice.editPost(post.post_id, { visibility: "private" });
  assert.equal((await alice.visiblePostsForPeer(bobId)).length, 0);
});

test("editing a private post to friends makes it peer-visible", async () => {
  const { alice, bobId } = await makeFriends();
  const post = await alice.createPost({ title: "Was private", body: "b", status: "published", visibility: "private" });
  assert.equal((await alice.visiblePostsForPeer(bobId)).length, 0);
  await alice.editPost(post.post_id, { visibility: "friends" });
  const visible = await alice.visiblePostsForPeer(bobId);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].post_id, post.post_id);
});

test("a peer's already-imported copy survives the author going private (no retraction — documented)", async () => {
  // There is no retraction mechanism: going private stops future pulls but
  // does not remove copies a peer already imported. Documented product
  // behavior — a retraction envelope would be its own spec (see plan Phase 3).
  const { alice, bob, bobId } = await makeFriends();
  const post = await publishFriendPost(alice);
  await pullAndImport(alice, bob, bobId);
  await alice.editPost(post.post_id, { visibility: "private" });
  assert.equal(Object.values(await bob.feedItems()).length, 1);
});
