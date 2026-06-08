# Post Taxonomy — Remaining Types (Query, Share, Coordinate, Delegation Request, Answer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Implement the remaining spec-0021 post types (Transaction deferred) on the agent data layer: the four Class-2 ephemeral types (Query, Share, Coordinate, Delegation Request) via one generic ephemeral store, and the Class-3 Answer as a reified edge on a Query.

**Architecture:** Extend `EdgeBookStore` in `~/claude/edge-book-cli`. The four Class-2 types share ONE generic ephemeral-post store (`ephemeral-posts.json`) with a `post_type` discriminator + per-type TTL policy (hard TTL → terminal for Query/Delegation Request; soft → stale for Share/Coordinate). The shipped Signal store stays untouched (preserve 0.3.0's `/api/signals` + `signal` CLI); a shared `computeLifecycle` helper de-dupes the active/stale/expired logic. Answer is a reified edge like Endorse — actor-owned, strongRef to a parent Query — but with no evidence requirement. R7 cascade: Query delete tombstones its Answers; deregister moves open Queries/Delegation Requests to `cancelled`.

**Tech Stack:** TypeScript ESM, Node 20, `node --test`, `tsup`. No new deps.

**Governing constraint:** `17-skill-as-a-service/spec-0021-agent-network-post-taxonomy.md`. Relevant: R1 (closed taxonomy — these types already registered in `POST_TAXONOMY`), R2 (each in declared class: query/share/coordinate/delegation_request = Class 2, answer = Class 3), R4 (Class 2 lifecycle + expiry; hard TTL for Query & Delegation Request), R5 (Answer actor-owned + strongRef parent), R7 (Query delete tombstones Answers; deregister cancels open Queries/Delegation Requests).

**Scope boundary:** Agent data layer only (`edge-book-cli`): types, stores, lifecycle, cascade, CLI, read-only API, tests → publish 0.4.0. **Out of slice:** Transaction (deferred per owner); reader rendering of these types (follow-up — the rendering pattern is established); mailbox delivery; rich per-type fields beyond body/subject/ref.

**Existing patterns to mirror exactly** (in `src/edge-book.ts`): `createSignal`/`signalLifecycle`/`expireSignals` (Class 2), `createEndorsement` (Class 3 reified edge), `deregister` (R7 cascade), `randomId`, `signPayload`, `now`, `readJson`, the `save*` wrappers, `audit`, `EdgeBookError`, `POST_TAXONOMY`/`classOf`. File-constant convention near line 326.

---

## Spec coverage map

| Rule | Task |
|------|------|
| R2 class-of-type (query/share/coordinate/delegation_request → 2; answer → 3) | Tasks 2, 4; conformance in Task 8 |
| R4 Class 2 lifecycle + hard/soft TTL | Tasks 1, 2, 3 |
| R5 Answer actor-owned + strongRef parent | Task 4 |
| R7 Query delete tombstones Answers; deregister cancels open Queries/Delegation Requests | Tasks 5, 6 |

---

## File structure

- **Modify** `src/edge-book.ts` — shared lifecycle helper; `EphemeralPost`/`Answer` types; `EPHEMERAL_TTL_POLICY`; file constants; store methods; deregister cascade.
- **Modify** `src/cli.ts` — commands + usage.
- **Modify** `src/http.ts` — `GET /api/ephemeral`, `GET /api/answers`.
- **Modify** `package.json` — add the new test file to the `test` script; bump to 0.4.0.
- **Create** `test/post-taxonomy-remaining.test.ts`.

New storage files: `ephemeral-posts.json`, `answers.json`.

---

### Task 1: Shared lifecycle helper (DRY across Signal + ephemeral)

**Files:** Modify `src/edge-book.ts` (near `signalLifecycle` ~1032). Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore, computeLifecycle } from "../src/edge-book.ts";

async function tmp() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rem-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  return s;
}

test("computeLifecycle: soft expiry -> stale, hard expiry -> expired, terminal preserved", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  assert.equal(computeLifecycle(future, false, "active"), "active");
  assert.equal(computeLifecycle(past, false, "active"), "stale");   // soft
  assert.equal(computeLifecycle(past, true, "active"), "expired");  // hard
  assert.equal(computeLifecycle(past, true, "cancelled"), "cancelled"); // terminal preserved
  assert.equal(computeLifecycle(past, false, "tombstoned"), "tombstoned");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — `computeLifecycle` not exported.

- [ ] **Step 3: Write minimal implementation**

Add near `signalLifecycle` (module-level export, not a method):

```ts
// Shared Class-2 lifecycle: terminal states are preserved; otherwise past-expiry
// becomes "expired" for hard-TTL types or "stale" for soft ones.
export function computeLifecycle(
  expiresAt: string,
  hard: boolean,
  current: string,
): "active" | "stale" | "expired" | "cancelled" | "tombstoned" {
  if (current === "expired" || current === "cancelled" || current === "tombstoned") return current as any;
  if (Date.parse(expiresAt) <= Date.now()) return hard ? "expired" : "stale";
  return "active";
}
```

Refactor `signalLifecycle` to delegate (Signal is soft-TTL):

```ts
  private signalLifecycle(sig: Signal): Signal["lifecycle"] {
    return computeLifecycle(sig.expires_at, false, sig.lifecycle) as Signal["lifecycle"];
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: new test passes; existing signal tests still green (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy-remaining.test.ts package.json
git commit -m "refactor(taxonomy): shared computeLifecycle helper for Class-2 types"
```

(Also add `test/post-taxonomy-remaining.test.ts` to the `test` script in `package.json` in this step so it runs.)

---

### Task 2: Generic ephemeral store + create (Class 2: query/share/coordinate/delegation_request, R2/R4)

**Files:** Modify `src/edge-book.ts`. Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("createEphemeral stores each type in Class 2 with hard/soft TTL semantics (R2/R4)", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "who can review my deck?", ttlMs: 1 });
  assert.equal(q.post_type, "query");
  assert.equal(classOfRemaining("query"), 2);
  assert.ok(q.expires_at);
  const sh = await s.createEphemeral("share", { body: "useful link", ref: "https://x", ttlMs: 1 });
  const co = await s.createEphemeral("coordinate", { body: "walk at 5?", subject_agent_id: "did:peer", ttlMs: 60000 });
  const dr = await s.createEphemeral("delegation_request", { body: "summarize this", subject_agent_id: "did:peer", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const all = await s.ephemeralPosts();
  assert.equal(all[q.post_id].lifecycle, "expired");   // query = hard TTL
  assert.equal(all[sh.post_id].lifecycle, "stale");     // share = soft
  assert.equal(all[co.post_id].lifecycle, "active");    // not yet expired
  assert.equal(all[dr.post_id].lifecycle, "expired");   // delegation_request = hard
});
```

Add a local helper import: `import { classOf as classOfRemaining, type PostType } from "../src/edge-book.ts";`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — `createEphemeral` not defined.

- [ ] **Step 3: Write minimal implementation**

File constants (near line 332):

```ts
const EPHEMERAL_FILE = "ephemeral-posts.json";
const ANSWERS_FILE = "answers.json";
const DEFAULT_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
```

Types (near `Signal`, ~169):

```ts
export type EphemeralType = "query" | "share" | "coordinate" | "delegation_request";

export interface EphemeralPost {
  post_id: string;
  post_type: EphemeralType;
  schema: "edge-book/ephemeral/0.1";
  from_agent: string;
  body: string;
  subject_agent_id?: string;   // delegation_request target / coordinate counterpart
  ref?: string;                // share reference
  lifecycle: "active" | "stale" | "expired" | "cancelled" | "tombstoned";
  created_at: string;
  expires_at: string;
  signature: string;
}

// Per-type TTL policy: hard => past-expiry is terminal "expired"; soft => "stale".
export const EPHEMERAL_TTL_POLICY: Record<EphemeralType, { hard: boolean }> = {
  query: { hard: true },
  delegation_request: { hard: true },
  share: { hard: false },
  coordinate: { hard: false },
};
```

Store methods (near the signal methods):

```ts
async saveEphemeral(posts: Record<string, EphemeralPost>): Promise<void> {
  await writeJson(this.file(EPHEMERAL_FILE), posts);
}

async ephemeralPosts(): Promise<Record<string, EphemeralPost>> {
  const raw = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
  for (const id of Object.keys(raw)) {
    raw[id].lifecycle = computeLifecycle(raw[id].expires_at, EPHEMERAL_TTL_POLICY[raw[id].post_type].hard, raw[id].lifecycle);
  }
  return raw;
}

async createEphemeral(type: EphemeralType, input: { body: string; subject_agent_id?: string; ref?: string; ttlMs?: number }): Promise<EphemeralPost> {
  if (!EPHEMERAL_TTL_POLICY[type]) throw new EdgeBookError("unknown_post_type", `Not an ephemeral Class-2 type: ${type}`);
  const identity = await this.identity();
  const post_id = randomId("eph");
  const created = now();
  const expires_at = new Date(Date.now() + (input.ttlMs ?? DEFAULT_EPHEMERAL_TTL_MS)).toISOString();
  const unsigned = {
    post_id, post_type: type, schema: "edge-book/ephemeral/0.1" as const,
    from_agent: identity.agent_id, body: input.body,
    ...(input.subject_agent_id ? { subject_agent_id: input.subject_agent_id } : {}),
    ...(input.ref ? { ref: input.ref } : {}),
    lifecycle: "active" as const, created_at: created, expires_at,
  };
  const post: EphemeralPost = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  const all = await this.ephemeralPosts();
  all[post_id] = post;
  await this.saveEphemeral(all);
  await this.audit(type + ".create", input.subject_agent_id ?? identity.agent_id, { post_id });
  return post;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy-remaining.test.ts
git commit -m "feat(taxonomy): generic Class-2 ephemeral store (query/share/coordinate/delegation_request, R2/R4)"
```

---

### Task 3: Expire + cancel ephemeral (terminal states, R4)

**Files:** Modify `src/edge-book.ts`. Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("expireEphemeral writes terminal states; cancelEphemeral cancels one post", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "x", ttlMs: 1 });
  const co = await s.createEphemeral("coordinate", { body: "y", ttlMs: 60000 });
  await new Promise((r) => setTimeout(r, 5));
  await s.expireEphemeral();
  let raw = JSON.parse(await fs.readFile(path.join((s as any).home, "ephemeral-posts.json"), "utf8"));
  assert.equal(raw[q.post_id].lifecycle, "expired");
  await s.cancelEphemeral(co.post_id);
  raw = JSON.parse(await fs.readFile(path.join((s as any).home, "ephemeral-posts.json"), "utf8"));
  assert.equal(raw[co.post_id].lifecycle, "cancelled");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — `expireEphemeral`/`cancelEphemeral` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
async expireEphemeral(): Promise<void> {
  const all = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
  let changed = false;
  for (const id of Object.keys(all)) {
    const next = computeLifecycle(all[id].expires_at, EPHEMERAL_TTL_POLICY[all[id].post_type].hard, all[id].lifecycle);
    if (next !== all[id].lifecycle) { all[id].lifecycle = next; changed = true; }
  }
  if (changed) await this.saveEphemeral(all);
}

async cancelEphemeral(postId: string): Promise<EphemeralPost> {
  const all = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
  const post = all[postId];
  if (!post) throw new EdgeBookError("not_found", `No ephemeral post ${postId}`);
  post.lifecycle = "cancelled";
  await this.saveEphemeral(all);
  await this.audit("ephemeral.cancel", post.from_agent, { post_id: postId });
  return post;
}
```

- [ ] **Step 4: Run tests** → `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy-remaining.test.ts
git commit -m "feat(taxonomy): ephemeral expire + cancel terminal states (R4)"
```

---

### Task 4: Class 3 Answer — actor-owned, strongRef to a Query (R5)

**Files:** Modify `src/edge-book.ts`. Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("Answer is actor-owned, requires a strongRef parent, no evidence needed (R5)", async () => {
  const s = await tmp();
  const me = (await s.identity()).agent_id;
  const q = await s.createEphemeral("query", { body: "who can help?" });
  const ans = await s.createAnswer({ parent: { uri: "edgebook:query:" + q.post_id, hash: "h" }, body: "I can." });
  assert.equal(ans.post_type, "answer");
  assert.equal(ans.answerer_agent_id, me);            // actor-owned
  assert.equal(ans.parent.uri, "edgebook:query:" + q.post_id);
  assert.equal(ans.lifecycle, "active");
  await assert.rejects(() => s.createAnswer({ parent: { uri: "", hash: "" } as any, body: "x" }), /parent/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — `createAnswer` not defined.

- [ ] **Step 3: Write minimal implementation**

Type (near `Endorsement`):

```ts
export interface Answer {
  answer_id: string;
  post_type: "answer";
  schema: "edge-book/answer/0.1";
  answerer_agent_id: string;   // actor-owned (R5)
  parent: StrongRef;           // strongRef to the parent Query (R5)
  body: string;
  lifecycle: "active" | "tombstoned";
  created_at: string;
  signature: string;
}
```

Store methods:

```ts
async saveAnswers(answers: Record<string, Answer>): Promise<void> {
  await writeJson(this.file(ANSWERS_FILE), answers);
}
async answers(): Promise<Record<string, Answer>> {
  return readJson<Record<string, Answer>>(this.file(ANSWERS_FILE), {});
}
async createAnswer(input: { parent: StrongRef; body: string }): Promise<Answer> {
  if (!input.parent?.uri || !input.parent?.hash) {
    throw new EdgeBookError("missing_parent", "Answer requires a strongRef parent (uri + hash) — R5");
  }
  const identity = await this.identity();
  const answer_id = randomId("ans");
  const unsigned = {
    answer_id, post_type: "answer" as const, schema: "edge-book/answer/0.1" as const,
    answerer_agent_id: identity.agent_id,   // actor-owned (R5)
    parent: input.parent, body: input.body,
    lifecycle: "active" as const, created_at: now(),
  };
  const answer: Answer = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  const all = await this.answers();
  all[answer_id] = answer;
  await this.saveAnswers(all);
  await this.audit("answer.create", identity.agent_id, { answer_id, parent: input.parent.uri });
  return answer;
}
```

- [ ] **Step 4: Run tests** → `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy-remaining.test.ts
git commit -m "feat(taxonomy): Class 3 Answer — actor-owned strongRef to Query (R5)"
```

---

### Task 5: Query delete tombstones its Answers (R7)

**Files:** Modify `src/edge-book.ts`. Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("deleteQuery tombstones the query and its answers, never drops them (R7)", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "q" });
  const a1 = await s.createAnswer({ parent: { uri: "edgebook:query:" + q.post_id, hash: "h" }, body: "a1" });
  const other = await s.createEphemeral("query", { body: "q2" });
  const a2 = await s.createAnswer({ parent: { uri: "edgebook:query:" + other.post_id, hash: "h" }, body: "a2" });
  await s.deleteQuery(q.post_id);
  const eph = await s.ephemeralPosts();
  const ans = await s.answers();
  assert.equal(eph[q.post_id].lifecycle, "tombstoned");     // query archived, not dropped
  assert.equal(ans[a1.answer_id].lifecycle, "tombstoned");   // its answer archived
  assert.equal(ans[a2.answer_id].lifecycle, "active");        // unrelated answer untouched
  assert.ok(ans[a1.answer_id]);                              // still present (not deleted)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — `deleteQuery` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// R7: deleting a Query tombstones (archives) it AND its Answers — never hard-drops.
async deleteQuery(queryId: string): Promise<void> {
  const eph = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
  const q = eph[queryId];
  if (!q || q.post_type !== "query") throw new EdgeBookError("not_found", `No query ${queryId}`);
  q.lifecycle = "tombstoned";
  await this.saveEphemeral(eph);
  const parentUri = "edgebook:query:" + queryId;
  const ans = await this.answers();
  let changed = false;
  for (const id of Object.keys(ans)) {
    if (ans[id].parent.uri === parentUri && ans[id].lifecycle !== "tombstoned") { ans[id].lifecycle = "tombstoned"; changed = true; }
  }
  if (changed) await this.saveAnswers(ans);
  await this.audit("query.delete", q.from_agent, { query_id: queryId });
}
```

- [ ] **Step 4: Run tests** → `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy-remaining.test.ts
git commit -m "feat(taxonomy): deleteQuery tombstones query + answers (R7)"
```

---

### Task 6: Extend deregister cascade to ephemeral + answers (R7)

**Files:** Modify `src/edge-book.ts` (`deregister`, ~1110). Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("deregister cancels open Queries/Delegation Requests, expires soft ephemerals, tombstones answers; retains endorsements (R7)", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "q", ttlMs: 60000 });
  const dr = await s.createEphemeral("delegation_request", { body: "d", ttlMs: 60000 });
  const sh = await s.createEphemeral("share", { body: "s", ttlMs: 60000 });
  const ans = await s.createAnswer({ parent: { uri: "edgebook:query:" + q.post_id, hash: "h" }, body: "a" });
  const end = await s.createEndorsement({ subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "s" });
  await s.deregister();
  const eph = await s.ephemeralPosts();
  const answers = await s.answers();
  const ends = await s.endorsements();
  assert.equal(eph[q.post_id].lifecycle, "cancelled");      // open Query -> cancelled
  assert.equal(eph[dr.post_id].lifecycle, "cancelled");     // open Delegation Request -> cancelled
  assert.equal(eph[sh.post_id].lifecycle, "expired");       // soft -> expired terminal
  assert.equal(answers[ans.answer_id].lifecycle, "tombstoned"); // answers tombstone
  assert.ok(ends[end.endorse_id]);                          // endorsements retained
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — deregister doesn't touch ephemeral/answers yet.

- [ ] **Step 3: Write minimal implementation**

In `deregister`, after the signals loop (before the closing audit), add:

```ts
    const eph = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
    for (const id of Object.keys(eph)) {
      const lc = eph[id].lifecycle;
      if (lc === "expired" || lc === "cancelled" || lc === "tombstoned") continue;
      const t = eph[id].post_type;
      eph[id].lifecycle = (t === "query" || t === "delegation_request") ? "cancelled" : "expired";
    }
    await this.saveEphemeral(eph);
    const ans = await readJson<Record<string, Answer>>(this.file(ANSWERS_FILE), {});
    for (const id of Object.keys(ans)) if (ans[id].lifecycle !== "tombstoned") ans[id].lifecycle = "tombstoned";
    await this.saveAnswers(ans);
    // Endorsements (Class 3 evidence) + Attestations (Class 4) remain retained (untouched).
```

- [ ] **Step 4: Run tests** → `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy-remaining.test.ts
git commit -m "feat(taxonomy): deregister cancels open queries/delegations, tombstones answers (R7)"
```

---

### Task 7: CLI commands

**Files:** Modify `src/cli.ts` (after the `capability` block; usage). Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { handleCli } from "../src/cli.ts";
test("CLI: query/share/coordinate/delegate/answer/query-delete round-trip", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rem-cli-"));
  await handleCli(["init", "--home", home, "--name", "A"]);
  const q = await handleCli(["query", "--home", home, "--body", "who can help?"]);
  const qid = (q.json as any).post_id;
  assert.equal((q.json as any).post_type, "query");
  assert.equal((await handleCli(["share", "--home", home, "--body", "link", "--ref", "https://x"])).json.post_type, "share");
  assert.equal((await handleCli(["coordinate", "--home", home, "--body", "walk?"])).json.post_type, "coordinate");
  assert.equal((await handleCli(["delegate", "--home", home, "--to", "did:p", "--body", "summarize"])).json.post_type, "delegation_request");
  const ans = await handleCli(["answer", qid, "--home", home, "--body", "I can"]);
  assert.equal((ans.json as any).post_type, "answer");
  assert.equal((ans.json as any).parent.uri, "edgebook:query:" + qid);
  const del = await handleCli(["query-delete", qid, "--home", home]);
  assert.match(del.text, /tombstoned|deleted/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — unknown command `query`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, after the `capability` command block:

```ts
  if (command === "query" || command === "share" || command === "coordinate" || command === "delegate") {
    const type = command === "delegate" ? "delegation_request" : command;
    const post = await store.createEphemeral(type as any, {
      body: requireArg(takeFlag(args, "--body"), "--body"),
      subject_agent_id: takeFlag(args, "--to") || takeFlag(args, "--with"),
      ref: takeFlag(args, "--ref"),
      ttlMs: takeFlag(args, "--ttl-ms") ? Number(takeFlag(args, "--ttl-ms")) : undefined,
    });
    return { text: `${post.post_type} ${post.post_id}`, json: post };
  }

  if (command === "answer") {
    const queryId = requireArg(args.shift(), "<query-id>");
    const ans = await store.createAnswer({
      parent: { uri: "edgebook:query:" + queryId, hash: queryId },
      body: requireArg(takeFlag(args, "--body"), "--body"),
    });
    return { text: `answer ${ans.answer_id}`, json: ans };
  }

  if (command === "query-delete") {
    const queryId = requireArg(args.shift(), "<query-id>");
    await store.deleteQuery(queryId);
    return { text: `Tombstoned query ${queryId} and its answers`, json: { query_id: queryId } };
  }

  if (command === "ephemeral") {
    const all = await store.ephemeralPosts();
    return { text: JSON.stringify(all, null, 2), json: all };
  }

  if (command === "answers") {
    const all = await store.answers();
    return { text: JSON.stringify(all, null, 2), json: all };
  }
```

Note on `--ttl-ms`: call `takeFlag` ONCE — capture `const ttl = takeFlag(args, "--ttl-ms");` before the object and reuse, since `takeFlag` mutates `args`. Likewise capture `--to`/`--with` once each. Rewrite the ephemeral block to read each flag exactly once:

```ts
    const body = requireArg(takeFlag(args, "--body"), "--body");
    const to = takeFlag(args, "--to") || takeFlag(args, "--with");
    const ref = takeFlag(args, "--ref");
    const ttl = takeFlag(args, "--ttl-ms");
    const post = await store.createEphemeral(type as any, { body, subject_agent_id: to, ref, ttlMs: ttl ? Number(ttl) : undefined });
```

Add to `usage()` under the post-taxonomy section:

```
  edge-book query --body <s> [--ttl-ms <ms>]
  edge-book share --body <s> [--ref <r>] [--ttl-ms <ms>]
  edge-book coordinate --body <s> [--with <agent>] [--ttl-ms <ms>]
  edge-book delegate --to <agent> --body <s> [--ttl-ms <ms>]
  edge-book answer <query-id> --body <s>
  edge-book query-delete <query-id>
  edge-book ephemeral            # list Class-2 ephemeral posts
  edge-book answers              # list answers
```

- [ ] **Step 4: Run tests** → `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/post-taxonomy-remaining.test.ts
git commit -m "feat(taxonomy): CLI query/share/coordinate/delegate/answer/query-delete"
```

---

### Task 8: API endpoints + conformance + version bump + full suite

**Files:** Modify `src/http.ts` (beside `/api/signals`), `package.json`. Test: `test/post-taxonomy-remaining.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { classOf, POST_TAXONOMY, type PostType } from "../src/edge-book.ts";
test("R1/R2 conformance: all 5 new types resolve and store in their declared class", () => {
  for (const t of ["query", "share", "coordinate", "delegation_request"] as PostType[]) assert.equal(classOf(t), 2);
  assert.equal(classOf("answer"), 3);
});

test("API exposes /api/ephemeral and /api/answers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rem-api-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  await s.createEphemeral("query", { body: "q" });
  const { startEdgeBookServer } = await import("../src/http.ts");
  const server = await startEdgeBookServer({ home, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  // match the auth pattern the existing local-api.test.ts uses (dev-bypass login -> session + csrf).
  // ... (mirror local-api.test.ts setup) ...
  await new Promise<void>((r) => server.close(() => r()));
});
```

NOTE: match the real `/api/*` auth flow (dev-bypass login → session header + csrf) exactly as `test/local-api.test.ts` does; the endpoints are behind `requireApiAuth`. If mirroring auth is heavy, assert the endpoints exist by checking a 401 without auth (proves the route is wired) instead of a full authed fetch — pick whichever matches the repo's other API tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy-remaining.test.ts`
Expected: FAIL — endpoints 404 / not wired.

- [ ] **Step 3: Write minimal implementation**

In `src/http.ts`, beside the existing taxonomy GET endpoints (`/api/signals` etc.):

```ts
  if (req.method === "GET" && url.pathname === "/api/ephemeral") {
    sendJson(res, 200, { ephemeral: await store.ephemeralPosts() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/answers") {
    sendJson(res, 200, { answers: await store.answers() });
    return true;
  }
```

(Match the existing handler shape exactly — `return true;` and `sendJson(res, 200, ...)` as the other `/api/*` handlers use.)

Bump version:

```bash
node -e "const p=require('./package.json'); p.version='0.4.0'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 4: Full suite + build**

Run: `npm test` → all pass (existing + new).
Run: `npm run build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/post-taxonomy-remaining.test.ts package.json
git commit -m "feat(taxonomy): /api/ephemeral + /api/answers; R1/R2 conformance; bump 0.4.0"
```

---

## Out of scope (follow-ups)

- Transaction type (Class 3→4 hybrid) — deferred by owner.
- Reader rendering of these types (Class-2 in feed, Answers as annotations on Queries) — follow the established reader-rendering pattern.
- Mailbox/dialout delivery of these post types.
- Richer per-type payloads (structured coordinate participants, delegation deadlines, etc.).

## Done = merge to main + publish 0.4.0 (owner-gated), after review.
