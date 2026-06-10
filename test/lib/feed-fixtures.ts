// test/lib/feed-fixtures.ts
// Shared fixtures for feed-flow tests. Mirrors the befriend pattern used in
// backend-objects.test.ts and grant-access.test.ts so every feed test starts
// from the same known-good friendship + grant state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore } from "../../src/edge-book.ts";
import type { AgentCard } from "../../src/edge-book.ts";
import type { EdgeBookPost, FeedItem } from "../../src/types.ts";

export async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-feed-test-"));
}

export interface FriendPair {
  alice: EdgeBookStore;
  bob: EdgeBookStore;
  aliceId: string;
  bobId: string;
  aliceCard: AgentCard;
  bobCard: AgentCard;
  root: string;
}

// Two agents, mutual friends. By default alice issues bob a feed.read.friends
// grant (the post-accept production state). Pass { grantFeed: false } to test
// the friend-without-grant seam.
export async function makeFriends(opts: { root?: string; grantFeed?: boolean } = {}): Promise<FriendPair> {
  const root = opts.root ?? (await tempRoot());
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const aliceIdentity = await alice.init({ handle: "alice.openclaw.local", ownerLabel: "Alice" });
  const bobIdentity = await bob.init({ handle: "bob.openclaw.local", ownerLabel: "Bob" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  if (opts.grantFeed !== false) {
    await alice.issueGrant(bobIdentity.agent_id, ["feed.read.friends"]);
  }
  return {
    alice, bob,
    aliceId: aliceIdentity.agent_id,
    bobId: bobIdentity.agent_id,
    aliceCard, bobCard, root,
  };
}

// Add a third agent friended to `host`, with a feed grant from host.
export async function addFriend(
  host: EdgeBookStore,
  hostCard: AgentCard,
  root: string,
  name: string
): Promise<{ store: EdgeBookStore; card: AgentCard; id: string }> {
  const store = new EdgeBookStore({ home: path.join(root, name) });
  const identity = await store.init({ handle: `${name}.openclaw.local`, ownerLabel: name });
  const card = await store.writeCard();
  await store.receiveFriendRequest(await host.createFriendRequest(card));
  await host.applyFriendResponse(await store.acceptFriend(hostCard.agent_id));
  await host.issueGrant(identity.agent_id, ["feed.read.friends"]);
  return { store, card, id: identity.agent_id };
}

export async function publishFriendPost(
  author: EdgeBookStore,
  title = "Friend update",
  body = "visible"
): Promise<EdgeBookPost> {
  return author.createPost({ title, body, status: "published", visibility: "friends" });
}

// The production retrieve seam: reader pulls author's friend-visible posts and
// imports them into the reader's local feed.
export async function pullAndImport(
  author: EdgeBookStore,
  reader: EdgeBookStore,
  readerId: string
): Promise<FeedItem[]> {
  const visible = await author.visiblePostsForPeer(readerId);
  const authorId = (await author.identity()).agent_id;
  return reader.importFeedPosts(authorId, visible, "direct");
}
