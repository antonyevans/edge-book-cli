// Owner posts, the local feed, human approval gates, and contact mutes.
//
// Extracted from EdgeBookStore (2026-06-09 legibility refactor); each function
// is called by a same-named one-line delegate method on EdgeBookStore.
// Invariants:
//   - agent-authored posts require a human ApprovalRequest before publishing
//     (status pending_approval -> published only via approvePost);
//   - visiblePostsForPeer is the feed privacy gate: friend-state + an active
//     feed.read.friends grant, fail closed (plan-031);
//   - feed items from muted contacts stay stored but are surfaced as hidden.
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { ApprovalRequest, ContactMute, EdgeBookPost, EdgeBookPostKind, EdgeBookPostStatus, EdgeBookVisibility, FeedItem } from "./types.ts";
import { now, randomId, readJson, writeJson } from "./fs-json.ts";
import { relationshipId } from "./crypto.ts";
import { APPROVALS_FILE, CONTACT_MUTES_FILE, FEED_FILE, POSTS_FILE } from "./store-files.ts";

export async function posts(store: EdgeBookStore): Promise<Record<string, EdgeBookPost>> {
  return readJson<Record<string, EdgeBookPost>>(store.file(POSTS_FILE), {});
}

export async function savePosts(store: EdgeBookStore, posts: Record<string, EdgeBookPost>): Promise<void> {
  await writeJson(store.file(POSTS_FILE), posts);
}

export async function feedItems(store: EdgeBookStore): Promise<Record<string, FeedItem>> {
  return readJson<Record<string, FeedItem>>(store.file(FEED_FILE), {});
}

export async function saveFeedItems(store: EdgeBookStore, items: Record<string, FeedItem>): Promise<void> {
  await writeJson(store.file(FEED_FILE), items);
}

export async function approvals(store: EdgeBookStore): Promise<Record<string, ApprovalRequest>> {
  return readJson<Record<string, ApprovalRequest>>(store.file(APPROVALS_FILE), {});
}

export async function saveApprovals(store: EdgeBookStore, approvals: Record<string, ApprovalRequest>): Promise<void> {
  await writeJson(store.file(APPROVALS_FILE), approvals);
}

export async function contactMutes(store: EdgeBookStore): Promise<Record<string, ContactMute>> {
  return readJson<Record<string, ContactMute>>(store.file(CONTACT_MUTES_FILE), {});
}

export async function saveContactMutes(store: EdgeBookStore, mutes: Record<string, ContactMute>): Promise<void> {
  await writeJson(store.file(CONTACT_MUTES_FILE), mutes);
}

export async function createApproval(store: EdgeBookStore, input: {
    type: ApprovalRequest["type"];
    objectType: ApprovalRequest["object_type"];
    objectId: string;
    summary: string;
    riskLevel?: ApprovalRequest["risk_level"];
    requestedByAgentId?: string;
  }): Promise<ApprovalRequest> {
  const identity = await store.identity();
  const approval: ApprovalRequest = {
    approval_id: randomId("approval"),
    type: input.type,
    requested_by_agent_id: input.requestedByAgentId || identity.agent_id,
    object_type: input.objectType,
    object_id: input.objectId,
    summary: input.summary,
    risk_level: input.riskLevel || "medium",
    status: "pending",
    created_at: now(),
    resolved_at: "",
    resolved_by: "",
    audit_refs: []
  };
  const approvals = await store.approvals();
  approvals[approval.approval_id] = approval;
  await store.saveApprovals(approvals);
  approval.audit_refs.push(await store.audit("approval.create", approval.requested_by_agent_id, { approval_id: approval.approval_id, type: approval.type }));
  approvals[approval.approval_id] = approval;
  await store.saveApprovals(approvals);
  return approval;
}

export async function resolveApproval(store: EdgeBookStore, approvalId: string, approved: boolean): Promise<ApprovalRequest> {
  const approvals = await store.approvals();
  const approval = approvals[approvalId];
  if (!approval) throw new EdgeBookError("unknown_approval", `Unknown approval: ${approvalId}`);
  if (approval.status !== "pending") throw new EdgeBookError("approval_resolved", `Approval already ${approval.status}`);
  approval.status = approved ? "approved" : "rejected";
  approval.resolved_at = now();
  approval.resolved_by = "local-owner";
  approvals[approvalId] = approval;
  approval.audit_refs.push(await store.audit("approval.resolve", approval.requested_by_agent_id, { approval_id: approvalId, approved }));
  approvals[approvalId] = approval;
  await store.saveApprovals(approvals);
  return approval;
}

export async function createPost(store: EdgeBookStore, input: {
    kind?: EdgeBookPostKind;
    title: string;
    body: string;
    tags?: string[];
    visibility?: EdgeBookVisibility;
    sourceBasis?: EdgeBookPost["source_basis"];
    status?: EdgeBookPostStatus;
    replyOrHelpChannel?: string;
    expiresAt?: string;
  }): Promise<EdgeBookPost> {
  const identity = await store.identity();
  const stamp = now();
  const sourceBasis = input.sourceBasis || "human-authored";
  const requestedStatus = input.status || (sourceBasis === "agent-authored" ? "pending_approval" : "draft");
  const post: EdgeBookPost = {
    post_id: randomId("post"),
    author_agent_id: identity.agent_id,
    human_owner_id: identity.owner_label || identity.agent_id,
    kind: input.kind || "note",
    title: input.title,
    body: input.body,
    tags: input.tags || [],
    visibility: input.visibility || "private",
    source_basis: sourceBasis,
    status: requestedStatus,
    created_at: stamp,
    updated_at: stamp,
    published_at: requestedStatus === "published" ? stamp : "",
    expires_at: input.expiresAt || "",
    approval_ref: "",
    permissions_used: [],
    audit_refs: [],
    reply_or_help_channel: input.replyOrHelpChannel || ""
  };
  const posts = await store.posts();
  posts[post.post_id] = post;
  await store.savePosts(posts);
  if (post.status === "pending_approval") {
    const approval = await store.createApproval({
      type: "publish_post",
      objectType: "post",
      objectId: post.post_id,
      summary: `Publish ${post.visibility} post: ${post.title}`,
      riskLevel: post.visibility === "public_if_enabled" ? "high" : "medium"
    });
    post.approval_ref = approval.approval_id;
    posts[post.post_id] = post;
    await store.savePosts(posts);
  }
  post.audit_refs.push(await store.audit("post.create", identity.agent_id, { post_id: post.post_id, status: post.status, visibility: post.visibility }));
  posts[post.post_id] = post;
  await store.savePosts(posts);
  if (post.status === "published") await store.ensureLocalFeedItem(post);
  return post;
}

export async function approvePost(store: EdgeBookStore, postId: string): Promise<EdgeBookPost> {
  const posts = await store.posts();
  const post = posts[postId];
  if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
  if (post.status === "removed") throw new EdgeBookError("removed_post", "Cannot approve a removed post");
  if (post.status === "expired") throw new EdgeBookError("expired_post", "Cannot approve an expired post");
  if (post.approval_ref) await store.resolveApproval(post.approval_ref, true);
  post.status = "published";
  post.source_basis = post.source_basis === "agent-authored" ? "human-approved" : post.source_basis;
  post.updated_at = now();
  post.published_at = post.published_at || post.updated_at;
  posts[postId] = post;
  await store.savePosts(posts);
  await store.ensureLocalFeedItem(post);
  post.audit_refs.push(await store.audit("post.approve", post.author_agent_id, { post_id: postId, visibility: post.visibility }));
  posts[postId] = post;
  await store.savePosts(posts);
  return post;
}

export async function editPost(store: EdgeBookStore, postId: string, input: { title?: string; body?: string; tags?: string[]; visibility?: EdgeBookVisibility }): Promise<EdgeBookPost> {
  const posts = await store.posts();
  const post = posts[postId];
  if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
  if (post.status === "removed") throw new EdgeBookError("removed_post", "Cannot edit a removed post");
  if (input.title !== undefined) post.title = input.title;
  if (input.body !== undefined) post.body = input.body;
  if (input.tags !== undefined) post.tags = input.tags;
  if (input.visibility !== undefined) post.visibility = input.visibility;
  post.status = post.status === "published" ? "edited" : post.status;
  post.updated_at = now();
  post.audit_refs.push(await store.audit("post.edit", post.author_agent_id, { post_id: postId }));
  posts[postId] = post;
  await store.savePosts(posts);
  return post;
}

export async function removePost(store: EdgeBookStore, postId: string, reason = "removed by local owner"): Promise<EdgeBookPost> {
  const posts = await store.posts();
  const post = posts[postId];
  if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
  post.status = "removed";
  post.updated_at = now();
  post.audit_refs.push(await store.audit("post.remove", post.author_agent_id, { post_id: postId, reason }));
  posts[postId] = post;
  await store.savePosts(posts);
  return post;
}

export async function expirePost(store: EdgeBookStore, postId: string, reason = "expired"): Promise<EdgeBookPost> {
  const posts = await store.posts();
  const post = posts[postId];
  if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
  post.status = "expired";
  post.updated_at = now();
  post.audit_refs.push(await store.audit("post.expire", post.author_agent_id, { post_id: postId, reason }));
  posts[postId] = post;
  await store.savePosts(posts);
  return post;
}

export async function ensureLocalFeedItem(store: EdgeBookStore, post: EdgeBookPost): Promise<FeedItem> {
  const identity = await store.identity();
  const items = await store.feedItems();
  const existing = Object.values(items).find((item) => item.post_id === post.post_id && item.origin_agent_id === identity.agent_id);
  if (existing) return existing;
  const item: FeedItem = {
    feed_item_id: randomId("feed"),
    post_id: post.post_id,
    origin_agent_id: identity.agent_id,
    origin_home: "local",
    relationship_id: "",
    visibility_checked_at: now(),
    delivery_route: "local",
    read_state: "unread",
    hidden: false,
    muted_reason: "",
    received_at: now(),
    audit_refs: []
  };
  item.audit_refs.push(await store.audit("feed.local_add", identity.agent_id, { feed_item_id: item.feed_item_id, post_id: post.post_id }));
  items[item.feed_item_id] = item;
  await store.saveFeedItems(items);
  return item;
}

export async function visiblePostsForPeer(store: EdgeBookStore, peerAgentId: string): Promise<EdgeBookPost[]> {
  const identity = await store.identity();
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked", `Peer ${peerAgentId} is blocked`);
  if (contact.relationship_state !== "friend") throw new EdgeBookError("not_friend", `Feed denied for relationship_state=${contact.relationship_state}`);
  const grants = await store.grants();
  const grant = Object.values(grants).find((candidate) =>
    candidate.issuer_agent_id === identity.agent_id &&
    candidate.subject_agent_id === peerAgentId &&
    candidate.status === "active" &&
    candidate.scopes.includes("feed.read.friends") &&
    (!candidate.expires_at || Date.parse(candidate.expires_at) > Date.now())
  );
  if (!grant) throw new EdgeBookError("missing_grant", "No active feed.read.friends grant for peer");
  await store.assertGrantSignature(grant);
  const posts = Object.values(await store.posts());
  return posts
    .filter((post) => post.visibility === "friends" && ["published", "edited"].includes(post.status))
    .filter((post) => !post.expires_at || Date.parse(post.expires_at) > Date.now())
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function importFeedPosts(store: EdgeBookStore, peerAgentId: string, posts: EdgeBookPost[], route: FeedItem["delivery_route"] = "local"): Promise<FeedItem[]> {
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.relationship_state !== "friend") throw new EdgeBookError("not_friend", `Cannot import feed from relationship_state=${contact.relationship_state}`);
  const items = await store.feedItems();
  const imported: FeedItem[] = [];
  for (const post of posts) {
    const existing = Object.values(items).find((item) => item.post_id === post.post_id && item.origin_agent_id === peerAgentId);
    if (existing) {
      imported.push(existing);
      continue;
    }
    const item: FeedItem = {
      feed_item_id: randomId("feed"),
      post_id: post.post_id,
      origin_agent_id: peerAgentId,
      origin_home: route === "relay" ? "relay" : "direct",
      relationship_id: relationshipId((await store.identity()).agent_id, peerAgentId),
      visibility_checked_at: now(),
      delivery_route: route,
      read_state: "unread",
      hidden: false,
      muted_reason: "",
      received_at: now(),
      audit_refs: []
    };
    item.audit_refs.push(await store.audit("feed.import_item", peerAgentId, { feed_item_id: item.feed_item_id, post_id: post.post_id, route }));
    items[item.feed_item_id] = item;
    imported.push(item);
  }
  await store.saveFeedItems(items);
  await store.audit("feed.import", peerAgentId, { count: imported.length, route });
  return imported;
}

export async function markFeedItemRead(store: EdgeBookStore, feedItemId: string): Promise<FeedItem> {
  const items = await store.feedItems();
  const item = items[feedItemId];
  if (!item) throw new EdgeBookError("unknown_feed_item", `Unknown feed item: ${feedItemId}`);
  item.read_state = "read";
  item.audit_refs.push(await store.audit("feed.mark_read", item.origin_agent_id, { feed_item_id: feedItemId }));
  items[feedItemId] = item;
  await store.saveFeedItems(items);
  return item;
}

export async function hideFeedItem(store: EdgeBookStore, feedItemId: string, reason = ""): Promise<FeedItem> {
  const items = await store.feedItems();
  const item = items[feedItemId];
  if (!item) throw new EdgeBookError("unknown_feed_item", `Unknown feed item: ${feedItemId}`);
  item.hidden = true;
  item.muted_reason = reason;
  item.audit_refs.push(await store.audit("feed.hide", item.origin_agent_id, { feed_item_id: feedItemId, reason }));
  items[feedItemId] = item;
  await store.saveFeedItems(items);
  return item;
}

export async function muteContact(store: EdgeBookStore, peerAgentId: string, reason = ""): Promise<ContactMute> {
  const contacts = await store.contacts();
  if (!contacts[peerAgentId]) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  const mutes = await store.contactMutes();
  const mute: ContactMute = {
    peer_agent_id: peerAgentId,
    muted_at: now(),
    muted_reason: reason,
    audit_refs: []
  };
  mute.audit_refs.push(await store.audit("contact.mute", peerAgentId, { reason }));
  mutes[peerAgentId] = mute;
  await store.saveContactMutes(mutes);
  return mute;
}

export async function unmuteContact(store: EdgeBookStore, peerAgentId: string): Promise<void> {
  const mutes = await store.contactMutes();
  if (!mutes[peerAgentId]) return;
  delete mutes[peerAgentId];
  await store.saveContactMutes(mutes);
  await store.audit("contact.unmute", peerAgentId, {});
}
