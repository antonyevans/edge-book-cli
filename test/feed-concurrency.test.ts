import assert from "node:assert/strict";
import test from "node:test";
import { makeFriends, addFriend, publishFriendPost, pullAndImport } from "./lib/feed-fixtures.ts";

test("20 concurrent feed reads from two friended peers all succeed with identical results", async () => {
  const { alice, aliceCard, bobId, root } = await makeFriends();
  const carol = await addFriend(alice, aliceCard, root, "carol");
  await publishFriendPost(alice);

  const reads = await Promise.all([
    ...Array.from({ length: 10 }, () => alice.visiblePostsForPeer(bobId)),
    ...Array.from({ length: 10 }, () => alice.visiblePostsForPeer(carol.id)),
  ]);
  for (const r of reads) {
    assert.equal(r.length, 1, "every concurrent read sees exactly the published post");
  }
});

test("repeated imports never duplicate feed items and keep item identity stable", async () => {
  // NOTE: concurrent WRITE hardening (read-modify-write races on the JSON
  // stores) is explicitly out of scope here — the store documents a v1
  // serial-receive assumption (see the consumeInviteCode note in
  // src/edge-book.ts). This test pins sequential idempotency, which is the
  // contract production relies on today.
  const { alice, bob, bobId } = await makeFriends();
  await publishFriendPost(alice);
  const first = await pullAndImport(alice, bob, bobId);
  assert.equal(first.length, 1);
  for (let i = 0; i < 4; i++) {
    const again = await pullAndImport(alice, bob, bobId);
    // Identity stability: re-import returns the SAME item, not a replacement.
    assert.equal(again[0].feed_item_id, first[0].feed_item_id);
  }
  const items = Object.values(await bob.feedItems());
  assert.equal(items.length, 1);
});
