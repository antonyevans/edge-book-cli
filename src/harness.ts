// Self-contained two-agent smoke harnesses (`edge-book harness two-agent`).
// These exercise the full friend/grant/message/object/feed surface against two
// throwaway on-disk agents; test/edge-book.test.ts asserts they stay green AND
// that they detect breakage (no rubber-stamping).
import path from "node:path";
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { MessageEnvelope } from "./types.ts";
import fs from "node:fs/promises";
import os from "node:os";

export async function runTwoAgentHarness(baseDir?: string): Promise<Record<string, unknown>> {
  const root = baseDir || await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent", ownerLabel: "Alice" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent", ownerLabel: "Bob" });
  await alice.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.setProfile({ name: "Bob", bio: "Bob bio" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();

  const request = await alice.createFriendRequest(bobCard, "test harness request");

  let deniedBeforeAccept = false;
  try {
    await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "too soon" });
  } catch (error) {
    deniedBeforeAccept = (error as EdgeBookError).code === "not_friend";
  }

  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const aliceFollowUp = await alice.applyFriendResponse(accept);
  if (aliceFollowUp) await bob.receiveProfileShare(aliceFollowUp);
  const message = await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "hello Bob" });
  await bob.receivePrivilegedMessage(message);

  let replayDenied = false;
  try {
    await bob.receivePrivilegedMessage(message);
  } catch (error) {
    replayDenied = (error as EdgeBookError).code === "replay";
  }

  await bob.revoke(aliceCard.agent_id);
  let revokedDenied = false;
  try {
    await bob.receivePrivilegedMessage(await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "after revoke" }));
  } catch (error) {
    revokedDenied = ["not_friend", "replay", "missing_grant"].includes((error as EdgeBookError).code);
  }

  await bob.setRelationship(aliceCard.agent_id, "friend", "Accept", "reset for block test");
  await bob.block(aliceCard.agent_id);
  let blockedDenied = false;
  try {
    await bob.receivePrivilegedMessage(await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "after block" }));
  } catch (error) {
    blockedDenied = (error as EdgeBookError).code === "not_friend";
  }

  const rotatedBobCard = await bob.writeCard();
  await alice.upsertContactFromCard(rotatedBobCard);
  const aliceContacts = await alice.contacts();
  const bobAudit = await bob.auditEvents();

  // Both contacts were created earlier in this scenario — present by construction.
  const aliceSeesBob = (await alice.contacts())[bobCard.agent_id]!.friend_profile?.name === "Bob";
  const bobSeesAlice = (await bob.contacts())[aliceCard.agent_id]!.friend_profile?.name === "Alice";

  const assertions = {
    deniedBeforeAccept,
    replayDenied,
    revokedDenied,
    blockedDenied,
    aliceHasBobContact: Boolean(aliceContacts[bobCard.agent_id]),
    bobAuditWritten: bobAudit.length > 0,
    profileExchange: aliceSeesBob && bobSeesAlice,
  };
  const passed = Object.values(assertions).every(Boolean);
  if (!passed) throw new EdgeBookError("harness_failed", `Harness failed: ${JSON.stringify(assertions)}`);
  return { passed, root, assertions };
}

export async function runFeedPrivacyHarness(baseDir?: string): Promise<Record<string, unknown>> {
  const root = baseDir || await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-feed-privacy-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const charlie = new EdgeBookStore({ home: path.join(root, "charlie") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent", ownerLabel: "Alice" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent", ownerLabel: "Bob" });
  await charlie.init({ handle: "charlie.openclaw.local", displayName: "Charlie Agent", ownerLabel: "Charlie" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const charlieCard = await charlie.writeCard();

  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard, "feed privacy harness"));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  await alice.issueGrant(bobCard.agent_id, ["feed.read.friends"]);

  await alice.upsertContactFromCard(charlieCard, "none");
  const friendPost = await alice.createPost({
    kind: "working_on",
    title: "Friend visible update",
    body: "Only accepted friends with feed grants should see this.",
    visibility: "friends",
    status: "published"
  });

  const allowedPosts = await alice.visiblePostsForPeer(bobCard.agent_id);
  const bobImported = await bob.importFeedPosts(aliceCard.agent_id, allowedPosts, "local");
  const friendAllowed = allowedPosts.some((post) => post.post_id === friendPost.post_id) && bobImported.some((item) => item.post_id === friendPost.post_id);

  let nonFriendDenied = false;
  let nonFriendCode = "";
  try {
    await alice.visiblePostsForPeer(charlieCard.agent_id);
  } catch (error) {
    nonFriendCode = (error as EdgeBookError).code;
    nonFriendDenied = nonFriendCode === "not_friend";
  }

  await alice.revoke(bobCard.agent_id);
  let revokedFeedDenied = false;
  let revokedFeedCode = "";
  try {
    await alice.visiblePostsForPeer(bobCard.agent_id);
  } catch (error) {
    revokedFeedCode = (error as EdgeBookError).code;
    revokedFeedDenied = revokedFeedCode === "not_friend";
  }

  await alice.setRelationship(bobCard.agent_id, "friend", "Accept", "reset for block test");
  await alice.issueGrant(bobCard.agent_id, ["feed.read.friends"]);
  await alice.block(bobCard.agent_id);
  let blockedFeedDenied = false;
  let blockedFeedCode = "";
  try {
    await alice.visiblePostsForPeer(bobCard.agent_id);
  } catch (error) {
    blockedFeedCode = (error as EdgeBookError).code;
    blockedFeedDenied = blockedFeedCode === "blocked" || blockedFeedCode === "not_friend";
  }

  let blockedMessageDenied = false;
  let blockedMessageCode = "";
  try {
    await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "blocked message" });
  } catch (error) {
    blockedMessageCode = (error as EdgeBookError).code;
    blockedMessageDenied = blockedMessageCode === "blocked" || blockedMessageCode === "not_friend";
  }

  let blockedRequestDenied = false;
  let blockedRequestCode = "";
  try {
    await alice.createFriendRequest(bobCard, "blocked request");
  } catch (error) {
    blockedRequestCode = (error as EdgeBookError).code;
    blockedRequestDenied = blockedRequestCode === "blocked_peer";
  }

  let blockedRefreshDenied = false;
  let blockedRefreshCode = "";
  try {
    await alice.upsertContactFromCard(bobCard);
  } catch (error) {
    blockedRefreshCode = (error as EdgeBookError).code;
    blockedRefreshDenied = blockedRefreshCode === "blocked_peer";
  }

  const assertions = {
    friendAllowed,
    nonFriendDenied,
    revokedFeedDenied,
    blockedFeedDenied,
    blockedMessageDenied,
    blockedRequestDenied,
    blockedRefreshDenied
  };
  const passed = Object.values(assertions).every(Boolean);
  const denial_codes = {
    nonFriend: nonFriendCode,
    revokedFeed: revokedFeedCode,
    blockedFeed: blockedFeedCode,
    blockedMessage: blockedMessageCode,
    blockedRequest: blockedRequestCode,
    blockedRefresh: blockedRefreshCode
  };
  if (!passed) throw new EdgeBookError("harness_failed", `Feed privacy harness failed: ${JSON.stringify({ assertions, denial_codes })}`);
  return {
    passed,
    root,
    posts_visible_to_bob: allowedPosts.map((post) => post.post_id),
    bob_feed_items: bobImported.map((item) => item.feed_item_id),
    denial_codes,
    assertions
  };
}
