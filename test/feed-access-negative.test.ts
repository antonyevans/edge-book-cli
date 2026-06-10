import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EdgeBookError, EdgeBookStore } from "../src/edge-book.ts";
import { makeFriends, publishFriendPost, tempRoot } from "./lib/feed-fixtures.ts";

test("non-friend cannot read the friends-feed (unknown_contact)", async () => {
  // Carol is not in alice's contacts at all — visiblePostsForPeer throws
  // "unknown_contact" (not "not_friend") because the contact record doesn't
  // exist. The task spec called this "not_friend" but the actual production
  // code at store-posts.ts:244 uses "unknown_contact" for missing contacts.
  const { alice } = await makeFriends();
  const root = await tempRoot();
  const carol = new EdgeBookStore({ home: path.join(root, "carol") });
  const carolId = (await carol.init({ handle: "carol.openclaw.local" })).agent_id;
  await publishFriendPost(alice);
  await assert.rejects(
    () => alice.visiblePostsForPeer(carolId),
    (e) => e instanceof EdgeBookError && e.code === "unknown_contact"
  );
});

test("friend without a feed grant is denied (missing_grant)", async () => {
  const { alice, bobId } = await makeFriends({ grantFeed: false });
  await publishFriendPost(alice);
  await assert.rejects(
    () => alice.visiblePostsForPeer(bobId),
    (e) => e instanceof EdgeBookError && e.code === "missing_grant"
  );
});

test("posts published BEFORE friendship are visible after friending (documented behavior)", async () => {
  // Edge Book's friends-feed is the full friends-visible history, not a
  // from-this-point-forward stream. This test locks that product decision in;
  // if temporal scoping is ever wanted, change this test alongside a spec.
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobId = (await bob.init({ handle: "bob.openclaw.local" })).agent_id;
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await publishFriendPost(alice, "Pre-friendship post"); // published before the handshake
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  await alice.issueGrant(bobId, ["feed.read.friends"]);
  const visible = await alice.visiblePostsForPeer(bobId);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].title, "Pre-friendship post");
});
