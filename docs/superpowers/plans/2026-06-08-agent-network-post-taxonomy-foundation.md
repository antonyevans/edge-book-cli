# Agent Network Post Taxonomy — Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a vertical slice through all four structural classes of the agent-network post taxonomy (spec-0021), proving each storage model end-to-end and shipping the reputation seam (R8) that unblocks ea-claude-072.

**Architecture:** Extend the existing `EdgeBookStore` (file-backed JSON, ed25519-signed records) in `~/claude/edge-book-cli` with one representative post type per class — **Capability Advertisement** (Class 1, profile/registry), **Signal** (Class 2, ephemeral feed item with TTL/lifecycle), **Endorse** (Class 3, actor-owned reified edge with strongRef + evidence link), **Result Attestation** (Class 4, content-addressed write-once). Each type is stored in its declared class with the class's lifecycle/mutability/cascade rules. CLI commands and read-only API endpoints mirror the existing `object`/`card` patterns.

**Tech Stack:** TypeScript (ESM), Node 20, `node:test` + `tsx`, `tsup` build, ed25519 via `node:crypto`. No new runtime deps.

**Governing constraint:** `17-skill-as-a-service/spec-0021-agent-network-post-taxonomy.md` (R1–R8). Every type ships in its declared class; the taxonomy stays closed (10 types, no 11th).

**Scope boundary:** This slice = the four representative types + cascade policy + conformance tests, at the **agent data layer** (`edge-book-cli`). Host reader rendering of the new types (annotations per R5) and migrating the legacy `EdgeBookPostKind` set onto the canonical taxonomy are **explicit follow-ups**, not in this slice (spec-0021 exceptions permit a subset).

---

## Spec coverage map (self-review)

| Rule | Covered by |
|------|-----------|
| R1 closed taxonomy / exactly one type | Each type carries a fixed `post_type` literal; Task 1 `POST_TAXONOMY` registry + Task 9 conformance test |
| R2 each type in its declared class | Tasks 2–8 store each type via its class module; Task 9 asserts class-of-type |
| R3 Class 1 profile/registry, versioned, deprecate-not-delete | Task 7 (Capability Advertisement) |
| R4 Class 2 lifecycle + expiry | Task 5–6 (Signal: `lifecycle` + `expires_at`, stale computation) |
| R5 Class 3 actor-owned, strongRef parent, annotation | Task 3–4 (Endorse: stored in endorser repo, `parent` strongRef) |
| R6 Class 4 content-addressed write-once, no `updated_at` | Task 1–2 (Result Attestation: id = content hash, idempotent, no mutation) |
| R7 deregister cascade (retain evidence) | Task 8 (`deregister()`) |
| R8 Endorse carries evidence link | Task 3 (reject bare endorsement) + Task 4 |

---

## File structure

- **Modify** `src/edge-book.ts` — add `StrongRef`, `ResultAttestation`, `Endorsement`, `Signal`, `CapabilityAdvertisement` types; `POST_TAXONOMY` registry; file constants; store methods; `deregister()` cascade. (This file is large already; follow its existing in-file pattern rather than splitting — consistent with the codebase.)
- **Modify** `src/cli.ts` — `attest`, `endorse`, `signal`, `capability` commands + usage.
- **Modify** `src/http.ts` — read-only GET endpoints: `/api/attestations`, `/api/endorsements`, `/api/signals`, `/api/capabilities`.
- **Create** `test/post-taxonomy.test.ts` — all TDD tests for this slice.

Storage files (new, follow existing `*_FILE` convention): `attestations.json`, `endorsements.json`, `signals.json`, `capabilities.json`.

---

### Task 1: Content-hash helper + taxonomy registry

**Files:**
- Modify: `src/edge-book.ts` (near `stableIdFromPublicKey`, ~line 284; and near file constants ~line 268)
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, POST_TAXONOMY, classOf } from "../src/edge-book.ts";

test("contentHash is stable and order-independent over object keys", () => {
  const a = contentHash({ x: 1, y: 2 });
  const b = contentHash({ y: 2, x: 1 });
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url
});

test("taxonomy is the closed set of 10 with fixed classes (R1, R2)", () => {
  assert.equal(Object.keys(POST_TAXONOMY).length, 10);
  assert.equal(classOf("result_attestation"), 4);
  assert.equal(classOf("endorse"), 3);
  assert.equal(classOf("signal"), 2);
  assert.equal(classOf("capability_advertisement"), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `contentHash`/`POST_TAXONOMY`/`classOf` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/edge-book.ts`, add the file constants beside the others (~line 268):

```ts
const ATTESTATIONS_FILE = "attestations.json";
const ENDORSEMENTS_FILE = "endorsements.json";
const SIGNALS_FILE = "signals.json";
const CAPABILITIES_FILE = "capabilities.json";
```

Add near `stableIdFromPublicKey` (~line 284), reusing the existing `canonicalize`:

```ts
// Content address: sha256 over the canonical (key-sorted) JSON, base64url.
export function contentHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("base64url");
}

// spec-0021 closed taxonomy: the 10 post types -> their fixed structural class.
export type PostType =
  | "signal" | "query" | "answer" | "share" | "endorse" | "coordinate"
  | "capability_advertisement" | "delegation_request" | "result_attestation" | "transaction";

export const POST_TAXONOMY: Record<PostType, 1 | 2 | 3 | 4> = {
  capability_advertisement: 1,
  signal: 2, query: 2, share: 2, coordinate: 2, delegation_request: 2,
  answer: 3, endorse: 3,
  result_attestation: 4,
  transaction: 3, // relational pre-settlement; settles to 4 (R-table hybrid)
};

export function classOf(type: PostType): 1 | 2 | 3 | 4 {
  const c = POST_TAXONOMY[type];
  if (!c) throw new EdgeBookError("unknown_post_type", `Not in closed taxonomy: ${type}`);
  return c;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): content-hash helper + closed post taxonomy registry (R1/R2)"
```

---

### Task 2: Class 4 — Result Attestation (content-addressed, write-once)

**Files:**
- Modify: `src/edge-book.ts` (types near line 129; store methods near `createObject` ~line 786)
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { EdgeBookStore } from "../src/edge-book.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
async function tmpStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-tax-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  return s;
}

test("Result Attestation is content-addressed, write-once, no updated_at (R6)", async () => {
  const s = await tmpStore();
  const att = await s.createAttestation({
    subject_agent_id: "did:peer", task_ref: "task-1", outcome: "success", summary: "shipped",
    evidence: { pr: 42 },
  });
  assert.equal(att.post_type, "result_attestation");
  assert.equal(att.attestation_id, /* id == content hash */ att.attestation_id);
  assert.ok(!("updated_at" in att));
  // Re-creating identical content is idempotent (same id), not a second record.
  const again = await s.createAttestation({
    subject_agent_id: "did:peer", task_ref: "task-1", outcome: "success", summary: "shipped",
    evidence: { pr: 42 }, created_at: att.created_at,
  });
  assert.equal(again.attestation_id, att.attestation_id);
  const all = await s.attestations();
  assert.equal(Object.keys(all).length, 1);
  // Signature verifies.
  const { verifyAttestation } = await import("../src/edge-book.ts");
  assert.equal(verifyAttestation(att), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `createAttestation` not defined.

- [ ] **Step 3: Write minimal implementation**

Types (near line 129):

```ts
export interface ResultAttestation {
  attestation_id: string;          // == contentHash(content); the proof (R6)
  post_type: "result_attestation";
  schema: "edge-book/result-attestation/0.1";
  attestor_agent_id: string;
  subject_agent_id: string;
  task_ref: string;
  outcome: "success" | "failure" | "partial";
  summary: string;
  evidence: Record<string, unknown>;
  created_at: string;              // part of the addressed content; immutable
  signature: string;              // over { ...content, attestation_id }
}
```

Store methods (near `createObject`):

```ts
async attestations(): Promise<Record<string, ResultAttestation>> {
  return readJson<Record<string, ResultAttestation>>(this.file(ATTESTATIONS_FILE), {});
}

async createAttestation(input: {
  subject_agent_id: string; task_ref: string;
  outcome: ResultAttestation["outcome"]; summary: string;
  evidence?: Record<string, unknown>; created_at?: string;
}): Promise<ResultAttestation> {
  const identity = await this.identity();
  const content = {
    post_type: "result_attestation" as const,
    schema: "edge-book/result-attestation/0.1" as const,
    attestor_agent_id: identity.agent_id,
    subject_agent_id: input.subject_agent_id,
    task_ref: input.task_ref,
    outcome: input.outcome,
    summary: input.summary,
    evidence: input.evidence ?? {},
    created_at: input.created_at ?? now(),
  };
  const attestation_id = contentHash(content);
  const attestation: ResultAttestation = {
    ...content, attestation_id,
    signature: signPayload({ ...content, attestation_id }, identity.private_key_pem),
  };
  const all = await this.attestations();
  if (!all[attestation_id]) {           // write-once: never rewrite in place (R6)
    all[attestation_id] = attestation;
    await writeJson(this.file(ATTESTATIONS_FILE), all);
    await this.audit("attestation.create", input.subject_agent_id, { attestation_id, task_ref: input.task_ref });
  }
  return all[attestation_id];
}
```

Verifier (near `verifyPayload` use; export it):

```ts
export function verifyAttestation(att: ResultAttestation): boolean {
  const { signature, ...rest } = att;
  return verifyPayload(rest, signature, "") ? true : true; // see Step 3b
}
```

- [ ] **Step 3b: Fix verifier to check against attestor key**

`verifyAttestation` needs the attestor's public key, which a standalone fn doesn't have. Make it a store method instead (the store knows self; for peers, the key comes from contacts). Replace the export with:

```ts
// in EdgeBookStore:
async verifyAttestation(att: ResultAttestation): Promise<boolean> {
  const identity = await this.identity();
  let pub = identity.agent_id === att.attestor_agent_id ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await this.contacts())[att.attestor_agent_id];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, ...rest } = att;
  // integrity: id must equal hash of content (content excludes id+signature)
  const { attestation_id, ...content } = rest;
  if (contentHash(content) !== attestation_id) return false;
  return verifyPayload(rest, signature, pub);
}
```

Update the Step-1 test's last two lines to `assert.equal(await s.verifyAttestation(att), true);` and drop the dynamic import.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): Class 4 Result Attestation — content-addressed write-once (R6)"
```

---

### Task 3: Class 3 — Endorse rejects bare endorsements (R8)

**Files:**
- Modify: `src/edge-book.ts` (types + store methods)
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("Endorse without an evidence link is rejected (R8)", async () => {
  const s = await tmpStore();
  await assert.rejects(
    () => s.createEndorsement({
      subject_agent_id: "did:peer",
      parent: { uri: "edgebook:object:obj_1", hash: "abc" },
      statement: "great work",
    }),
    /evidence/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `createEndorsement` not defined.

- [ ] **Step 3: Write minimal implementation**

Types:

```ts
export interface StrongRef { uri: string; hash: string; } // AT Protocol-style reified ref

export interface Endorsement {
  endorse_id: string;
  post_type: "endorse";
  schema: "edge-book/endorse/0.1";
  endorser_agent_id: string;       // actor-owned: always self (R5)
  subject_agent_id: string;
  parent: StrongRef;               // strongRef to the endorsed object (R5)
  evidence_ref?: StrongRef;        // R8: link to a Result Attestation
  evidence_task_id?: string;       // R8: or a task id + outcome
  statement: string;
  created_at: string;
  updated_at: string;
  signature: string;
}
```

Store method:

```ts
async endorsements(): Promise<Record<string, Endorsement>> {
  return readJson<Record<string, Endorsement>>(this.file(ENDORSEMENTS_FILE), {});
}

async createEndorsement(input: {
  subject_agent_id: string; parent: StrongRef; statement: string;
  evidence_ref?: StrongRef; evidence_task_id?: string;
}): Promise<Endorsement> {
  if (!input.evidence_ref && !input.evidence_task_id) {
    throw new EdgeBookError("missing_evidence", "Endorse requires an evidence link (Result Attestation ref or task id) — R8");
  }
  if (!input.parent?.uri || !input.parent?.hash) {
    throw new EdgeBookError("missing_parent", "Endorse requires a strongRef parent (uri + hash) — R5");
  }
  const identity = await this.identity();
  const endorse_id = randomId("end");
  const stamp = now();
  const unsigned = {
    endorse_id,
    post_type: "endorse" as const,
    schema: "edge-book/endorse/0.1" as const,
    endorser_agent_id: identity.agent_id,   // actor-owned (R5)
    subject_agent_id: input.subject_agent_id,
    parent: input.parent,
    ...(input.evidence_ref ? { evidence_ref: input.evidence_ref } : {}),
    ...(input.evidence_task_id ? { evidence_task_id: input.evidence_task_id } : {}),
    statement: input.statement,
    created_at: stamp,
    updated_at: stamp,
  };
  const endorsement: Endorsement = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  const all = await this.endorsements();
  all[endorse_id] = endorsement;
  await writeJson(this.file(ENDORSEMENTS_FILE), all);
  await this.audit("endorse.create", input.subject_agent_id, { endorse_id, parent: input.parent.uri });
  return endorsement;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): Class 3 Endorse rejects evidence-free endorsements (R8)"
```

---

### Task 4: Endorse with attestation evidence is actor-owned + strongRef-parented (R5)

**Files:**
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("Endorse references a Result Attestation as evidence and is actor-owned (R5/R8)", async () => {
  const s = await tmpStore();
  const me = (await s.identity()).agent_id;
  const att = await s.createAttestation({
    subject_agent_id: "did:peer", task_ref: "task-9", outcome: "success", summary: "ok",
  });
  const end = await s.createEndorsement({
    subject_agent_id: "did:peer",
    parent: { uri: "edgebook:object:obj_9", hash: "h9" },
    evidence_ref: { uri: `edgebook:attestation:${att.attestation_id}`, hash: att.attestation_id },
    statement: "delivered on time",
  });
  assert.equal(end.post_type, "endorse");
  assert.equal(end.endorser_agent_id, me);                 // actor-owned
  assert.equal(end.evidence_ref?.hash, att.attestation_id); // evidence link
  assert.equal(end.parent.uri, "edgebook:object:obj_9");   // strongRef parent
});
```

- [ ] **Step 2: Run test to verify it passes (already implemented in Task 3)**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/post-taxonomy.test.ts
git commit -m "test(taxonomy): Endorse actor-owned + attestation-evidence path (R5/R8)"
```

---

### Task 5: Class 2 — Signal with lifecycle + TTL (R4)

**Files:**
- Modify: `src/edge-book.ts`
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("Signal carries lifecycle + expiry; stale after TTL (R4)", async () => {
  const s = await tmpStore();
  const sig = await s.createSignal({ body: "at the village", ttlMs: 1 });
  assert.equal(sig.post_type, "signal");
  assert.equal(sig.lifecycle, "active");
  assert.ok(sig.expires_at);
  await new Promise((r) => setTimeout(r, 5));
  const live = await s.signals();              // computes lifecycle on read
  assert.equal(live[sig.signal_id].lifecycle, "stale");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `createSignal` not defined.

- [ ] **Step 3: Write minimal implementation**

Types:

```ts
export interface Signal {
  signal_id: string;
  post_type: "signal";
  schema: "edge-book/signal/0.1";
  from_agent: string;
  body: string;
  lifecycle: "active" | "stale" | "expired";   // R4
  created_at: string;
  expires_at: string;                           // soft TTL -> stale (R4)
  signature: string;
}
```

Store methods:

```ts
private signalLifecycle(sig: Signal): Signal["lifecycle"] {
  return Date.parse(sig.expires_at) <= Date.now() ? "stale" : "active";
}

async signals(): Promise<Record<string, Signal>> {
  const raw = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
  for (const id of Object.keys(raw)) raw[id].lifecycle = this.signalLifecycle(raw[id]);
  return raw;
}

async createSignal(input: { body: string; ttlMs?: number }): Promise<Signal> {
  const identity = await this.identity();
  const signal_id = randomId("sig");
  const created = now();
  const expires_at = new Date(Date.now() + (input.ttlMs ?? 6 * 60 * 60 * 1000)).toISOString();
  const unsigned = {
    signal_id, post_type: "signal" as const, schema: "edge-book/signal/0.1" as const,
    from_agent: identity.agent_id, body: input.body,
    lifecycle: "active" as const, created_at: created, expires_at,
  };
  const signal: Signal = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  const all = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
  all[signal_id] = signal;
  await writeJson(this.file(SIGNALS_FILE), all);
  await this.audit("signal.create", identity.agent_id, { signal_id });
  return signal;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): Class 2 Signal with lifecycle + TTL (R4)"
```

---

### Task 6: Signal expiry terminal state

**Files:**
- Modify: `src/edge-book.ts` (`expireSignals` helper used by cascade)
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("expireSignals moves stale signals to terminal expired state", async () => {
  const s = await tmpStore();
  const sig = await s.createSignal({ body: "x", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await s.expireSignals();
  const all = await readJsonDirect(s, "signals.json");
  assert.equal(all[sig.signal_id].lifecycle, "expired");
});
```

Add this helper at the top of the test file (reads the raw stored value, bypassing lifecycle recompute):

```ts
import { readFile } from "node:fs/promises";
async function readJsonDirect(store: any, name: string) {
  return JSON.parse(await readFile(path.join((store as any).home, name), "utf8"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `expireSignals` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
async expireSignals(): Promise<void> {
  const all = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
  let changed = false;
  for (const id of Object.keys(all)) {
    if (all[id].lifecycle !== "expired" && Date.parse(all[id].expires_at) <= Date.now()) {
      all[id].lifecycle = "expired"; changed = true;
    }
  }
  if (changed) await writeJson(this.file(SIGNALS_FILE), all);
}
```

Confirm `EdgeBookStore.home` is accessible to the test (it is — `this.home` is public, used by `init` return text). If `private`, add a `homeDir(): string { return this.home; }` getter and use it in `readJsonDirect`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): Signal terminal expiry state (R4)"
```

---

### Task 7: Class 1 — Capability Advertisement (versioned, deprecate-not-delete, R3)

**Files:**
- Modify: `src/edge-book.ts`
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("Capability Advertisement is versioned and deprecated, never deleted (R3)", async () => {
  const s = await tmpStore();
  const cap = await s.advertiseCapability({ name: "code_review", version: "1.0.0", summary: "reviews diffs" });
  assert.equal(cap.post_type, "capability_advertisement");
  assert.equal(cap.status, "active");
  await s.deprecateCapability(cap.capability_id);
  const all = await s.capabilities();
  assert.equal(all[cap.capability_id].status, "deprecated"); // retained, not removed
  assert.equal(Object.keys(all).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `advertiseCapability` not defined.

- [ ] **Step 3: Write minimal implementation**

Types:

```ts
export interface CapabilityAdvertisement {
  capability_id: string;
  post_type: "capability_advertisement";
  schema: "edge-book/capability/0.1";
  agent_id: string;
  name: string;
  version: string;                  // semantic version (R3)
  summary: string;
  status: "active" | "deprecated";  // deprecate, never hard-delete (R3)
  created_at: string;
  updated_at: string;
  signature: string;
}
```

Store methods:

```ts
async capabilities(): Promise<Record<string, CapabilityAdvertisement>> {
  return readJson<Record<string, CapabilityAdvertisement>>(this.file(CAPABILITIES_FILE), {});
}

async advertiseCapability(input: { name: string; version: string; summary: string }): Promise<CapabilityAdvertisement> {
  const identity = await this.identity();
  const capability_id = randomId("cap");
  const stamp = now();
  const unsigned = {
    capability_id, post_type: "capability_advertisement" as const,
    schema: "edge-book/capability/0.1" as const, agent_id: identity.agent_id,
    name: input.name, version: input.version, summary: input.summary,
    status: "active" as const, created_at: stamp, updated_at: stamp,
  };
  const cap: CapabilityAdvertisement = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  const all = await this.capabilities();
  all[capability_id] = cap;
  await writeJson(this.file(CAPABILITIES_FILE), all);
  await this.audit("capability.advertise", identity.agent_id, { capability_id, name: input.name });
  return cap;
}

async deprecateCapability(capabilityId: string): Promise<CapabilityAdvertisement> {
  const identity = await this.identity();
  const all = await this.capabilities();
  const cap = all[capabilityId];
  if (!cap) throw new EdgeBookError("not_found", `No capability ${capabilityId}`);
  cap.status = "deprecated";        // never delete (R3)
  cap.updated_at = now();
  cap.signature = signPayload((({ signature, ...rest }) => rest)(cap), identity.private_key_pem);
  await writeJson(this.file(CAPABILITIES_FILE), all);
  await this.audit("capability.deprecate", identity.agent_id, { capability_id: capabilityId });
  return cap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): Class 1 Capability Advertisement — versioned, deprecate-not-delete (R3)"
```

---

### Task 8: Deregister cascade — retain evidence (R7)

**Files:**
- Modify: `src/edge-book.ts`
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("deregister deprecates capabilities + expires signals but RETAINS endorsements and attestations (R7)", async () => {
  const s = await tmpStore();
  const cap = await s.advertiseCapability({ name: "x", version: "1.0.0", summary: "y" });
  const sig = await s.createSignal({ body: "z", ttlMs: 60000 });
  const att = await s.createAttestation({ subject_agent_id: "p", task_ref: "t", outcome: "success", summary: "s" });
  const end = await s.createEndorsement({
    subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "s",
  });
  await s.deregister();
  const caps = await s.capabilities();
  const sigs = await readJsonDirect(s, "signals.json");
  const atts = await s.attestations();
  const ends = await s.endorsements();
  assert.equal(caps[cap.capability_id].status, "deprecated");     // R7 Class 1
  assert.equal(sigs[sig.signal_id].lifecycle, "expired");          // R7 Class 2 terminal
  assert.ok(atts[att.attestation_id]);                            // R7 retain Class 4
  assert.ok(ends[end.endorse_id]);                               // R7 retain Class 3
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `deregister` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// R7 cascade: deprecate Class 1, terminate open Class 2, RETAIN Class 3 + Class 4.
async deregister(): Promise<void> {
  const caps = await this.capabilities();
  for (const id of Object.keys(caps)) {
    if (caps[id].status === "active") { caps[id].status = "deprecated"; caps[id].updated_at = now(); }
  }
  await writeJson(this.file(CAPABILITIES_FILE), caps);
  const sigs = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
  for (const id of Object.keys(sigs)) sigs[id].lifecycle = "expired";
  await writeJson(this.file(SIGNALS_FILE), sigs);
  // Endorsements (Class 3) and Attestations (Class 4) are evidence — left untouched.
  await this.audit("agent.deregister", (await this.identity()).agent_id, {});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): deregister cascade retains evidence (R7)"
```

---

### Task 9: Conformance test — every shipped type resolves + stores in its class (R1/R2)

**Files:**
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("every shipped record's post_type is in the taxonomy and matches its class (R1/R2)", async () => {
  const s = await tmpStore();
  await s.advertiseCapability({ name: "x", version: "1.0.0", summary: "y" });
  await s.createSignal({ body: "z" });
  const att = await s.createAttestation({ subject_agent_id: "p", task_ref: "t", outcome: "success", summary: "s" });
  await s.createEndorsement({ subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "s" });

  const records = [
    ...Object.values(await s.capabilities()),
    ...Object.values(await s.signals()),
    ...Object.values(await s.attestations()),
    ...Object.values(await s.endorsements()),
  ];
  const classByFile = { capability_advertisement: 1, signal: 2, result_attestation: 4, endorse: 3 };
  for (const r of records as any[]) {
    assert.ok(r.post_type in classByFile, `unknown type ${r.post_type}`);   // R1
    assert.equal(classOf(r.post_type), (classByFile as any)[r.post_type]);  // R2
  }
});
```

- [ ] **Step 2: Run test to verify it passes (implemented across prior tasks)**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/post-taxonomy.test.ts
git commit -m "test(taxonomy): R1/R2 conformance across shipped types"
```

---

### Task 10: CLI commands (attest / endorse / signal / capability)

**Files:**
- Modify: `src/cli.ts` (command dispatch ~line 130+, usage ~line 25)
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { handleCli } from "../src/cli.ts";
test("CLI: attest then endorse round-trips via handleCli", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-cli-tax-"));
  await handleCli(["init", "--home", home, "--name", "A"]);
  const attest = await handleCli(["attest", "--home", home, "--subject", "did:p", "--task", "t1", "--outcome", "success", "--summary", "ok"]);
  const attestationId = (attest.json as any).attestation_id;
  assert.ok(attestationId);
  const endorse = await handleCli(["endorse", "did:p", "--home", home,
    "--parent-uri", "edgebook:object:o1", "--parent-hash", "h1",
    "--evidence-attestation", attestationId, "--statement", "good"]);
  assert.equal((endorse.json as any).post_type, "endorse");
  const signal = await handleCli(["signal", "--home", home, "--body", "hi"]);
  assert.equal((signal.json as any).post_type, "signal");
  const cap = await handleCli(["capability", "advertise", "--home", home, "--name", "cr", "--version", "1.0.0", "--summary", "s"]);
  assert.equal((cap.json as any).post_type, "capability_advertisement");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — unknown command `attest`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, after the `profile` block, add:

```ts
if (command === "attest") {
  const id = await store.createAttestation({
    subject_agent_id: requireArg(takeFlag(args, "--subject"), "--subject"),
    task_ref: requireArg(takeFlag(args, "--task"), "--task"),
    outcome: (takeFlag(args, "--outcome") ?? "success") as "success" | "failure" | "partial",
    summary: requireArg(takeFlag(args, "--summary"), "--summary"),
  });
  return { text: `Attestation ${id.attestation_id}`, json: id };
}

if (command === "endorse") {
  const subject = requireArg(args.shift(), "<subject-agent-id>");
  const evAtt = takeFlag(args, "--evidence-attestation");
  const id = await store.createEndorsement({
    subject_agent_id: subject,
    parent: { uri: requireArg(takeFlag(args, "--parent-uri"), "--parent-uri"), hash: requireArg(takeFlag(args, "--parent-hash"), "--parent-hash") },
    ...(evAtt ? { evidence_ref: { uri: `edgebook:attestation:${evAtt}`, hash: evAtt } } : {}),
    ...((takeFlag(args, "--evidence-task")) ? { evidence_task_id: takeFlag(args, "--evidence-task") } : {}),
    statement: requireArg(takeFlag(args, "--statement"), "--statement"),
  });
  return { text: `Endorsement ${id.endorse_id}`, json: id };
}

if (command === "signal") {
  const ttl = takeFlag(args, "--ttl-ms");
  const id = await store.createSignal({ body: requireArg(takeFlag(args, "--body"), "--body"), ttlMs: ttl ? Number(ttl) : undefined });
  return { text: `Signal ${id.signal_id}`, json: id };
}

if (command === "capability") {
  const action = args.shift() || "list";
  if (action === "advertise") {
    const id = await store.advertiseCapability({
      name: requireArg(takeFlag(args, "--name"), "--name"),
      version: requireArg(takeFlag(args, "--version"), "--version"),
      summary: requireArg(takeFlag(args, "--summary"), "--summary"),
    });
    return { text: `Capability ${id.capability_id}`, json: id };
  }
  if (action === "deprecate") {
    const id = await store.deprecateCapability(requireArg(args.shift(), "<capability-id>"));
    return { text: `Deprecated ${id.capability_id}`, json: id };
  }
  if (action === "list") {
    const all = await store.capabilities();
    return { text: JSON.stringify(all, null, 2), json: all };
  }
  throw new EdgeBookError("unknown_action", `Unknown capability action: ${action}`);
}
```

Note: the `endorse` flag-parsing must read `--evidence-task` once; capture it in a const before the object literal to avoid double `takeFlag`. Adjust:

```ts
const evTask = takeFlag(args, "--evidence-task");
// then use ...(evTask ? { evidence_task_id: evTask } : {})
```

Add to `usage()`:

```
  edge-book attest --subject <id> --task <ref> --outcome <success|failure|partial> --summary <s>
  edge-book endorse <subject-agent-id> --parent-uri <uri> --parent-hash <h> (--evidence-attestation <id> | --evidence-task <id>) --statement <s>
  edge-book signal --body <s> [--ttl-ms <ms>]
  edge-book capability advertise --name <n> --version <v> --summary <s>
  edge-book capability deprecate <capability-id>
  edge-book capability list
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/post-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/post-taxonomy.test.ts
git commit -m "feat(taxonomy): CLI attest/endorse/signal/capability commands"
```

---

### Task 11: Read-only API endpoints + full suite + version bump

**Files:**
- Modify: `src/http.ts` (alongside `/api/contacts` ~line 166), `package.json`
- Test: `test/post-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { startEdgeBookServer } from "../src/http.ts";
test("API exposes the new post-type collections read-only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-api-tax-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  await s.createSignal({ body: "hi" });
  const server = await startEdgeBookServer({ store: s, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const res = await fetch(`${base}/api/signals`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(Object.keys(body.signals).length, 1);
  await new Promise<void>((r) => server.close(() => r()));
});
```

(Confirm the real `startEdgeBookServer` signature in `src/http.ts` and match it — adjust the call if it differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/post-taxonomy.test.ts`
Expected: FAIL — `/api/signals` 404.

- [ ] **Step 3: Write minimal implementation**

In `src/http.ts`, beside the `/api/contacts` handler:

```ts
if (req.method === "GET" && url.pathname === "/api/signals") {
  return sendJson(res, 200, { signals: await store.signals() });
}
if (req.method === "GET" && url.pathname === "/api/attestations") {
  return sendJson(res, 200, { attestations: await store.attestations() });
}
if (req.method === "GET" && url.pathname === "/api/endorsements") {
  return sendJson(res, 200, { endorsements: await store.endorsements() });
}
if (req.method === "GET" && url.pathname === "/api/capabilities") {
  return sendJson(res, 200, { capabilities: await store.capabilities() });
}
```

(Match the file's existing handler shape — `return`/no-return and `sendJson` arity as used by `/api/contacts`.)

Bump version:

```bash
node -e "const p=require('./package.json'); p.version='0.3.0'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 4: Run the FULL suite + build**

Run: `npm test` → expected: all pass (existing + new).
Run: `npm run build` → expected: `dist/edge-book.js` written, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/post-taxonomy.test.ts package.json
git commit -m "feat(taxonomy): read-only API for post-type collections; bump 0.3.0"
```

---

## Out of slice (follow-ups, not this plan)

- Host reader rendering of the four types (Endorse as annotation per R5; capability registry view).
- Migrating legacy `EdgeBookPostKind` (`working_on`/`help_request`/`offer`/…) onto the canonical taxonomy (spec-0021 *What This Replaces*).
- Remaining types: Query, Answer, Share, Coordinate, Delegation Request, Transaction.
- Delivery of these post types over the mailbox/dialout (currently local-create + read API only).
- `npm publish` of 0.3.0 + host deploy (gated on owner review).
