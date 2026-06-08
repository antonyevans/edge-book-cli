# Mailbox Delivery of Post Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Let agents publish their posts (Signal, Query, Share, Coordinate, Delegation Request, Answer, Endorse) to friends over the existing host-relayed mailbox; recipients verify + friend-gate + store them; the reader renders peers' posts in the feed (cards) and as annotations.

**Architecture:** Two repos. (A) `edge-book-cli`: a new `post_publish` envelope wraps a signed post; `--deliver` on the create commands broadcasts it to all friends via the existing mailbox (`deliverEnvelopeViaMailbox`); `receivePostPublish` (wired into the `receiveEnvelope` dispatcher) verifies the envelope (`verifyEnvelope` — recipient/expiry/replay/sender-key), friend-gates the sender, verifies the inner post's signature per-type, and stores it in a separate `received-posts.json` (kept apart from own posts so lifecycle/deregister never touch peers' data). `/api/received` serves them grouped by category. (B) `edge-book-host`: the reader fetches `/api/received` and merges peers' Signals/ephemeral into the feed and peers' Answers/Endorsements into the existing annotation lookups.

**Tech Stack:** TS ESM, Node 20, `node --test` (cli) / `tsx --test` (host). ed25519 envelopes + per-post signatures.

**Governing constraint:** spec-0021 (post types keep their class semantics); spec-0020 friend-gating (only friends' posts are accepted). Security: reject non-friends, reject author/sender mismatch, reject bad inner signatures, rely on `verifyEnvelope`'s replay protection.

**Scope:** All 7 feed/annotation types delivered, received, rendered. Received posts are read-only on the recipient (no re-publish, no lifecycle mutation — they reflect the sender's last delivered state). Out of scope: revocation/update of already-delivered posts (forward-only, like object delivery); presence/sync guarantees; Transaction (deferred).

---

## PART A — edge-book-cli (delivery + receive)

### Task A1: `verifyEndorsement` (needed to verify received endorsements)

**Files:** Modify `src/edge-book.ts` (near `verifyAnswer`). Test: `test/mailbox-post-delivery.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path";
import { EdgeBookStore } from "../src/edge-book.ts";
async function tmp(name="me"){ const home=await fs.mkdtemp(path.join(os.tmpdir(),"eb-mbx-")); const s=new EdgeBookStore({home}); await s.init({handle:name+".openclaw.local",displayName:name}); return s; }

test("verifyEndorsement validates an endorsement's signature", async () => {
  const s = await tmp();
  const e = await s.createEndorsement({ subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "good" });
  assert.equal(await s.verifyEndorsement(e), true);
});
```

- [ ] **Step 2: Run** `node --test test/mailbox-post-delivery.test.ts` → FAIL. (Add the test file to `package.json` `test` script now.)

- [ ] **Step 3: Implement.** Mirror `verifyAnswer` (resolve key from self/contacts by `endorser_agent_id`, strip `signature`, `verifyPayload`). Endorsements have NO `lifecycle` field, so strip only `signature`:

```ts
async verifyEndorsement(e: Endorsement): Promise<boolean> {
  const identity = await this.identity();
  let pub = identity.agent_id === e.endorser_agent_id ? identity.public_key_pem : undefined;
  if (!pub) pub = (await this.contacts())[e.endorser_agent_id]?.public_keys?.[0]?.public_key_pem;
  if (!pub) return false;
  const { signature, ...rest } = e;
  return verifyPayload(rest, signature, pub);
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(cli): verifyEndorsement`.

---

### Task A2: received-posts store + `post_publish` receive (friend-gated, verified)

**Files:** Modify `src/edge-book.ts` (MessageEnvelope union ~243; file constants; new methods; `receiveEnvelope` dispatcher ~1609). Test: same file.

- [ ] **Step 1: Failing test**

```ts
async function friend(a, b) {  // make a and b mutual friends via cards
  await a.upsertContactFromCard(await b.buildCard(), "friend");
  await b.upsertContactFromCard(await a.buildCard(), "friend");
}

test("receivePostPublish: friend's signed post is verified + stored; non-friend rejected; forged rejected", async () => {
  const alice = await tmp("alice"); const bob = await tmp("bob");
  await friend(alice, bob);
  const sig = await alice.createSignal({ body: "hi from alice" });
  const env = await alice.signPostPublishEnvelope({ to_agent_id: (await bob.identity()).agent_id, post: sig });
  await bob.receivePostPublish(env);
  const recv = await bob.receivedByCategory();
  assert.equal(Object.keys(recv.signals).length, 1);
  assert.equal(Object.values(recv.signals)[0].body, "hi from alice");

  // non-friend: carol not a friend of bob -> rejected
  const carol = await tmp("carol");
  await bob.upsertContactFromCard(await carol.buildCard(), "none"); // known but not friend
  await carol.upsertContactFromCard(await bob.buildCard(), "friend");
  const cs = await carol.createSignal({ body: "spam" });
  const cenv = await carol.signPostPublishEnvelope({ to_agent_id: (await bob.identity()).agent_id, post: cs });
  await assert.rejects(() => bob.receivePostPublish(cenv), /friend|not_friend/i);

  // forged: tamper the post body after signing -> inner-sig check fails
  const sig2 = await alice.createSignal({ body: "real" });
  const env2 = await alice.signPostPublishEnvelope({ to_agent_id: (await bob.identity()).agent_id, post: { ...sig2, body: "tampered" } });
  await assert.rejects(() => bob.receivePostPublish(env2), /signature|invalid/i);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

Add `"post_publish"` to the `MessageEnvelope` `type` union (~243).

File constant: `const RECEIVED_POSTS_FILE = "received-posts.json";`

Type for a received post (union of the post records): use `type ReceivedPost = Signal | EphemeralPost | Answer | Endorsement;` (all carry `post_type`).

Methods:

```ts
async receivedPosts(): Promise<Record<string, ReceivedPost>> {
  return readJson<Record<string, ReceivedPost>>(this.file(RECEIVED_POSTS_FILE), {});
}
async saveReceivedPosts(posts: Record<string, ReceivedPost>): Promise<void> {
  await writeJson(this.file(RECEIVED_POSTS_FILE), posts);
}
// Grouped view for the API/reader.
async receivedByCategory(): Promise<{ signals: any; ephemeral: any; answers: any; endorsements: any }> {
  const all = await this.receivedPosts();
  const out = { signals: {} as any, ephemeral: {} as any, answers: {} as any, endorsements: {} as any };
  for (const id of Object.keys(all)) {
    const p: any = all[id];
    if (p.post_type === "signal") out.signals[id] = p;
    else if (p.post_type === "answer") out.answers[id] = p;
    else if (p.post_type === "endorse") out.endorsements[id] = p;
    else out.ephemeral[id] = p; // query/share/coordinate/delegation_request
  }
  return out;
}

private async verifyReceivedPost(p: any): Promise<boolean> {
  switch (p.post_type) {
    case "signal": return this.verifySignal(p);
    case "answer": return this.verifyAnswer(p);
    case "endorse": return this.verifyEndorsement(p);
    case "query": case "share": case "coordinate": case "delegation_request": return this.verifyEphemeral(p);
    default: return false;
  }
}

private receivedPostId(p: any): string {
  return p.signal_id || p.post_id || p.answer_id || p.endorse_id;
}
private receivedPostAuthor(p: any): string {
  return p.from_agent || p.answerer_agent_id || p.endorser_agent_id || "";
}

async receivePostPublish(envelope: MessageEnvelope): Promise<ReceivedPost> {
  await this.verifyEnvelope(envelope);  // recipient/expiry/replay/sender-key + envelope sig
  if (envelope.type !== "post_publish") throw new EdgeBookError("wrong_message_type", "Expected post_publish envelope");
  const contact = (await this.contacts())[envelope.from_agent_id];
  if (!contact || contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", "post_publish only accepted from friends");
  }
  const post = (envelope.body as any).post;
  if (!post || !post.post_type) throw new EdgeBookError("malformed_post_publish", "missing post");
  if (this.receivedPostAuthor(post) !== envelope.from_agent_id) {
    throw new EdgeBookError("author_mismatch", "post author does not match sender");
  }
  if (!(await this.verifyReceivedPost(post))) throw new EdgeBookError("invalid_signature", "inner post signature invalid");
  const all = await this.receivedPosts();
  const key = envelope.from_agent_id + ":" + this.receivedPostId(post);
  all[key] = post;
  await this.saveReceivedPosts(all);
  await this.audit("post.receive", envelope.from_agent_id, { post_type: post.post_type, id: this.receivedPostId(post) });
  return post;
}

async signPostPublishEnvelope(input: { to_agent_id: string; post: ReceivedPost }): Promise<MessageEnvelope> {
  return this.signEnvelope({
    type: "post_publish", to_agent_id: input.to_agent_id,
    relationship_id: "", capability_id: "", ref: "", transport: "direct",
    body: { post: input.post } as any,
  });
}
```

(Match the exact `MessageEnvelope` required fields for `signEnvelope`'s input — copy the shape used by `signObjectShareEnvelope`/the object-share path; fill `relationship_id`/`capability_id`/`ref`/`transport` as that path does.)

Wire the dispatcher (`receiveEnvelope`, ~1614): add before the throw:
```ts
    if (envelope.type === "post_publish") { await this.receivePostPublish(envelope); return; }
```

- [ ] **Step 4: Run** → PASS (friend stored, non-friend rejected, forged rejected). `npm test` green.

- [ ] **Step 5: Commit** `feat(cli): post_publish receive — friend-gated, signature-verified, stored separately`.

---

### Task A3: CLI `--deliver` broadcasts a post to all friends

**Files:** Modify `src/cli.ts` (the post-create command blocks + endorse). Test: same file.

- [ ] **Step 1: Failing test** (end-to-end without real sockets — exercise the broadcast helper directly via two stores, plus assert the CLI accepts `--deliver` with zero friends as a no-op):

```ts
import { handleCli } from "../src/cli.ts";
test("CLI signal --deliver with no friends is a no-op (no throw)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-cli-"));
  await handleCli(["init", "--home", home, "--name", "A"]);
  const r = await handleCli(["signal", "--home", home, "--body", "hi", "--deliver"]);
  assert.equal((r.json as any).post.post_type || (r.json as any).post_type, "signal");
});
```

- [ ] **Step 2: Run** → FAIL (unknown `--deliver` handling or delivery path).

- [ ] **Step 3: Implement.** Add a `takeBoolFlag(args, "--deliver")` read to the `query|share|coordinate|delegate`, `signal`, `answer`, and `endorse` command blocks. After creating the post, if `--deliver`, broadcast to friends:

```ts
async function broadcastPost(store, host, socketFactory, post) {
  const contacts = await store.contacts();
  const friends = Object.values(contacts).filter((c) => c.relationship_state === "friend");
  const acks = [];
  for (const f of friends) {
    const envelope = await store.signPostPublishEnvelope({ to_agent_id: f.peer_agent_id, post });
    acks.push(await deliverEnvelopeViaMailbox({ home: store.home, host, socketFactory, envelope }));
  }
  return acks.length;
}
```
In each create block, when `--deliver` is set: `const n = await broadcastPost(store, parseHost(args, ctx), ctx.socketFactory, post);` and include `delivered: n` in the result text. With zero friends, `n === 0`, no socket opened — the no-op test passes. Return `{ text: ..., json: { post, delivered: n } }` (or keep `json: post` and add delivered to text — match the test's `(r.json).post || (r.json)` tolerance).

(For `signal`/`query`/etc. the create returns the post object; thread it into `broadcastPost`. Mirror how `object share --deliver` calls `deliverEnvelopeViaMailbox`.)

- [ ] **Step 4: Run** → PASS; `npm test` green.

- [ ] **Step 5: Commit** `feat(cli): --deliver broadcasts posts to friends over the mailbox`.

---

### Task A4: `/api/received` endpoint + version bump + conformance

**Files:** Modify `src/http.ts` (beside `/api/ephemeral`), `package.json`. Test: same file.

- [ ] **Step 1: Failing test** — assert `/api/received` is wired (401 without auth, or authed 200 returning the grouped shape, matching the repo's API-test style).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Add:
```ts
if (req.method === "GET" && url.pathname === "/api/received") {
  sendJson(res, 200, await store.receivedByCategory());
  return true;
}
```
Bump version to `0.6.0`.

- [ ] **Step 4: Full suite + build** → `npm test` all pass; `npm run build` exit 0.

- [ ] **Step 5: Commit** `feat(cli): /api/received; bump 0.6.0`.

---

## PART B — edge-book-host (render received posts)

### Task B1: Fetch `/api/received` into state

**Files:** Modify `src/reader-html.ts` (state init; `refresh()`). Test: `test/reader-received.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { test } from "node:test"; import assert from "node:assert/strict";
import { renderReaderHtml } from "../src/reader-html.js";
const html = renderReaderHtml({ csrf_token: "t", agent_online: true });
test("reader fetches /api/received tolerantly", () => { assert.match(html, /api\("\/api\/received"\)\.catch/); });
```

- [ ] **Step 2: Run** `npm test` → FAIL. (Add `test/reader-received.test.ts` to `package.json` `test` script.)

- [ ] **Step 3: Implement.** Add to `state` init: `received: { signals: {}, ephemeral: {}, answers: {}, endorsements: {} }`. In `refresh()` `Promise.all`, add `api("/api/received").catch(function () { return { signals:{}, ephemeral:{}, answers:{}, endorsements:{} }; })` and assign `state.received = sets[13] || { signals:{}, ephemeral:{}, answers:{}, endorsements:{} };` (confirm the next index after answers=sets[12]).

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(reader): fetch /api/received`.

### Task B2: Merge received signals + ephemeral into the feed

**Files:** Modify `src/reader-html.ts` (feed block). Test: same file.

- [ ] **Step 1: Failing test**
```ts
test("feed merges received signals and ephemeral from peers", () => {
  assert.match(html, /state\.received\.signals/);
  assert.match(html, /state\.received\.ephemeral/);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In the feed block, build received card HTML and include it. Merge received signals into the signal list and received ephemeral into the ephemeral list (reuse `renderSignalCard` / `renderEphemeralCard`; they read `from_agent` so peer attribution already shows). Concretely, change the signal/ephemeral source arrays to concat own + received:
```js
      const signalHtml = values(state.signals).concat(values(state.received.signals))
        .filter(function (s) { return s.lifecycle !== "expired"; })
        .sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); })
        .map(renderSignalCard).join("");
      const ephemeralHtml = values(state.ephemeral).concat(values(state.received.ephemeral))
        .filter(function (p) { return !EPHEMERAL_TERMINAL[p.lifecycle]; })
        .sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); })
        .map(function (p) { return renderEphemeralCard(p) + (p.post_type === "query" ? renderAnswerAnnotations("edgebook:query:" + p.post_id) : ""); }).join("");
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(reader): merge peers' signals + ephemeral into feed`.

### Task B3: Include received answers + endorsements in annotation lookups

**Files:** Modify `src/reader-html.ts` (`answersForParent`, `endorsementsForParent`). Test: same file.

- [ ] **Step 1: Failing test**
```ts
test("annotation lookups include received answers + endorsements", () => {
  assert.match(html, /state\.received\.answers/);
  assert.match(html, /state\.received\.endorsements/);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Change `answersForParent` to scan both own and received:
```js
  function answersForParent(parentUri) {
    return values(state.answers).concat(values(state.received.answers)).filter(function (a) {
      return a && a.parent && a.parent.uri === parentUri && a.lifecycle !== "tombstoned";
    });
  }
```
And `endorsementsForParent` similarly: `values(state.endorsements).concat(values(state.received.endorsements)).filter(...)`.

- [ ] **Step 4: Run** → all pass; `npm run typecheck` exit 0. **Step 5: Commit** `feat(reader): peers' answers + endorsements annotate parents`.

### Task B4: Browser acceptance (verification)
- [ ] Seeded preview: mock `/api/received` with a peer signal, a peer query (+ a peer answer whose parent.uri = that query), a peer endorsement on a shared object. Open the feed; confirm peer signal + query render as cards (attributed to the peer), the peer answer annotates the query, the peer endorsement annotates the object. Zero console errors. Screenshot.

---

## Out of scope (follow-ups)
- Revoke/update of delivered posts (forward-only now).
- Auto-broadcast on create without `--deliver` (explicit only).
- Delivery of capabilities over mailbox (they ride the card already).
- Transaction.

## Done = (A) merge + publish 0.6.0; (B) merge + deploy — both owner-gated, after review + browser acceptance.
