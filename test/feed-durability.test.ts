import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeFriends, publishFriendPost, pullAndImport } from "./lib/feed-fixtures.ts";

test("read/hidden state survives a store reopen and a re-import", async () => {
  const { alice, bob, bobId, root } = await makeFriends();
  await publishFriendPost(alice);
  const imported = await pullAndImport(alice, bob, bobId);
  await bob.markFeedItemRead(imported[0].feed_item_id);
  await bob.hideFeedItem(imported[0].feed_item_id, "durability test");

  // Reopen: a brand-new store instance on the same home dir simulates a fresh
  // agent process reading state purely from disk.
  const bob2 = new EdgeBookStore({ home: path.join(root, "bob") });
  const items = Object.values(await bob2.feedItems());
  assert.equal(items.length, 1);
  assert.equal(items[0].read_state, "read");
  assert.equal(items[0].hidden, true);
  assert.equal(items[0].muted_reason, "durability test");

  // Re-pull + re-import on the reopened store: idempotent, engagement preserved.
  await pullAndImport(alice, bob2, bobId);
  const again = Object.values(await bob2.feedItems());
  assert.equal(again.length, 1);
  assert.equal(again[0].read_state, "read");
  assert.equal(again[0].hidden, true);
});
