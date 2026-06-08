import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-api-test-"));
}

function serverBaseUrl(server: { address(): unknown }): string {
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function jsonRequest(baseUrl: string, pathName: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function login(baseUrl: string): Promise<{ sessionId: string; csrf: string }> {
  const response = await jsonRequest(baseUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ auth_method: "dev-bypass" })
  });
  assert.equal(response.status, 200);
  return {
    sessionId: response.body.session_id as string,
    csrf: response.body.csrf_token as string
  };
}

function authHeaders(auth: { sessionId: string; csrf?: string }): Record<string, string> {
  return {
    "x-openclaw-session": auth.sessionId,
    ...(auth.csrf ? { "x-openclaw-csrf": auth.csrf } : {})
  };
}

function assertNoPrivateKeyMaterial(value: unknown): void {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /private_key/i);
  assert.doesNotMatch(text, /PRIVATE/);
  assert.doesNotMatch(text, /-----BEGIN/);
}

test("local API denies unauthenticated reads and allows authenticated owner reads", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "api.openclaw.local" });
  await store.createPost({ title: "Hello", body: "world", status: "published" });
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const denied = await jsonRequest(baseUrl, "/api/posts");
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, "unauthorized");

    const auth = await login(baseUrl);
    const posts = await jsonRequest(baseUrl, "/api/posts", { headers: authHeaders(auth) });
    assert.equal(posts.status, 200);
    assert.equal(Object.keys(posts.body.posts as Record<string, unknown>).length, 1);

    const contacts = await jsonRequest(baseUrl, "/api/contacts", { headers: authHeaders(auth) });
    assert.equal(contacts.status, 200);
    assert.deepEqual(contacts.body.contacts, {});
  } finally {
    await closeServer(server);
  }
});

test("local API never returns private key material in API response bodies", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "api-safe.openclaw.local", displayName: "Safe API" });
  const post = await store.createPost({ title: "Safe post", body: "body", visibility: "friends", status: "published" });
  const [feedItem] = Object.values(await store.feedItems());
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
    responses.push(await jsonRequest(baseUrl, "/api/me", { headers: authHeaders(auth) }));
    responses.push(await jsonRequest(baseUrl, "/api/contacts", { headers: authHeaders(auth) }));
    responses.push(await jsonRequest(baseUrl, "/api/posts", { headers: authHeaders(auth) }));
    responses.push(await jsonRequest(baseUrl, "/api/feed", { headers: authHeaders(auth) }));
    responses.push(await jsonRequest(baseUrl, "/api/approvals", { headers: authHeaders(auth) }));
    responses.push(await jsonRequest(baseUrl, "/api/audit", { headers: authHeaders(auth) }));
    responses.push(await jsonRequest(baseUrl, `/api/audit/post/${encodeURIComponent(post.post_id)}`, { headers: authHeaders(auth) }));
    responses.push(
      await jsonRequest(baseUrl, `/api/feed/${encodeURIComponent(feedItem.feed_item_id)}/read`, {
        method: "POST",
        headers: authHeaders(auth),
        body: JSON.stringify({})
      })
    );
    responses.push(
      await jsonRequest(baseUrl, "/api/export", {
        method: "POST",
        headers: authHeaders(auth),
        body: JSON.stringify({})
      })
    );

    for (const response of responses) {
      assert.equal(response.status, 200);
      assertNoPrivateKeyMaterial(response.body);
    }

    const me = responses[0].body.identity as Record<string, unknown>;
    assert.deepEqual(Object.keys(me).sort(), ["did", "display_name", "handle", "name", "owner_label", "public_key"]);
    assert.equal(me.name, "Safe API");
    assert.match(me.public_key as string, /^[A-Za-z0-9+/=]+$/);
  } finally {
    await closeServer(server);
  }
});

test("local API requires CSRF for mutations and supports post approval flow", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "api-posts.openclaw.local" });
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const withoutCsrf = await jsonRequest(baseUrl, "/api/posts", {
      method: "POST",
      headers: authHeaders({ sessionId: auth.sessionId }),
      body: JSON.stringify({ title: "Blocked", body: "missing csrf" })
    });
    assert.equal(withoutCsrf.status, 403);
    assert.equal(withoutCsrf.body.code, "csrf_required");

    const created = await jsonRequest(baseUrl, "/api/posts", {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({
        title: "Agent post",
        body: "approve me",
        visibility: "friends",
        source_basis: "agent-authored"
      })
    });
    assert.equal(created.status, 200);
    const post = created.body.post as { post_id: string; status: string; approval_ref: string };
    assert.equal(post.status, "pending_approval");

    const approvals = await jsonRequest(baseUrl, "/api/approvals", { headers: authHeaders(auth) });
    assert.equal(approvals.status, 200);
    assert.ok((approvals.body.approvals as Record<string, unknown>)[post.approval_ref]);

    const approved = await jsonRequest(baseUrl, `/api/posts/${encodeURIComponent(post.post_id)}/approve`, {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({})
    });
    assert.equal(approved.status, 200);
    assert.equal((approved.body.post as { status: string }).status, "published");
  } finally {
    await closeServer(server);
  }
});

test("local API supports direct approval rejection exactly once", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "api-reject.openclaw.local" });
  const post = await store.createPost({
    title: "Reject me",
    body: "not yet",
    visibility: "friends",
    sourceBasis: "agent-authored"
  });
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const rejected = await jsonRequest(baseUrl, `/api/approvals/${encodeURIComponent(post.approval_ref)}/resolve`, {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({ approved: false })
    });
    assert.equal(rejected.status, 200);
    assert.equal((rejected.body.approval as { status: string }).status, "rejected");

    const again = await jsonRequest(baseUrl, `/api/approvals/${encodeURIComponent(post.approval_ref)}/resolve`, {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({ approved: true })
    });
    assert.equal(again.status, 400);
    assert.equal(again.body.code, "approval_resolved");
  } finally {
    await closeServer(server);
  }
});

test("local API approvals read stays available after draft post even if approval storage is invalid", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "api-approval-safe.openclaw.local" });
  await store.createPost({
    title: "Draft with audit refs",
    body: "created before approvals read",
    visibility: "private",
    status: "draft"
  });
  await fs.writeFile(path.join(root, "approvals.json"), "{", "utf8");
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const approvals = await jsonRequest(baseUrl, "/api/approvals", { headers: authHeaders(auth) });
    assert.equal(approvals.status, 200);
    assert.deepEqual(approvals.body.approvals, {});
  } finally {
    await closeServer(server);
  }
});


test("local API exposes feed read hide export and import review routes", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "api-feed.openclaw.local" });
  const post = await store.createPost({ title: "Feed item", body: "body", visibility: "friends", status: "published" });
  const [feedItem] = Object.values(await store.feedItems());
  assert.equal(feedItem.post_id, post.post_id);
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);

    const read = await jsonRequest(baseUrl, `/api/feed/${encodeURIComponent(feedItem.feed_item_id)}/read`, {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({})
    });
    assert.equal(read.status, 200);
    assert.equal((read.body.feed_item as { read_state: string }).read_state, "read");

    const hidden = await jsonRequest(baseUrl, `/api/feed/${encodeURIComponent(feedItem.feed_item_id)}/hide`, {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({ reason: "done" })
    });
    assert.equal(hidden.status, 200);
    assert.equal((hidden.body.feed_item as { hidden: boolean; muted_reason: string }).hidden, true);

    const exported = await jsonRequest(baseUrl, "/api/export", {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({})
    });
    assert.equal(exported.status, 200);
    assert.ok((exported.body.export as { posts: Record<string, unknown> }).posts[post.post_id]);
    assertNoPrivateKeyMaterial(exported.body);

    const review = await jsonRequest(baseUrl, "/api/import", {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify(exported.body.export)
    });
    assert.equal(review.status, 200);
    assert.equal((review.body.review as { review_only: boolean }).review_only, true);
  } finally {
    await closeServer(server);
  }
});

test("local server serves API-backed dashboard shell", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "dashboard.openclaw.local" });
  await store.createPost({ title: "Dashboard post", body: "shell state", visibility: "friends", status: "published" });
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${serverBaseUrl(server)}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(html, /Edge Book/);
    assert.match(html, /data-view="profile"/);
    assert.match(html, /data-view="feed"/);
    assert.match(html, /data-view="contacts"/);
    assert.match(html, /data-view="messages"/);
    assert.match(html, /data-view="posts"/);
    assert.match(html, /data-view="approvals"/);
    assert.match(html, /data-view="activity"/);
    assert.match(html, /data-view="inspector"/);
    assert.match(html, /\/auth\/login/);
    assert.match(html, /\/api\/feed/);
    assert.match(html, /\/api\/contacts/);
    assert.match(html, /\/api\/posts/);
    assert.match(html, /\/api\/approvals/);
    assert.match(html, /Current/);
    assert.match(html, /Local-first agent social workspace/);
    assert.match(html, /Search local friends, posts, messages/);
    assert.match(html, /Edge Book operational summary/);
    assert.match(html, /Visible feed/);
    assert.match(html, /Owner Console/);
    assert.match(html, /Attention Queue/);
    assert.match(html, /Recent Activity/);
    assert.match(html, /Activity Log/);
    assert.match(html, /profile-panel/);
    assert.match(html, /activityRail/);
    assert.match(html, /trust-strip/);
    assert.match(html, /trust-label/);
    assert.match(html, /contact-avatar/);
    assert.match(html, /badge\.attention/);
    assert.match(html, /badge\.owned/);
    assert.match(html, /badge\.risk/);
    assert.match(html, /item-body/);
    assert.match(html, /relationship/);
    assert.match(html, /visibility/);
    assert.match(html, /source/);
    assert.match(html, /delivery/);
    assert.match(html, /inspectorSummary/);
    assert.match(html, /Readable decision summary plus detailed local evidence/);
    assert.match(html, /data-view-target="posts"/);
    assert.match(html, /data-view-target="contacts"/);
    assert.match(html, /Visible 0/);
    assert.match(html, /Pending 0/);
    assert.match(html, /Events 0/);
    assert.match(html, /item-time/);
    assert.match(html, /skeleton-line/);
    assert.match(html, /Inspect/);
    assert.match(html, /audit evidence/);
    assert.doesNotMatch(html, /object id/);
    assert.doesNotMatch(html, /did:openclaw/);
    assert.match(html, /data-action="post-create"/);
    assert.match(html, /feed-read/);
    assert.match(html, /feed-hide/);
    assert.match(html, /contact-mute/);
    assert.match(html, /post-edit/);
    assert.match(html, /post-remove/);
    assert.match(html, /approval-approve/);
    assert.match(html, /approval-reject/);
    assert.match(html, /failure_reason/);
  } finally {
    await closeServer(server);
  }
});
