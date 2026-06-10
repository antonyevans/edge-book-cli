import assert from "node:assert/strict";
import test from "node:test";
import { makeFriends } from "./lib/feed-fixtures.ts";

test("a 200-post feed pulls ordered newest-first and imports within budget", async () => {
  const { alice, bob, bobId } = await makeFriends();
  for (let i = 0; i < 200; i++) {
    await alice.createPost({ title: `Post ${i}`, body: `body ${i}`, status: "published", visibility: "friends" });
  }

  const started = Date.now();
  const visible = await alice.visiblePostsForPeer(bobId);
  assert.equal(visible.length, 200);
  // Newest-first ordering (>= because same-millisecond timestamps tie).
  for (let i = 1; i < visible.length; i++) {
    assert.ok(visible[i - 1].updated_at >= visible[i].updated_at, `ordering broke at index ${i}`);
  }

  const aliceId = (await alice.identity()).agent_id;
  const imported = await bob.importFeedPosts(aliceId, visible, "direct");
  assert.equal(imported.length, 200);

  // Re-import dedup at scale.
  await bob.importFeedPosts(aliceId, visible, "direct");
  assert.equal(Object.values(await bob.feedItems()).length, 200);

  // Generous budget: this is a regression tripwire, not a benchmark. The
  // store is read-modify-write JSON per post — O(n^2)-ish growth shows here.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `feed pull+import took ${elapsed}ms (budget 15s)`);
});
