import assert from "node:assert/strict";
import test from "node:test";
import { EdgeBookError, EdgeBookStore } from "../src/edge-book.ts";
import { makeFriends, tempRoot } from "./lib/feed-fixtures.ts";

test("web sessions can be required and revoked", async () => {
  const store = new EdgeBookStore({ home: await tempRoot() });
  const identity = await store.init({ handle: "session.openclaw.local" });
  const session = await store.createSession({ authMethod: "dev-bypass" });

  const required = await store.requireSession(session.session_id);
  assert.equal(required.owner_agent_id, identity.agent_id);
  assert.equal(required.auth_method, "dev-bypass");

  await store.revokeSession(session.session_id);
  await assert.rejects(
    () => store.requireSession(session.session_id),
    (error) => error instanceof EdgeBookError && error.code === "unauthorized"
  );
});

test("post lifecycle creates approvals, publishes, edits, removes, and expires", async () => {
  const store = new EdgeBookStore({ home: await tempRoot() });
  await store.init({ handle: "posts.openclaw.local", ownerLabel: "Owner" });

  const draft = await store.createPost({ title: "Draft", body: "draft body" });
  assert.equal(draft.status, "draft");
  assert.equal(Object.keys(await store.feedItems()).length, 0);

  const pending = await store.createPost({
    title: "Agent update",
    body: "needs approval",
    visibility: "friends",
    sourceBasis: "agent-authored"
  });
  assert.equal(pending.status, "pending_approval");
  assert.ok(pending.approval_ref);
  assert.equal((await store.approvals())[pending.approval_ref].status, "pending");

  const published = await store.approvePost(pending.post_id);
  assert.equal(published.status, "published");
  assert.equal(published.source_basis, "human-approved");
  assert.equal((await store.approvals())[pending.approval_ref].status, "approved");
  assert.equal(Object.keys(await store.feedItems()).length, 1);

  await assert.rejects(
    () => store.resolveApproval(pending.approval_ref, false),
    (error) => error instanceof EdgeBookError && error.code === "approval_resolved"
  );

  const edited = await store.editPost(published.post_id, { title: "Edited update", tags: ["ops"] });
  assert.equal(edited.status, "edited");
  assert.equal(edited.title, "Edited update");
  assert.deepEqual(edited.tags, ["ops"]);

  const removed = await store.removePost(edited.post_id);
  assert.equal(removed.status, "removed");
  assert.ok(removed.audit_refs.length >= 4);
  await assert.rejects(
    () => store.editPost(removed.post_id, { body: "nope" }),
    (error) => error instanceof EdgeBookError && error.code === "removed_post"
  );

  const ephemeral = await store.createPost({ title: "Short lived", body: "expires", status: "published", visibility: "friends" });
  const expired = await store.expirePost(ephemeral.post_id);
  assert.equal(expired.status, "expired");
});

test("feed read, hide, and contact mute state do not mutate source posts", async () => {
  const root = await tempRoot();
  const { alice, bob, bobId } = await makeFriends({ root });
  const post = await alice.createPost({ title: "Friend update", body: "visible", status: "published", visibility: "friends" });
  const sourceBefore = (await alice.posts())[post.post_id];
  const visible = await alice.visiblePostsForPeer(bobId);
  const imported = await bob.importFeedPosts((await alice.identity()).agent_id, visible, "direct");

  const read = await bob.markFeedItemRead(imported[0].feed_item_id);
  assert.equal(read.read_state, "read");
  const hidden = await bob.hideFeedItem(imported[0].feed_item_id, "not relevant now");
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.muted_reason, "not relevant now");

  const mute = await bob.muteContact((await alice.identity()).agent_id, "quiet for now");
  assert.equal(mute.muted_reason, "quiet for now");
  assert.equal((await bob.contactMutes())[(await alice.identity()).agent_id].muted_reason, "quiet for now");

  assert.deepEqual((await alice.posts())[post.post_id], sourceBefore);
});

test("export includes backend objects and import review is non-activating", async () => {
  const root = await tempRoot();
  const { alice, bob, bobId } = await makeFriends({ root });
  const session = await alice.createSession();
  const post = await alice.createPost({ title: "Exported", body: "body", visibility: "friends", status: "published" });
  const visible = await alice.visiblePostsForPeer(bobId);
  await bob.importFeedPosts((await alice.identity()).agent_id, visible);
  await bob.muteContact((await alice.identity()).agent_id, "review later");

  const exported = await alice.exportLocalData();
  assert.equal((exported.identity as { agent_id: string }).agent_id, (await alice.identity()).agent_id);
  assert.ok((exported.sessions as Record<string, unknown>)[session.session_id]);
  assert.ok((exported.posts as Record<string, unknown>)[post.post_id]);
  assert.ok(Array.isArray(exported.audit));

  const review = await bob.reviewLocalDataImport(await bob.exportLocalData());
  assert.equal(review.review_only, true);
  assert.equal(review.activates_remote_endpoints, false);
  assert.deepEqual(review.counts, {
    contacts: 1,
    grants: 1,
    sessions: 0,
    posts: 0,
    feed_items: 1,
    approvals: 1, // friend_accept approval created by receiveFriendRequest
    contact_mutes: 1,
    audit: (await bob.auditEvents()).length
  });
});
