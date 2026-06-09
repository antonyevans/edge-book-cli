# Edge Book Resolver + Capability Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Edge Book resolver — `target → verified Agent Card → friend request` — with a provider seam, a candidate store with human approval for first-contact, and Index wired as a discovery-only (candidate-only) source.

**Architecture:** A new `src/resolver.ts` module holds the resolver orchestration and pluggable `ResolverProvider`s (local-contact, card-file, card-URL, invite, registry-fixture, index-fixture). Providers are tried in priority order; the first non-null result wins. First-contact discovery sources (registry/index/invite) produce `approval_required` Candidates persisted to `candidates.jsonl` and never send until explicitly promoted. Trust ALWAYS flows from `validateCard` (existing crypto verification) — Index never yields an `agent_id` directly. CLI gains `resolve`, `candidates`, and resolver-backed `friend request`. A small capability-graph addition enforces explicit `blocked` denial.

**Tech Stack:** TypeScript (ESM, node20 target via tsup), `node:test` + `node:assert/strict`, no new runtime deps. Source of truth: judge-passed spec `tasks/ea/ea-openclaw-030-.../authoring-spec.md` (+ 2026-06-08 Index addendum) in the executive-assistant repo.

**Existing primitives this plan reuses (verified in `src/edge-book.ts`):**
- `loadCard(target)` — resolves `edgebook:invite:<b64>` / `https?://` / file paths to an `AgentCard`, calling `validateCard`.
- `validateCard(card)` — throws `EdgeBookError("invalid_card")` unless agent_id derives from the key AND the card self-signature verifies.
- `EdgeBookStore` methods: `file(name)`, `contacts()` → `Record<peer_agent_id, AgentContactRecord>`, `createFriendRequest(card, note?)`, `upsertContactFromCard(card, state?)`, `block(peerAgentId)`, `audit(action, peerAgentId, details)` → `Promise<string>`.
- Module helpers: `readJson<T>(file, fallback)`, `appendJsonl(file, value)`, `readJsonl<T>(file)`, `randomId(prefix)`.
- `AgentContactRecord` has `peer_agent_id`, `aliases[]`, `display_name`, `card_url`, `relationship_state`.

**Test convention:** temp homes via `fs.mkdtemp`, `new EdgeBookStore({ home })`, full friend handshake helper. See `test/grant-access.test.ts` for the idiom.

**Commit discipline:** one commit per task (TDD: test → impl → green → commit). Repo workflow lands on `main`. ⚠️ A concurrent session (openclaw) edits `edge-book.ts` for 071/072 — keep new code in `src/resolver.ts`; touch `edge-book.ts`/`cli.ts` minimally and rebase before each commit.

---

### Task 1: Resolver module scaffold + core types

**Files:**
- Create: `src/resolver.ts`
- Test: `test/resolver-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { nextAction, type ResolverResult } from "../src/resolver.ts";

test("nextAction suggests a friend request for a resolved card", () => {
  const result: ResolverResult = {
    status: "resolved",
    provenance: { source: "card_url", confidence: "high", display_name: "Bob", reason: "fetched card" },
    next_action: "",
  };
  assert.equal(nextAction(result, "https://bob.example/card"), "friend request https://bob.example/card --deliver");
});

test("nextAction tells the user to approve a candidate", () => {
  const result: ResolverResult = {
    status: "approval_required",
    candidates: [{ candidate_id: "cand_x", source: "index", confidence: "low", display_name: "Maybe Bob", reason: "index opportunity", approved: false, created_at: "2026-06-08T00:00:00.000Z" }],
    next_action: "",
  };
  assert.equal(nextAction(result, "index:op1"), "candidates list   # then: friend request cand_x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-types.test.ts`
Expected: FAIL — cannot find module `../src/resolver.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/resolver.ts
import type { AgentCard } from "./edge-book.ts";

export type ResolverStatus = "resolved" | "candidates" | "approval_required" | "not_found";
export type ProvenanceSource = "local" | "card_file" | "card_url" | "invite" | "registry" | "index";
export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  source: ProvenanceSource;
  confidence: Confidence;
  display_name: string;
  reason: string;
  network?: string;
}

export interface Candidate {
  candidate_id: string;
  source: ProvenanceSource;
  confidence: Confidence;
  display_name: string;
  reason: string;
  network?: string;
  card_url?: string;
  agent_id?: string; // absent until a real card is verified
  approved: boolean;
  created_at: string;
}

export interface ResolverResult {
  status: ResolverStatus;
  card?: AgentCard;
  agent_id?: string;
  candidates?: Candidate[];
  provenance?: Provenance;
  next_action: string;
}

export function nextAction(result: ResolverResult, target: string): string {
  switch (result.status) {
    case "resolved":
      return `friend request ${target} --deliver`;
    case "approval_required":
    case "candidates": {
      const first = result.candidates?.[0];
      return first ? `candidates list   # then: friend request ${first.candidate_id}` : "candidates list";
    }
    default:
      return "(no match — check the target)";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-types.test.ts
git commit -m "feat(resolver): module scaffold + ResolverResult/Candidate types (031)"
```

---

### Task 2: Provider interface + local-contact provider

Resolves a known contact by `agent_id`, alias, or display name. Highest priority — local trust beats any remote lookup.

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-local.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { localContactProvider } from "../src/resolver.ts";

async function befriended() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  return { alice, bobCard };
}

test("local provider resolves a known contact by agent_id", async () => {
  const { alice, bobCard } = await befriended();
  const result = await localContactProvider.resolve(alice, bobCard.agent_id);
  assert.ok(result);
  assert.equal(result.kind, "card");
  assert.equal(result.provenance.source, "local");
  assert.equal(result.agent_id, bobCard.agent_id);
});

test("local provider returns null for an unknown target", async () => {
  const { alice } = await befriended();
  assert.equal(await localContactProvider.resolve(alice, "nobody.openclaw.local"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-local.test.ts`
Expected: FAIL — `localContactProvider` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/resolver.ts`)

```typescript
import type { EdgeBookStore } from "./edge-book.ts";

export interface ProviderResult {
  kind: "card" | "candidate";
  card?: AgentCard;
  agent_id?: string;
  candidate?: Omit<Candidate, "candidate_id" | "approved" | "created_at">;
  provenance: Provenance;
}

export interface ResolverProvider {
  name: string;
  priority: number;
  resolve(store: EdgeBookStore, target: string): Promise<ProviderResult | null>;
}

export const localContactProvider: ResolverProvider = {
  name: "local",
  priority: 100,
  async resolve(store, target) {
    const contacts = await store.contacts();
    const match = Object.values(contacts).find(
      (c) =>
        c.peer_agent_id === target ||
        c.aliases.includes(target) ||
        c.display_name === target
    );
    if (!match) return null;
    return {
      kind: "card",
      agent_id: match.peer_agent_id,
      provenance: {
        source: "local",
        confidence: "high",
        display_name: match.display_name,
        reason: `known contact (relationship_state=${match.relationship_state})`,
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-local.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-local.test.ts
git commit -m "feat(resolver): provider interface + local-contact provider (031)"
```

---

### Task 3: Card providers (invite / URL / file) wrapping loadCard

`loadCard` already verifies invite/URL/file cards. Wrap it as three providers so the chain handles every direct-card target and tags provenance.

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-card.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { inviteProvider, cardFileProvider } from "../src/resolver.ts";

async function bobInviteAndCardFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-card-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  const cardPath = path.join(root, "bob-card.json");
  await fs.writeFile(cardPath, JSON.stringify(bobCard), "utf8");
  return { alice, bobCard, invite, cardPath };
}

test("invite provider resolves and verifies an invite link", async () => {
  const { alice, bobCard, invite } = await bobInviteAndCardFile();
  const result = await inviteProvider.resolve(alice, invite);
  assert.ok(result);
  assert.equal(result.kind, "card");
  assert.equal(result.card?.agent_id, bobCard.agent_id);
  assert.equal(result.provenance.source, "invite");
});

test("invite provider returns null for a non-invite target", async () => {
  const { alice } = await bobInviteAndCardFile();
  assert.equal(await inviteProvider.resolve(alice, "https://x/card"), null);
});

test("card-file provider resolves a card file path", async () => {
  const { alice, bobCard, cardPath } = await bobInviteAndCardFile();
  const result = await cardFileProvider.resolve(alice, cardPath);
  assert.equal(result?.card?.agent_id, bobCard.agent_id);
  assert.equal(result?.provenance.source, "card_file");
});

test("card-file provider rejects a forged card", async () => {
  const { alice, cardPath, bobCard } = await bobInviteAndCardFile();
  const forged = { ...bobCard, handle: "tampered.local" };
  await fs.writeFile(cardPath, JSON.stringify(forged), "utf8");
  await assert.rejects(() => cardFileProvider.resolve(alice, cardPath));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-card.test.ts`
Expected: FAIL — `inviteProvider`/`cardFileProvider` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/resolver.ts`; add `loadCard` to the import from `./edge-book.ts`)

```typescript
import { loadCard } from "./edge-book.ts";

function cardProvider(name: string, source: ProvenanceSource, match: (t: string) => boolean): ResolverProvider {
  return {
    name,
    priority: 90,
    async resolve(_store, target) {
      if (!match(target)) return null;
      const card = await loadCard(target); // validateCard runs inside; throws on forgery
      return {
        kind: "card",
        card,
        agent_id: card.agent_id,
        provenance: { source, confidence: "high", display_name: card.handle, reason: `${source} card verified` },
      };
    },
  };
}

export const inviteProvider = cardProvider("invite", "invite", (t) => t.startsWith("edgebook:invite:"));
export const cardUrlProvider = cardProvider("card_url", "card_url", (t) => /^https?:\/\//.test(t));
export const cardFileProvider = cardProvider("card_file", "card_file", (t) =>
  t.startsWith("file://") || t.startsWith("/") || t.startsWith("./") || t.endsWith(".json")
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-card.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-card.test.ts
git commit -m "feat(resolver): invite/url/file card providers over loadCard (031)"
```

---

### Task 4: Registry provider (fixture-backed handle lookup)

A registry maps a handle → card URL. No live registry; the provider takes an injected lookup function (fixture in tests, real adapter later).

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeRegistryProvider } from "../src/resolver.ts";

test("registry provider resolves handle -> card url -> verified card", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-reg-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  // fixture registry: handle -> a resolvable card target
  const provider = makeRegistryProvider(async (handle) =>
    handle === "registry:bob" ? invite : null
  );

  const result = await provider.resolve(alice, "registry:bob");
  assert.equal(result?.card?.agent_id, bobCard.agent_id);
  assert.equal(result?.provenance.source, "registry");
});

test("registry provider returns null for a non-registry target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-reg2-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local" });
  const provider = makeRegistryProvider(async () => null);
  assert.equal(await provider.resolve(alice, "https://x/card"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-registry.test.ts`
Expected: FAIL — `makeRegistryProvider` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/resolver.ts`)

```typescript
export type RegistryLookup = (handle: string) => Promise<string | null>; // returns a loadCard-able target

export function makeRegistryProvider(lookup: RegistryLookup): ResolverProvider {
  return {
    name: "registry",
    priority: 50,
    async resolve(_store, target) {
      if (!target.startsWith("registry:")) return null;
      const cardTarget = await lookup(target);
      if (!cardTarget) return null;
      const card = await loadCard(cardTarget);
      return {
        kind: "card",
        card,
        agent_id: card.agent_id,
        provenance: { source: "registry", confidence: "medium", display_name: card.handle, reason: "registry handle lookup" },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-registry.test.ts
git commit -m "feat(resolver): fixture-backed registry handle provider (031)"
```

---

### Task 5: Index provider (fixture, candidate-only)

Per the 030 Index addendum: an Index opportunity yields an `approval_required` **candidate** with provenance and (if advertised) a `card_url` from `socials.edge_book_card` — **never an agent_id, never a card** until promotion.

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeIndexProvider, INDEX_CARD_URL_FIELDS, type IndexOpportunity } from "../src/resolver.ts";

test("index provider yields a candidate-only result with no agent_id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-idx-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local" });

  const opportunity: IndexOpportunity = {
    message: "Bob is looking for an EA agent to collaborate.",
    accept_url: "https://index.example/accept/op1",
    socials: { edge_book_card: "https://bob.example/card.json" },
    network: "edgecity",
  };
  const provider = makeIndexProvider(async () => [opportunity]);

  const result = await provider.resolve(alice, "index:op1");
  assert.ok(result);
  assert.equal(result.kind, "candidate");
  assert.equal(result.provenance.source, "index");
  assert.equal(result.provenance.confidence, "low");
  assert.equal(result.candidate?.card_url, "https://bob.example/card.json");
  assert.equal(result.candidate?.agent_id, undefined, "index must NOT assert an agent_id");
});

test("INDEX_CARD_URL_FIELDS prefers edge_book_card then websites", () => {
  assert.deepEqual(INDEX_CARD_URL_FIELDS, ["edge_book_card", "website", "websites"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-index.test.ts`
Expected: FAIL — `makeIndexProvider`/`INDEX_CARD_URL_FIELDS` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/resolver.ts`)

```typescript
// Configurable per the 030 Index addendum: which open-vocab Index fields may
// carry an Edge Book card URL. Confirm with Seref; changing this is one line.
export const INDEX_CARD_URL_FIELDS = ["edge_book_card", "website", "websites"] as const;

export interface IndexOpportunity {
  message: string;
  accept_url: string;
  socials?: Record<string, string>;
  network?: string;
}

export type IndexSource = (target: string) => Promise<IndexOpportunity[]>;

function cardUrlFromSocials(socials?: Record<string, string>): string | undefined {
  if (!socials) return undefined;
  for (const field of INDEX_CARD_URL_FIELDS) {
    if (socials[field]) return socials[field];
  }
  return undefined;
}

export function makeIndexProvider(source: IndexSource): ResolverProvider {
  return {
    name: "index",
    priority: 10,
    async resolve(_store, target) {
      if (!target.startsWith("index:")) return null;
      const opportunities = await source(target);
      if (opportunities.length === 0) return null;
      const opp = opportunities[0];
      return {
        kind: "candidate",
        candidate: {
          source: "index",
          confidence: "low",
          display_name: opp.message.slice(0, 60),
          reason: opp.message,
          network: opp.network,
          card_url: cardUrlFromSocials(opp.socials),
          // agent_id intentionally omitted — trust comes only from validateCard at promotion.
        },
        provenance: { source: "index", confidence: "low", display_name: opp.message.slice(0, 60), reason: opp.message, network: opp.network },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-index.test.ts
git commit -m "feat(resolver): candidate-only index provider (fixture) (031)"
```

---

### Task 6: Candidate store (persist / list)

First-contact candidates persist to `candidates.jsonl` so a human can review and approve them across sessions.

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-candidates.test.ts`

- [ ] **Step 1 (prereq): export storage helpers + randomId from `edge-book.ts`**

In `src/edge-book.ts`, change three declarations from module-private to exported:
- `async function readJson` → `export async function readJson`
- `async function writeJson` → `export async function writeJson`
- `function randomId` → `export function randomId`

Run `npm run build` to confirm no type errors, then commit:

```bash
git add src/edge-book.ts
git commit -m "refactor(edge-book): export readJson/writeJson/randomId for resolver reuse (031)"
```

- [ ] **Step 2: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { writeCandidate, listCandidates, getCandidate } from "../src/resolver.ts";

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cand-"));
  const s = new EdgeBookStore({ home: path.join(root, "a") });
  await s.init({ handle: "a.openclaw.local" });
  return s;
}

test("writeCandidate persists and assigns an id; listCandidates reads it back", async () => {
  const s = await store();
  const cand = await writeCandidate(s, {
    source: "index", confidence: "low", display_name: "Maybe Bob", reason: "op1", card_url: "https://bob/card.json",
  });
  assert.match(cand.candidate_id, /^cand_/);
  assert.equal(cand.approved, false);
  const all = await listCandidates(s);
  assert.equal(all.length, 1);
  assert.equal((await getCandidate(s, cand.candidate_id))?.display_name, "Maybe Bob");
});

test("writeCandidate dedupes by source+card_url, keeping one entry", async () => {
  const s = await store();
  const base = { source: "index" as const, confidence: "low" as const, display_name: "Bob", reason: "op1", card_url: "https://bob/card.json" };
  await writeCandidate(s, base);
  await writeCandidate(s, base);
  assert.equal((await listCandidates(s)).length, 1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/resolver-candidates.test.ts`
Expected: FAIL — candidate-store functions not exported.

- [ ] **Step 4: Write minimal implementation** (append to `src/resolver.ts`; extend the `./edge-book.ts` import with `readJson, writeJson, randomId`)

```typescript
import { readJson, writeJson, randomId } from "./edge-book.ts";

const CANDIDATES_FILE = "candidates.json";

type CandidateInput = Omit<Candidate, "candidate_id" | "approved" | "created_at">;

function candidateKey(c: { source: ProvenanceSource; card_url?: string; agent_id?: string }): string {
  return `${c.source}:${c.card_url ?? c.agent_id ?? ""}`;
}

async function readCandidates(store: EdgeBookStore): Promise<Record<string, Candidate>> {
  return readJson<Record<string, Candidate>>(store.file(CANDIDATES_FILE), {});
}

export async function listCandidates(store: EdgeBookStore): Promise<Candidate[]> {
  return Object.values(await readCandidates(store));
}

export async function getCandidate(store: EdgeBookStore, id: string): Promise<Candidate | undefined> {
  return (await readCandidates(store))[id];
}

export async function writeCandidate(store: EdgeBookStore, input: CandidateInput): Promise<Candidate> {
  const map = await readCandidates(store);
  const existing = Object.values(map).find((c) => candidateKey(c) === candidateKey(input));
  if (existing) return existing;
  const candidate: Candidate = {
    candidate_id: randomId("cand"),
    approved: false,
    created_at: new Date().toISOString(),
    ...input,
  };
  map[candidate.candidate_id] = candidate;
  await writeJson(store.file(CANDIDATES_FILE), map);
  await store.audit("candidate.write", candidate.agent_id ?? "", { candidate_id: candidate.candidate_id, source: candidate.source });
  return candidate;
}
```

> Note: `randomId("cand")` yields `cand_<random>` (matches the test's `/^cand_/`). `new Date()` is fine — this is product code.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/resolver-candidates.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/resolver.ts test/resolver-candidates.test.ts
git commit -m "feat(resolver): candidate store (persist/list/dedupe) (031)"
```

---

### Task 7: Resolver orchestration (priority chain → ResolverResult)

Tries providers by priority; first non-null wins. `card` result → `resolved`. `candidate` result → persists candidate + `approval_required`. No provider matches → `not_found`. NEVER sends.

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { resolveTarget, defaultProviders, makeIndexProvider, listCandidates, type IndexOpportunity } from "../src/resolver.ts";

async function ctx() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolve-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  return { alice, bobCard, invite, root };
}

test("resolveTarget returns resolved+verified card for an invite", async () => {
  const { alice, bobCard, invite } = await ctx();
  const result = await resolveTarget(alice, invite, { providers: defaultProviders() });
  assert.equal(result.status, "resolved");
  assert.equal(result.card?.agent_id, bobCard.agent_id);
});

test("resolveTarget returns approval_required + persists a candidate for index", async () => {
  const { alice } = await ctx();
  const opp: IndexOpportunity = { message: "Bob wants to collaborate", accept_url: "https://i/accept", socials: { edge_book_card: "https://bob/card.json" } };
  const providers = [...defaultProviders(), makeIndexProvider(async () => [opp])];
  const result = await resolveTarget(alice, "index:op1", { providers });
  assert.equal(result.status, "approval_required");
  assert.equal(result.candidates?.[0].card_url, "https://bob/card.json");
  assert.equal(result.candidates?.[0].agent_id, undefined);
  assert.equal((await listCandidates(alice)).length, 1, "candidate persisted");
});

test("resolveTarget returns not_found when nothing matches", async () => {
  const { alice } = await ctx();
  const result = await resolveTarget(alice, "registry:ghost", { providers: defaultProviders() });
  assert.equal(result.status, "not_found");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-resolve.test.ts`
Expected: FAIL — `resolveTarget`/`defaultProviders` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/resolver.ts`)

```typescript
export function defaultProviders(registryLookup: RegistryLookup = async () => null): ResolverProvider[] {
  return [localContactProvider, inviteProvider, cardUrlProvider, cardFileProvider, makeRegistryProvider(registryLookup)];
}

export interface ResolveOptions {
  providers: ResolverProvider[];
}

export async function resolveTarget(store: EdgeBookStore, target: string, opts: ResolveOptions): Promise<ResolverResult> {
  const ordered = [...opts.providers].sort((a, b) => b.priority - a.priority);
  for (const provider of ordered) {
    const r = await provider.resolve(store, target);
    if (!r) continue;
    if (r.kind === "card") {
      const result: ResolverResult = { status: "resolved", card: r.card, agent_id: r.agent_id, provenance: r.provenance, next_action: "" };
      result.next_action = nextAction(result, target);
      return result;
    }
    // candidate
    const candidate = await writeCandidate(store, r.candidate!);
    const result: ResolverResult = { status: "approval_required", candidates: [candidate], provenance: r.provenance, next_action: "" };
    result.next_action = nextAction(result, target);
    return result;
  }
  return { status: "not_found", next_action: "(no match — check the target)" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-resolve.test.ts
git commit -m "feat(resolver): priority-chain orchestration -> ResolverResult (031)"
```

---

### Task 8: Promote candidate → verified contact (approval gate)

Promotion fetches the candidate's `card_url`, runs `validateCard` (crypto), and only then creates a friend request. No card_url or invalid card → fail closed, candidate retained.

**Files:**
- Modify: `src/resolver.ts`
- Test: `test/resolver-promote.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";
import { writeCandidate, promoteCandidate } from "../src/resolver.ts";

async function ctx() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-promote-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  return { alice, bobCard, invite };
}

test("promoteCandidate verifies the card and creates a friend request envelope", async () => {
  const { alice, bobCard, invite } = await ctx();
  const cand = await writeCandidate(alice, { source: "index", confidence: "low", display_name: "Bob", reason: "op1", card_url: invite });
  const envelope = await promoteCandidate(alice, cand.candidate_id);
  assert.equal(envelope.type, "friend_request");
  const contacts = await alice.contacts();
  assert.ok(contacts[bobCard.agent_id], "contact created after verified promotion");
});

test("promoteCandidate fails closed when the candidate has no card_url", async () => {
  const { alice } = await ctx();
  const cand = await writeCandidate(alice, { source: "index", confidence: "low", display_name: "Bob", reason: "op1" });
  await assert.rejects(
    () => promoteCandidate(alice, cand.candidate_id),
    (e) => e instanceof EdgeBookError && e.code === "candidate_not_resolvable"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-promote.test.ts`
Expected: FAIL — `promoteCandidate` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/resolver.ts`; import `EdgeBookError`, `type MessageEnvelope`)

```typescript
import { EdgeBookError, type MessageEnvelope } from "./edge-book.ts";

export async function promoteCandidate(store: EdgeBookStore, candidateId: string, note = ""): Promise<MessageEnvelope> {
  const candidate = await getCandidate(store, candidateId);
  if (!candidate) throw new EdgeBookError("unknown_candidate", `No candidate ${candidateId}`);
  if (!candidate.card_url) {
    await store.audit("candidate.denied", "", { candidate_id: candidateId, reason: "no_card_url" });
    throw new EdgeBookError("candidate_not_resolvable", "Candidate has no card_url to verify; cannot promote");
  }
  const card = await loadCard(candidate.card_url); // validateCard runs inside; throws on forgery
  const envelope = await store.createFriendRequest(card, note);
  // mark approved + record verified agent_id
  const map = await readJson<Record<string, Candidate>>(store.file(CANDIDATES_FILE), {});
  if (map[candidateId]) {
    map[candidateId].approved = true;
    map[candidateId].agent_id = card.agent_id;
    await writeJson(store.file(CANDIDATES_FILE), map);
  }
  await store.audit("candidate.promoted", card.agent_id, { candidate_id: candidateId });
  return envelope;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-promote.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver-promote.test.ts
git commit -m "feat(resolver): promote candidate -> verified contact + friend request (031)"
```

---

### Task 9: Capability graph — explicit blocked denial (030 check #3)

Today a blocked peer is denied only implicitly (state ≠ friend). Make it explicit with a distinct error + audit, on both message send and feed read.

**Files:**
- Modify: `src/edge-book.ts` (`sendPrivilegedMessage`, `visiblePostsForPeer`)
- Test: `test/grant-access.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `test/grant-access.test.ts`)

```typescript
test("message send is denied with an explicit blocked error after blocking the peer", async () => {
  const root = await tempRoot();
  const { alice, bobCard } = await befriend(root);
  await alice.block(bobCard.agent_id);
  await assert.rejects(
    () => alice.sendPrivilegedMessage(bobCard.agent_id, { text: "after block" }),
    (error) => error instanceof EdgeBookError && error.code === "blocked"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/grant-access.test.ts`
Expected: FAIL — current code throws `not_friend` (block sets state to a non-friend value), not `blocked`. (If `block` happens to leave state `friend`, the message would even send — also a fail.)

- [ ] **Step 3: Write minimal implementation**

In `sendPrivilegedMessage`, BEFORE the `relationship_state !== "friend"` check, add:

```typescript
if (contact.relationship_state === "blocked") {
  throw new EdgeBookError("blocked", `Peer ${peerAgentId} is blocked`);
}
```

Apply the identical guard in `visiblePostsForPeer` after its `contact` existence check, before the `not_friend` check.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/grant-access.test.ts`
Expected: PASS (all, including the new blocked test).

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/grant-access.test.ts
git commit -m "feat(edge-book): explicit blocked denial on message+feed (030 #3) (031)"
```

---

### Task 10: CLI — `resolve`, `candidates`, resolver-backed `friend request`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/resolver-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

test("CLI resolve verifies an invite and reports resolved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cli-resolve-"));
  const bobHome = path.join(root, "bob");
  const aliceHome = path.join(root, "alice");
  await handleCli(["init", "--home", bobHome, "--handle", "bob.openclaw.local"]);
  await handleCli(["init", "--home", aliceHome, "--handle", "alice.openclaw.local"]);
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;

  const result = await handleCli(["resolve", "--home", aliceHome, invite]);
  const json = result.json as { status: string; agent_id?: string };
  assert.equal(json.status, "resolved");
  assert.equal(json.agent_id, bobCard.agent_id);
});

test("CLI candidates list is empty on a fresh store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cli-cand-"));
  await handleCli(["init", "--home", root, "--handle", "a.openclaw.local"]);
  const result = await handleCli(["candidates", "list", "--home", root]);
  assert.deepEqual((result.json as { candidates: unknown[] }).candidates, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver-cli.test.ts`
Expected: FAIL — `resolve`/`candidates` commands unhandled (returns help/error).

- [ ] **Step 3: Write minimal implementation** (add to `src/cli.ts`; `store`, `home`, `requireArg` already exist in scope — mirror the `friend` block)

```typescript
import { resolveTarget, defaultProviders, listCandidates, promoteCandidate, getCandidate } from "./resolver.ts";

// ... inside handleCli, alongside the other `if (command === ...)` blocks:

if (command === "resolve") {
  const target = requireArg(args.shift(), "target");
  const result = await resolveTarget(store, target, { providers: defaultProviders() });
  return { text: `${result.status}  ${result.agent_id ?? result.candidates?.[0]?.candidate_id ?? ""}\nnext: ${result.next_action}`, json: result };
}

if (command === "candidates") {
  const action = args.shift() || "list";
  if (action === "list") {
    const candidates = await listCandidates(store);
    const text = candidates.length
      ? candidates.map((c) => `${c.candidate_id}  ${c.source}  ${c.display_name}  ${c.approved ? "[approved]" : ""}`).join("\n")
      : "No candidates.";
    return { text, json: { candidates } };
  }
}
```

Then route `friend request` through the resolver for non-card targets. In the `friend request` handler, replace `const card = await loadCard(target);` with:

```typescript
let card: AgentCard;
const existing = await getCandidate(store, target);
if (existing || target.startsWith("cand_")) {
  // approved-candidate path: promote (fetches + verifies the card, creates the request)
  const envelope = await promoteCandidate(store, target);
  if (deliver) { /* existing deliver branch, reusing `envelope` */ }
  return { text: JSON.stringify(envelope, null, 2), json: envelope };
}
card = await loadCard(target); // unchanged for direct card targets
```

> **Implementation note:** keep the existing `--deliver` mailbox/relay/direct branch intact; the candidate path produces the same `friend_request` envelope, so reuse that delivery code (extract it into a local `deliverFriendRequest(card, envelope)` helper if it reduces duplication). `AgentCard` is already imported in `cli.ts`; if not, add it to the `edge-book.ts` import.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolver-cli.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/resolver-cli.test.ts
git commit -m "feat(cli): resolve + candidates commands, resolver-backed friend request (031)"
```

---

### Task 11: Full-suite green + build + version bump

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Run the full suite**

Run: `node --test test/*.test.ts`
Expected: ALL PASS (existing + ~17 new resolver tests). Fix any regression before proceeding.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `Build success`, no type errors.

- [ ] **Step 3: Bump version**

Edit `package.json` `version` (e.g. `0.4.x → 0.5.0` — minor: new resolver surface).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(edge-book): bump to 0.5.0 — resolver + candidate store (031)"
```

> **Do NOT `npm publish`** without Antony's go-ahead (publish runbook: `08-knowledge/resources/2026-06-01-edge-book-npm-publish-runbook.md`).

---

## Deferred (NOT in this plan — tracked separately)

- **Live Index/registry adapters** — only fixture sources here. Live Index needs the `ix_` key + Seref's confirmation of the durable `socials.edge_book_card` field (see [[ea-claude-048-hermes-interop-spec]]).
- **object.read grant signature verification** — same one-liner as 031 Pass 1, deferred earlier; fold into a follow-up.
- **Hosted candidate-review UI** — CLI-only here.
- **Ambiguous multi-match `candidates` status** — the spec distinguishes `candidates` (multiple plausible matches) from `approval_required` (single first-contact). This plan implements `approval_required` (the Index case) and `resolved`/`not_found`; no provider here returns multiple matches, so the multi-match `candidates` branch is unused. Add it when a provider (e.g. fuzzy registry search) can return >1 hit. The `ResolverResult.candidates` array already accommodates it.
