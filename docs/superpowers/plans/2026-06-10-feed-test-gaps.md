# Feed Test-Gap Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the identified test gaps in the Edge Book feed flow (friend → find → retrieve → engage) by first building shared test infrastructure, then backfilling targeted gap tests.

**Architecture:** Phase 1 builds reusable test infrastructure: a shared fixture module for friended-agent setups, a full feed-journey extension to the existing two-agent smoke framework (`scripts/lib/two-agent-smoke.ts`), and a real browser-path `/api/feed` fetch through the host relay (replacing today's canned-agent-only host test). Phase 2 backfills six targeted gap test files, each reusing the Phase 1 fixtures. Phase 3 lists items explicitly deferred to their own specs.

**Tech Stack:** Node 20+ built-in test runner (`node --test test/*.test.ts`), TypeScript ESM with `.ts` imports, `EdgeBookStore` in-process agents, `EdgeBookDialoutClient` + spawned host for relay-path tests.

**Repos touched:** `~/claude/edge-book-cli` (all tasks). `~/claude/edge-book-host` is only *spawned* by the host transport (no host code changes).

**Conventions to follow (observed in this repo):**
- Tests use `node:test` + `node:assert/strict`, temp homes via `fs.mkdtemp(path.join(os.tmpdir(), ...))`.
- Errors are `EdgeBookError` with a `.code` string; negative tests assert the code, not the message.
- Test files live flat in `test/*.test.ts` — the glob does NOT pick up `test/lib/`, so helpers there are safe.
- Each test creates fresh stores; no shared mutable state between tests.
- Run a single file: `node --test test/<file>.test.ts`. Run all: `npm test`.

**A note on TDD shape:** Phase 2 tasks are *test backfill* — a new test that fails indicates a real production bug, not a missing feature. The steps therefore are: write the test → run it → if it passes, commit; if it fails, the failure is a finding — fix the production code minimally (guidance included per task), re-run, commit test + fix together.

---

## Task Summary (for the task board)

| # | Task | Closes gap |
|---|------|-----------|
| 1 | Shared feed fixture module + refactor `backend-objects.test.ts` | Infra (DRY foundation) |
| 2 | Full feed-journey steps in two-agent smoke (local + host transports) | #1 E2E feed journey |
| 3 | Browser-path `/api/feed` over the real host relay with a real agent | #2 Feed retrieval over host |
| 4 | Negative access tests (non-friend, no-grant, temporal lock-in) | #4 Temporal/negative boundary |
| 5 | Grant revocation cascade test | #9 Revocation cascade |
| 6 | Visibility transition tests (friends↔private, no-retraction doc) | #8 Visibility transition |
| 7 | Engagement durability across store reopen + re-import | #5 Engagement durability |
| 8 | Concurrent reads + import idempotency tests | #6 Concurrency (read path) |
| 9 | 200-post scale test (ordering, dedup, time budget) | #10 Large feeds |
| 10 | Handle-expiry discovery integration test | #7 Handle expiry |

---

## Phase 1 — Test Infrastructure

### Task 1: Shared feed fixture module

**Files:**
- Create: `test/lib/feed-fixtures.ts`
- Modify: `test/backend-objects.test.ts` (replace its private `tempRoot`/`makeFriends` with imports)

- [ ] **Step 1: Create the fixture module**

```typescript
// test/lib/feed-fixtures.ts
// Shared fixtures for feed-flow tests. Mirrors the befriend pattern used in
// backend-objects.test.ts and grant-access.test.ts so every feed test starts
// from the same known-good friendship + grant state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore } from "../../src/edge-book.ts";
import type { AgentCard, EdgeBookPost, FeedItem } from "../../src/edge-book.ts";

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
```

**Type-export check:** confirm `EdgeBookPost` and `FeedItem` are re-exported from `src/edge-book.ts` (`grep -n "EdgeBookPost\|FeedItem" src/edge-book.ts`). If not, import the types from `../../src/types.ts` instead — value imports stay on `edge-book.ts`.

- [ ] **Step 2: Refactor `test/backend-objects.test.ts` to use the fixtures**

Delete its local `tempRoot` (lines 8–10) and `makeFriends` (lines 12–23); add at the top:

```typescript
import { makeFriends, tempRoot } from "./lib/feed-fixtures.ts";
```

The local `makeFriends(root)` took a positional root; update the three call sites from `makeFriends(root)` to `makeFriends({ root })`. The returned shape (`{ alice, bob, aliceId, bobId }`) is a subset of `FriendPair`, so destructuring call sites need no other change.

- [ ] **Step 3: Run the full suite to verify the refactor is behavior-neutral**

Run: `cd ~/claude/edge-book-cli && npm test`
Expected: all tests PASS (same count as before the change).

- [ ] **Step 4: Commit**

```bash
git add test/lib/feed-fixtures.ts test/backend-objects.test.ts
git commit -m "test: extract shared feed fixtures module"
```

---

### Task 2: Full feed-journey steps in the two-agent smoke

**Files:**
- Modify: `scripts/lib/two-agent-smoke.ts` (after the existing `feed:` step at lines 179–184, before the `revoke:` step)

- [ ] **Step 1: Harden the existing feed step and add three journey steps**

Replace the existing feed step (lines 179–184) with:

```typescript
    await step("feed: alice grants feed.read.friends and serves her friends-feed", async () => {
      await alice.store.createPost({ title: "Smoke post", body: "hi friends", visibility: "friends", status: "published" });
      await alice.store.issueGrant(bob.card.agent_id, ["feed.read.friends"]);
      const posts = await alice.store.visiblePostsForPeer(bob.card.agent_id);
      if (posts.length < 1) throw new Error("no friend-visible posts");
      return `${posts.length} friend-visible post(s)`;
    });

    await step("feed-journey: bob imports alice's friend-visible posts into his feed", async () => {
      const visible = await alice.store.visiblePostsForPeer(bob.card.agent_id);
      const imported = await bob.store.importFeedPosts(alice.card.agent_id, visible, "direct");
      if (imported.length !== visible.length) throw new Error(`imported ${imported.length}/${visible.length}`);
      return `imported ${imported.length} feed item(s)`;
    });

    await step("feed-journey: bob engages (read + hide) without mutating alice's source post", async () => {
      const items = Object.values(await bob.store.feedItems()).filter((f) => f.origin_agent_id === alice.card.agent_id);
      if (!items.length) throw new Error("no imported items from alice");
      const target = items[0];
      const sourceBefore = JSON.stringify((await alice.store.posts())[target.post_id]);
      const read = await bob.store.markFeedItemRead(target.feed_item_id);
      if (read.read_state !== "read") throw new Error("read_state not set");
      const hidden = await bob.store.hideFeedItem(target.feed_item_id, "smoke hide");
      if (!hidden.hidden) throw new Error("hidden not set");
      const sourceAfter = JSON.stringify((await alice.store.posts())[target.post_id]);
      if (sourceBefore !== sourceAfter) throw new Error("engagement mutated alice's source post");
      return "read+hide applied locally; source post untouched";
    });

    await step("feed-journey: re-import is idempotent and preserves engagement state", async () => {
      const before = Object.keys(await bob.store.feedItems()).length;
      const visible = await alice.store.visiblePostsForPeer(bob.card.agent_id);
      await bob.store.importFeedPosts(alice.card.agent_id, visible, "direct");
      const after = Object.keys(await bob.store.feedItems()).length;
      if (after !== before) throw new Error(`dedup failed: feed item count ${before} -> ${after}`);
      const items = Object.values(await bob.store.feedItems()).filter((f) => f.origin_agent_id === alice.card.agent_id);
      if (items[0].read_state !== "read" || !items[0].hidden) throw new Error("engagement state lost on re-import");
      return "idempotent re-import; read/hidden state preserved";
    });
```

These steps run over BOTH transports automatically — the smoke is invoked with `localTransport` by default and `makeHostTransport` via `--host`/`--remote` (envelope deliveries route through the real mailbox; the feed pull itself is the in-process `visiblePostsForPeer` seam, which is the production mechanism today — there is no network feed-pull yet, see Phase 3).

- [ ] **Step 2: Run the local smoke**

Run: `cd ~/claude/edge-book-cli && npm run smoke`
Expected: `ALL GREEN` with the three new `feed-journey:` steps passing. If the dedup step fails (count grows), that is a real `importFeedPosts` bug — fix the dedup check in `src/store-posts.ts` `importFeedPosts` (lines 264–298) to key on `post_id + origin_agent_id` before creating a new item, then re-run.

- [ ] **Step 3: Run the existing test suite (the smoke is exercised by `test/edge-book.test.ts`)**

Run: `npm test`
Expected: PASS — including the corruption-detection test that asserts the smoke FAILS when a grant is tampered.

- [ ] **Step 4: Run the host-transport smoke (requires a host build)**

Run: `cd ~/claude/edge-book-host && npm run build && cd ~/claude/edge-book-cli && npm run smoke:host`
Expected: `ALL GREEN` with transport `host(local)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/two-agent-smoke.ts
git commit -m "test(smoke): full feed journey — import, engage, idempotent re-import"
```

---

### Task 3: Browser-path `/api/feed` over the real host relay

Today the only host-side `/api/feed` test uses a canned agent (`edge-book-host/test/integration.test.ts:64–95` answers with hardcoded JSON). This task pairs a real browser session against a REAL agent store through the spawned host and asserts the imported feed round-trips.

**Files:**
- Modify: `scripts/lib/two-agent-smoke.ts` (extend `SmokeTransport` interface + add one step)
- Modify: `scripts/lib/host-transport.ts` (implement `fetchAs`)

- [ ] **Step 1: Verify two API surfaces before writing code**

Run: `grep -n "interface PairRegistration" -A 6 src/dialout.ts`
Expected: a `code: string` field on the registration returned by `client.pair()`. If the field has a different name, use that name in Step 3.

Run: `grep -rn "api_request" src/dialout*.ts | head -5`
Expected: confirmation that `EdgeBookDialoutClient` answers `api_request` frames from the real local store (the `dialout-local-api.ts` seam). This is what makes the round-trip "real" rather than canned.

- [ ] **Step 2: Extend the transport interface in `two-agent-smoke.ts`**

```typescript
export interface SmokeTransport {
  name: string;
  deliver(from: AgentRuntime, to: AgentRuntime, envelope: MessageEnvelope, applied: () => Promise<boolean>): Promise<void>;
  // Optional browser-path fetch: pair a reader session for `agent` against the
  // host and GET `apiPath` through the host's wss proxy. Undefined on
  // transports with no host (local in-process).
  fetchAs?(agent: AgentRuntime, apiPath: string): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}
```

- [ ] **Step 3: Implement `fetchAs` in `host-transport.ts`**

Add inside the returned transport object (alongside `deliver`/`close`), reusing the cookie-flow pattern from `edge-book-host/test/integration.test.ts` `pair()`:

```typescript
      async fetchAs(agent, apiPath) {
        const client = clients.get(agent.home);
        if (!client) throw new Error(`no dial-out client for ${agent.home}`);
        const cookies = new Map<string, string>();
        const add = (res: Response) => {
          const headers = res.headers as unknown as { getSetCookie?: () => string[] };
          for (const part of headers.getSetCookie?.() ?? []) {
            const [first] = part.split(";");
            const eq = first!.indexOf("=");
            if (eq !== -1) cookies.set(first!.slice(0, eq).trim(), first!.slice(eq + 1).trim());
          }
        };
        const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

        // 1) GET /pair to pick up the pair CSRF cookie.
        const getRes = await fetch(`${base}/pair`);
        add(getRes);
        await getRes.text();
        const csrf = cookies.get("ebh_pair_csrf");
        if (!csrf) throw new Error("no pair CSRF cookie from host");

        // 2) The REAL agent mints a pairing code over its dial-out socket.
        const registration = await client.pair();

        // 3) Submit the code as the browser.
        const form = new URLSearchParams({ csrf, code: registration.code, remember: "1" });
        const postRes = await fetch(`${base}/pair`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
          body: form.toString(),
          redirect: "manual",
        });
        add(postRes);
        if (postRes.status !== 303) throw new Error(`pair submit failed: ${postRes.status}`);

        // 4) Authenticated GET proxied through the host to the real agent store.
        const r = await fetch(`${base}${apiPath}`, { headers: { cookie: cookieHeader() } });
        return { status: r.status, body: await r.json() };
      },
```

- [ ] **Step 4: Add the smoke step in `two-agent-smoke.ts`** (immediately after the `feed-journey:` steps from Task 2)

```typescript
    if (transport.fetchAs) {
      await step(`feed-host: bob's real /api/feed served through the host proxy (via ${transport.name})`, async () => {
        const res = await transport.fetchAs!(bob, "/api/feed");
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const items = (res.body as { feed_items?: Record<string, { post_id: string }> }).feed_items ?? {};
        const fromAlice = Object.values(await bob.store.feedItems()).filter((f) => f.origin_agent_id === alice.card.agent_id);
        if (!fromAlice.length) throw new Error("precondition: bob has no imported items");
        for (const f of fromAlice) {
          if (!items[f.feed_item_id]) throw new Error(`imported item ${f.feed_item_id} missing from /api/feed over the wire`);
        }
        return `${Object.keys(items).length} feed item(s) over the wire, alice's import present`;
      });
    }
```

- [ ] **Step 5: Run the host smoke**

Run: `npm run smoke:host`
Expected: `ALL GREEN` including the new `feed-host:` step. The local smoke (`npm run smoke`) must also still pass — the step is skipped there (no `fetchAs`).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/two-agent-smoke.ts scripts/lib/host-transport.ts
git commit -m "test(smoke): real-agent /api/feed retrieval over the host relay"
```

---

## Phase 2 — Gap Tests

All Phase 2 files import from `test/lib/feed-fixtures.ts` (Task 1). Common header for every new test file:

```typescript
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EdgeBookError, EdgeBookStore } from "../src/edge-book.ts";
import { makeFriends, addFriend, publishFriendPost, pullAndImport, tempRoot } from "./lib/feed-fixtures.ts";
```

(Drop unused imports per file to keep eslint clean.)

### Task 4: Negative access + temporal lock-in

**Files:**
- Create: `test/feed-access-negative.test.ts`

- [ ] **Step 1: Write the three tests**

```typescript
test("non-friend cannot read the friends-feed (not_friend)", async () => {
  const { alice } = await makeFriends();
  const root = await tempRoot();
  const carol = new EdgeBookStore({ home: path.join(root, "carol") });
  const carolId = (await carol.init({ handle: "carol.openclaw.local" })).agent_id;
  await publishFriendPost(alice);
  await assert.rejects(
    () => alice.visiblePostsForPeer(carolId),
    (e) => e instanceof EdgeBookError && e.code === "not_friend"
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
```

- [ ] **Step 2: Run the file**

Run: `node --test test/feed-access-negative.test.ts`
Expected: PASS. **Known risk:** if the non-friend test fails with a `TypeError` (reading `relationship_state` of `undefined`) instead of `not_friend`, that is a real fail-open-shaped bug in `visiblePostsForPeer` (`src/store-posts.ts:240–262`) — fix it by guarding the contact lookup:

```typescript
  const contact = (await store.contacts())[peerAgentId];
  if (!contact || contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", "peer is not a friend");
  }
```

(Match the existing error-throwing style in that file.) Re-run, expect PASS.

- [ ] **Step 3: Run the full suite, then commit**

Run: `npm test` — expected PASS.

```bash
git add test/feed-access-negative.test.ts src/store-posts.ts
git commit -m "test: negative feed access + pre-friendship visibility lock-in"
```

(Drop `src/store-posts.ts` from the add if no fix was needed.)

---

### Task 5: Grant revocation cascade

**Files:**
- Create: `test/feed-revocation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
test("after alice revokes bob, his feed pull is denied but his imported copies persist", async () => {
  const { alice, bob, bobId } = await makeFriends();
  await publishFriendPost(alice);
  const imported = await pullAndImport(alice, bob, bobId);
  assert.equal(imported.length, 1);

  await alice.revoke(bobId);

  // The author-side gate fails closed after revocation.
  await assert.rejects(
    () => alice.visiblePostsForPeer(bobId),
    (e) => e instanceof EdgeBookError && /not_friend|missing_grant|revoked/.test(e.code)
  );

  // Graceful degrade: bob's already-imported items remain in HIS local feed —
  // revocation stops future pulls, it does not reach into a peer's store.
  const items = Object.values(await bob.feedItems());
  assert.equal(items.length, 1);
});
```

- [ ] **Step 2: Run, tighten, commit**

Run: `node --test test/feed-revocation.test.ts`
Expected: PASS. Note which error code actually fires (the regex accepts three) and tighten the assertion to that single code — exact-code assertions are this repo's style (see `grant-access.test.ts`). If `visiblePostsForPeer` still SUCCEEDS after `revoke()`, that is a fail-open bug: `revoke` (in `src/store-friends.ts`, wired via `src/edge-book.ts:230`) must either flip `relationship_state` off `"friend"` or deactivate the grant — verify which invariant broke and fix in `revoke`.

Run: `npm test` — expected PASS.

```bash
git add test/feed-revocation.test.ts
git commit -m "test: feed revocation cascade — pull denied, imported copies persist"
```

---

### Task 6: Visibility transitions

**Files:**
- Create: `test/feed-visibility-transition.test.ts`

- [ ] **Step 1: Write the three tests**

```typescript
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
```

- [ ] **Step 2: Run, then commit**

Run: `node --test test/feed-visibility-transition.test.ts`
Expected: PASS. Note: `editPost` sets `status: "edited"`, which `visiblePostsForPeer` accepts (`["published", "edited"]`), so the friends→visible test must pass on status grounds; failures here point at the visibility filter.

Run: `npm test` — expected PASS.

```bash
git add test/feed-visibility-transition.test.ts
git commit -m "test: feed visibility transitions and no-retraction behavior"
```

---

### Task 7: Engagement durability (reopen + re-import)

**Files:**
- Create: `test/feed-durability.test.ts`

- [ ] **Step 1: Write the test**

```typescript
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
```

- [ ] **Step 2: Run, then commit**

Run: `node --test test/feed-durability.test.ts`
Expected: PASS. If constructing a second `EdgeBookStore` on an existing home requires an explicit open/init call (i.e. `feedItems()` rejects with a missing-identity error), use the documented reopen path instead — check how `bin/edge-book.js` constructs the store for an existing home and mirror it. If re-import resurrects a hidden item (count stays 1 but `hidden` flips to `false`), that is exactly the "hidden items reappear" bug this gap predicted — fix `importFeedPosts` to skip (not overwrite) existing `post_id + origin_agent_id` items.

Run: `npm test` — expected PASS.

```bash
git add test/feed-durability.test.ts
git commit -m "test: feed engagement state durability across reopen and re-import"
```

---

### Task 8: Concurrency (read path) + import idempotency

**Files:**
- Create: `test/feed-concurrency.test.ts`

- [ ] **Step 1: Write the two tests**

```typescript
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

test("repeated imports never duplicate feed items", async () => {
  // NOTE: concurrent WRITE hardening (read-modify-write races on the JSON
  // stores) is explicitly out of scope here — the store documents a v1
  // serial-receive assumption (see the consumeInviteCode note in
  // src/edge-book.ts). This test pins sequential idempotency, which is the
  // contract production relies on today.
  const { alice, bob, bobId } = await makeFriends();
  await publishFriendPost(alice);
  for (let i = 0; i < 5; i++) {
    await pullAndImport(alice, bob, bobId);
  }
  assert.equal(Object.values(await bob.feedItems()).length, 1);
});
```

- [ ] **Step 2: Run, then commit**

Run: `node --test test/feed-concurrency.test.ts`
Expected: PASS. The concurrent reads are pure reads through the grant gate, so failures indicate either grant-lookup state corruption or non-reentrant file reads — both real findings; investigate in `src/store-posts.ts` / `src/store-trust.ts` before patching.

Run: `npm test` — expected PASS.

```bash
git add test/feed-concurrency.test.ts
git commit -m "test: concurrent feed reads and import idempotency"
```

---

### Task 9: Scale — 200-post feed

**Files:**
- Create: `test/feed-scale.test.ts`

- [ ] **Step 1: Write the test**

```typescript
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
```

- [ ] **Step 2: Run, then commit**

Run: `node --test test/feed-scale.test.ts`
Expected: PASS in well under the 15s budget. If the budget blows, do NOT optimize speculatively — record the measured time in the commit message and file a follow-up task (pagination/storage work is Phase 3 product territory).

Run: `npm test` — expected PASS.

```bash
git add test/feed-scale.test.ts
git commit -m "test: 200-post feed scale — ordering, dedup, time tripwire"
```

---

### Task 10: Handle expiry → discovery integration

**Files:**
- Create: `test/handle-expiry-discovery.test.ts` (modeled directly on `test/handle-resolve.test.ts`)

- [ ] **Step 1: Write the test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { EdgeBookError, EdgeBookStore } from "../src/edge-book.ts";
import { resolveTarget, makeRegistryProvider } from "../src/resolver.ts";

test("an expired relay-served card fails discovery loudly, never resolves", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-expiry-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Owner" });
  await s.setHandle("antony-evans");
  const card = await s.writeCard();

  // Serve the card with a past expiry. Mutating expires_at also breaks the
  // signature, so validateCard rejects via card_expired OR invalid_card —
  // either way discovery fails closed, which is the invariant under test.
  const expired = { ...card, expires_at: "2020-01-01T00:00:00.000Z" };
  const srv = http.createServer((req, res) => {
    if (req.url === "/handle/antony-evans") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(expired));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const provider = makeRegistryProvider(async (t) => {
    const h = t.startsWith("registry:") ? t.slice("registry:".length) : t;
    return `${base}/handle/${h}`;
  });

  await assert.rejects(
    () => resolveTarget(s, "antony-evans", { providers: [provider] }),
    (err) => err instanceof EdgeBookError && /card_expired|invalid_card/.test(err.code)
  );
  await new Promise<void>((r) => srv.close(() => r()));
});
```

- [ ] **Step 2: Run, then commit**

Run: `node --test test/handle-expiry-discovery.test.ts`
Expected: PASS. If it resolves successfully, expiry is not being checked on the registry path — `validateCard` (`src/cards.ts:13–16`) throws `card_expired`, so a pass-through means the registry provider skips `validateCard`; fix the provider in `src/resolver.ts` to validate every served card (the forged-signature test in `handle-resolve.test.ts` suggests it already does — so a failure here would be surprising and worth a close look).

Run: `npm test` — expected PASS.

```bash
git add test/handle-expiry-discovery.test.ts
git commit -m "test: expired relay-served card fails discovery closed"
```

---

## Phase 3 — Explicitly Deferred (each needs its own spec before any code)

These were identified in the gap review but are **product/design work, not test backfill**. Do not bolt them onto this plan — per the spec-driven workflow, each gets a numbered edge-book spec first:

1. **Reader UI feed-state tests** — the reader is a stringified browser IIFE (`edge-book-host/src/reader-script-app.ts`); testing `visibleFeedItems()`/render filtering requires extracting pure helpers or a vm/jsdom harness. Refactor + harness = own spec.
2. **Network feed pull over the relay** — `delivery_route: "relay"` is reserved-but-unimplemented; offline feed delivery via mailbox envelopes is a product feature.
3. **In-feed engagement primitives** (replies/reactions/comments) — currently engagement is read/hide/mute plus out-of-band messages. New envelope types = own spec.
4. **Post retraction** — going private doesn't recall imported copies (Task 6 documents this). A retraction envelope = own spec.
5. **Feed pagination / large-feed storage** — Task 9 adds a tripwire only.
6. **Concurrent-write hardening** — the v1 serial-receive assumption (documented at `src/edge-book.ts` near `consumeInviteCode`) covers all JSON read-modify-write stores; a locking primitive is repo-wide work.
7. **Transport confidentiality / MITM** — out of MVP scope per spec-0020 R6.
8. **Latency SLOs** — quantified post-to-feed latency belongs in a monitoring spec, not unit tests.

---

## Verification (run after the final task)

```bash
cd ~/claude/edge-book-cli
npm run typecheck && npm run lint && npm test && npm run smoke
cd ~/claude/edge-book-host && npm run build && cd ~/claude/edge-book-cli && npm run smoke:host
```

All green = every gap task closed; CI (`.github/workflows/ci.yml`) picks up the new `test/*.test.ts` files automatically via the existing glob.
