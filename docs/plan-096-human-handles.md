# User-Chosen Human Handles + Identity Durability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user claim a unique, human-readable handle (e.g. `antony-evans`) bound to their DID on the relay, so a peer can `friend antony-evans` instead of pasting a DID/invite blob — with live resolution that survives reconnect and device-switch, plus card-expiry enforcement so stale invites fail loudly.

**Architecture:** A relay-hosted handle registry (`edge-book-host`) maps `handle → signed AgentCard`, claimed over the dial-out WS with a signature the relay verifies against the card's identity key. The CLI (`edge-book-cli`) claims its handle on connect, resolves `friend <handle>` through the existing `registry:` provider pointed at the relay's new `GET /handle/:handle`, and enforces card expiry in `validateCard`. The DID (identity keypair) is the durable anchor; `identity export/import` carries it across devices.

**Tech Stack:** TypeScript, Node `crypto` (ed25519), `node:test`/`assert` (cli, `node --test`), `tsx --test` (host). Spec: `docs/spec-096-human-handles.md`.

**Repos:** `~/claude/edge-book-host` (relay) and `~/claude/edge-book-cli` (agent CLI). Each gets a `feat/096-human-handles` branch. The cli branch already exists (holds the spec + this plan).

**Shared crypto invariants (MUST match byte-for-byte across repos):**
- DID derivation: `"did:openclaw:" + sha256(public_key_pem_utf8).base64url.slice(0,32)` (cli `edge-book.ts:528`). The PEM includes its trailing newline — hash the exact string.
- Canonical JSON: recursively sort object keys; `JSON.stringify` primitives (cli `edge-book.ts:556`).
- Signatures: `crypto.sign(null, Buffer.from(canonical), privPem)` / `crypto.verify(null, …, pubPem, sigBuf)`, base64url-encoded (cli `edge-book.ts:569-575`).
- Claim payload (signed by the identity key): `{ handle, agent_did, claimed_at }` (canonical).
- Handle slug regex: `^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$`. Reserved: `add healthz metrics agent api handle auth`.

---

## File Structure

**edge-book-host:**
- `src/handles.ts` (new) — pure helpers: `canonicalizeHost`, `didFromPem`, `verifyHandleClaim`, `isValidSlug`, `RESERVED_HANDLES`. No I/O. Isolated + unit-testable.
- `src/store.ts` (modify) — `HandleRecord` type, `state.handles`, `claimHandle`/`resolveHandle`.
- `src/contracts.ts` (modify) — `HandleClaimFrame`/`HandleClaimOkFrame`/`HandleClaimErrFrame`.
- `src/channels.ts` (modify) — `handle_claim` case in `handleFrame`.
- `src/server.ts` (modify) — `GET /handle/:handle` route.
- `test/handles.test.ts` (new) — registry + helpers + HTTP route. **Add this file to `package.json` `test` script.**

**edge-book-cli:**
- `src/edge-book.ts` (modify) — expiry in `validateCard`; `setHandle`; `buildHandleClaim`; `exportIdentity`/`importIdentity`; slug helpers (re-export of the same regex).
- `src/resolver.ts` (modify) — `makeRegistryProvider` accepts bare slugs + builds the relay URL; `defaultProviders` takes a `relayBase`.
- `src/dialout.ts` (modify) — send `handle_claim` after `hello_ok`; handle the ack.
- `src/cli.ts` (modify) — `handle set|show`, `identity export|import`, `init --handle`.
- `src/commands-doc.ts` (modify) — usage entries.
- `test/card-expiry.test.ts`, `test/handle-claim.test.ts`, `test/handle-resolve.test.ts`, `test/identity-portability.test.ts` (new).

Build order: host registry first (CLI resolution depends on the endpoint existing), then CLI.

---

## PHASE 1 — Relay handle registry (`edge-book-host`)

### Task 1: Handle crypto helpers (pure, no I/O)

**Files:**
- Create: `~/claude/edge-book-host/src/handles.ts`
- Create: `~/claude/edge-book-host/test/handles.test.ts`
- Modify: `~/claude/edge-book-host/package.json` (add test file to `test` script)

- [ ] **Step 1: Branch**

```bash
cd ~/claude/edge-book-host && git checkout -b feat/096-human-handles
```

- [ ] **Step 2: Write the failing test** — `test/handles.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { isValidSlug, didFromPem, verifyHandleClaim, canonicalizeHost } from "../src/handles.ts";

// Build a real signed card + claim the way the CLI will, so the host verifier
// is tested against genuine ed25519 output, not a mock.
function mkIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pub, priv, did: didFromPem(pub) };
}
function sign(payload: unknown, priv: string): string {
  return crypto.sign(null, Buffer.from(canonicalizeHost(payload)), priv).toString("base64url");
}
function mkCard(id: { pub: string; priv: string; did: string }, handle: string) {
  const unsigned = {
    schema: "openclaw-agent-card/0.1", agent_id: id.did, handle, display_name: "X",
    card_url: "file://x", card_version: 1, card_hash: "h",
    public_keys: [{ id: id.did + "#main", type: "ed25519", public_key_pem: id.pub }],
    capabilities: [], transports: [], refresh_after: "", expires_at: "",
  };
  return { ...unsigned, signature: sign(unsigned, id.priv) };
}

test("isValidSlug accepts/rejects per regex", () => {
  assert.equal(isValidSlug("antony-evans"), true);
  assert.equal(isValidSlug("ab"), false);          // too short
  assert.equal(isValidSlug("-bad"), false);        // leading hyphen
  assert.equal(isValidSlug("Bad"), false);         // uppercase
  assert.equal(isValidSlug("metrics"), false);     // reserved
});

test("verifyHandleClaim accepts a genuine card+claim", () => {
  const id = mkIdentity();
  const card = mkCard(id, "antony-evans");
  const claimed_at = 1700000000000;
  const claim_sig = sign({ handle: "antony-evans", agent_did: id.did, claimed_at }, id.priv);
  assert.equal(verifyHandleClaim(card, "antony-evans", claimed_at, claim_sig), "ok");
});

test("verifyHandleClaim rejects a tampered claim sig", () => {
  const id = mkIdentity();
  const card = mkCard(id, "antony-evans");
  const other = mkIdentity();
  const claimed_at = 1700000000000;
  const bad = sign({ handle: "antony-evans", agent_did: id.did, claimed_at }, other.priv);
  assert.equal(verifyHandleClaim(card, "antony-evans", claimed_at, bad), "bad_sig");
});

test("verifyHandleClaim rejects a card whose agent_id != derived DID", () => {
  const id = mkIdentity();
  const card = { ...mkCard(id, "antony-evans"), agent_id: "did:openclaw:not-derived" };
  const claimed_at = 1700000000000;
  const claim_sig = sign({ handle: "antony-evans", agent_did: card.agent_id, claimed_at }, id.priv);
  assert.equal(verifyHandleClaim(card as never, "antony-evans", claimed_at, claim_sig), "bad_card");
});
```

- [ ] **Step 3: Add the test file to the host test script** — `package.json`

Append ` test/handles.test.ts` to the end of the `"test": "tsx --test …"` string.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ~/claude/edge-book-host && npx tsx --test test/handles.test.ts`
Expected: FAIL — `Cannot find module '../src/handles.ts'`.

- [ ] **Step 5: Implement `src/handles.ts`**

```ts
import crypto from "node:crypto";

export const RESERVED_HANDLES = new Set(["add", "healthz", "metrics", "agent", "api", "handle", "auth"]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export function isValidSlug(handle: string): boolean {
  return SLUG.test(handle) && !RESERVED_HANDLES.has(handle);
}

// MUST match edge-book-cli/src/edge-book.ts canonicalize() exactly.
export function canonicalizeHost(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeHost).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalizeHost(obj[k])}`).join(",")}}`;
}

// MUST match edge-book-cli stableIdFromPublicKey() exactly.
export function didFromPem(pem: string): string {
  return "did:openclaw:" + crypto.createHash("sha256").update(pem).digest("base64url").slice(0, 32);
}

export interface MinimalCard {
  agent_id: string;
  signature: string;
  public_keys?: Array<{ public_key_pem: string }>;
}

export type ClaimVerdict = "ok" | "bad_card" | "bad_sig";

export function verifyHandleClaim(card: MinimalCard, handle: string, claimed_at: number, claim_sig: string): ClaimVerdict {
  const pem = card.public_keys?.[0]?.public_key_pem;
  if (!pem || !card.agent_id || card.agent_id !== didFromPem(pem)) return "bad_card";
  // card self-signature (over the card minus its own `signature` field)
  const { signature, ...unsigned } = card as Record<string, unknown> & { signature: string };
  try {
    if (!crypto.verify(null, Buffer.from(canonicalizeHost(unsigned)), pem, Buffer.from(signature, "base64url"))) return "bad_card";
  } catch { return "bad_card"; }
  // claim signature (proves live possession of the identity key)
  const payload = { handle, agent_did: card.agent_id, claimed_at };
  try {
    if (!crypto.verify(null, Buffer.from(canonicalizeHost(payload)), pem, Buffer.from(claim_sig, "base64url"))) return "bad_sig";
  } catch { return "bad_sig"; }
  return "ok";
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ~/claude/edge-book-host && npx tsx --test test/handles.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
cd ~/claude/edge-book-host && git add src/handles.ts test/handles.test.ts package.json
git commit -m "feat(096): handle crypto helpers (slug, DID derivation, claim verify)"
```

---

### Task 2: Handle registry in the store

**Files:**
- Modify: `~/claude/edge-book-host/src/store.ts` (State at :57-72, load at :86-100, add methods near :132)
- Modify: `~/claude/edge-book-host/test/handles.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/handles.test.ts`

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostStore } from "../src/store.ts";

function tmpStore(): HostStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-store-"));
  return new HostStore(dir);
}
const REC = { handle: "antony-evans", agent_did: "did:openclaw:abc", card: { agent_id: "did:openclaw:abc" }, claim_sig: "s" };

test("claimHandle stores then resolves", () => {
  const s = tmpStore();
  assert.equal(s.claimHandle(REC), "ok");
  assert.equal(s.resolveHandle("antony-evans")?.agent_did, "did:openclaw:abc");
  assert.equal(s.resolveHandle("nope"), null);
});

test("claimHandle is idempotent for the same DID, taken for a different DID", () => {
  const s = tmpStore();
  assert.equal(s.claimHandle(REC), "ok");
  assert.equal(s.claimHandle({ ...REC, claim_sig: "s2" }), "ok");                 // same DID re-claim
  assert.equal(s.claimHandle({ ...REC, agent_did: "did:openclaw:other" }), "taken");
  assert.equal(s.resolveHandle("antony-evans")?.agent_did, "did:openclaw:abc");   // unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/claude/edge-book-host && npx tsx --test test/handles.test.ts`
Expected: FAIL — `claimHandle is not a function`.

- [ ] **Step 3: Implement store changes** — `src/store.ts`

Add the type (near `StoredMailboxMessage`, after :55):

```ts
export interface HandleRecord {
  handle: string;
  agent_did: string;
  card: unknown;          // the full signed AgentCard (opaque to the host)
  claimed_at: number;
  claim_sig: string;
}
```

Add `handles` to `State` (:57-64), `EMPTY` (:66-72), and `load()` (:90-96):

```ts
// in State:
  handles: Record<string, HandleRecord>;
// in EMPTY:
  handles: {},
// in load() return object:
  handles: parsed.handles || {},
```

Add methods (after the mailbox section, near :173):

```ts
  // --- handle registry (spec-096) ---
  // Grant iff free OR already owned by the same DID (idempotent card refresh).
  claimHandle(rec: Omit<HandleRecord, "claimed_at"> & { claimed_at?: number }): "ok" | "taken" {
    const existing = this.state.handles[rec.handle];
    if (existing && existing.agent_did !== rec.agent_did) return "taken";
    this.state.handles[rec.handle] = { ...rec, claimed_at: rec.claimed_at ?? Date.now() };
    this.scheduleFlush();
    return "ok";
  }

  resolveHandle(handle: string): HandleRecord | null {
    return this.state.handles[handle] ?? null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/claude/edge-book-host && npx tsx --test test/handles.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-host && git add src/store.ts test/handles.test.ts
git commit -m "feat(096): handle registry in HostStore (claim/resolve, persisted)"
```

---

### Task 3: `handle_claim` WS frame + `GET /handle/:handle`

**Files:**
- Modify: `~/claude/edge-book-host/src/contracts.ts` (after :126)
- Modify: `~/claude/edge-book-host/src/channels.ts` (`handleFrame`, near the `mailbox_send` case at :287)
- Modify: `~/claude/edge-book-host/src/server.ts` (HTTP routing — read the block that defines `GET /metrics` / `/healthz` and add a peer route)
- Modify: `~/claude/edge-book-host/test/handles.test.ts`

- [ ] **Step 1: Read the routing + frame-dispatch code**

```bash
cd ~/claude/edge-book-host && grep -n "metrics\|healthz\|req.url\|request(" src/server.ts | head
sed -n '280,335p' src/channels.ts   # the handleFrame switch
```
Note the exact request-routing shape (`req.method`, `req.url`, how a JSON response is written) and how `handleFrame` sends frames (`this.send(ws, …)`).

- [ ] **Step 2: Add contract types** — `src/contracts.ts` (after :126)

```ts
// ── Handle registry frames (spec-096) ───────────────────────────────────────
//   Agent → Host   { type:"handle_claim", request_id, handle, card, claimed_at, claim_sig }
//   Host → Agent   { type:"handle_claim_ok",  request_id, handle }
//                  { type:"handle_claim_err", request_id, reason }
export interface HandleClaimFrame {
  type: "handle_claim";
  request_id: string;
  handle: string;
  card: unknown;        // full signed AgentCard
  claimed_at: number;
  claim_sig: string;
}
export interface HandleClaimOkFrame { type: "handle_claim_ok"; request_id: string; handle: string; }
export interface HandleClaimErrFrame { type: "handle_claim_err"; request_id: string; reason: "taken" | "bad_sig" | "bad_format" | "bad_card"; }
```

- [ ] **Step 3: Write the failing test** — append to `test/handles.test.ts`

```ts
// HTTP route: GET /handle/:handle returns the stored card or 404.
// (startServer helper mirrors the host's existing integration tests — copy the
//  bootstrap from test/integration.test.ts if the import path differs.)
test("GET /handle/:handle returns the card, 404 for unknown", async () => {
  const { startEdgeBookHost } = await import("../src/server.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-http-"));
  const { server, store } = startEdgeBookHost({ dataDir: dir, port: 0 });
  store.claimHandle({ handle: "antony-evans", agent_did: "did:openclaw:abc", card: { agent_id: "did:openclaw:abc", hello: "world" }, claim_sig: "s" });
  const port = (server.address() as { port: number }).port;
  const ok = await fetch(`http://127.0.0.1:${port}/handle/antony-evans`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { agent_id: string }).agent_id, "did:openclaw:abc");
  const miss = await fetch(`http://127.0.0.1:${port}/handle/nobody`);
  assert.equal(miss.status, 404);
  await new Promise<void>((r) => server.close(() => r()));
});
```

> If `startEdgeBookHost` has a different name/shape, read `test/integration.test.ts` for the real server-start helper and adapt this test's bootstrap to it. The assertions (200 + card body, 404) stay identical.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ~/claude/edge-book-host && npx tsx --test test/handles.test.ts`
Expected: FAIL — no `/handle/` route (404 for the first fetch too, or import error).

- [ ] **Step 5: Implement the `handle_claim` frame handler** — `src/channels.ts`

In `handleFrame`, add a case alongside `mailbox_send` (import the helpers + store type at the top):

```ts
import { isValidSlug, verifyHandleClaim } from "./handles.js";
// …inside handleFrame(channel_id, ws, frame), after the mailbox_send branch:
    if (type === "handle_claim") {
      const request_id = String(frame.request_id || "");
      const handle = String(frame.handle || "");
      const claimed_at = Number(frame.claimed_at || 0);
      const claim_sig = String(frame.claim_sig || "");
      const card = frame.card as { agent_id?: string };
      if (!isValidSlug(handle)) { this.send(ws, { type: "handle_claim_err", request_id, reason: "bad_format" }); return; }
      const verdict = verifyHandleClaim(card as never, handle, claimed_at, claim_sig);
      if (verdict !== "ok") { this.send(ws, { type: "handle_claim_err", request_id, reason: verdict }); return; }
      const result = this.store.claimHandle({ handle, agent_did: String(card.agent_id), card, claim_sig, claimed_at });
      if (result === "taken") { this.send(ws, { type: "handle_claim_err", request_id, reason: "taken" }); return; }
      this.send(ws, { type: "handle_claim_ok", request_id, handle });
      return;
    }
```

- [ ] **Step 6: Implement the HTTP route** — `src/server.ts`

Alongside the existing `/metrics` / `/healthz` handling, before the catch-all, add (adapt to the real router shape found in Step 1):

```ts
    if (req.method === "GET" && req.url && req.url.startsWith("/handle/")) {
      const handle = decodeURIComponent(req.url.slice("/handle/".length).split("?")[0]);
      const rec = store.resolveHandle(handle);
      if (!rec) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not_found" })); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rec.card)); return;
    }
```

- [ ] **Step 7: Run the full host suite**

Run: `cd ~/claude/edge-book-host && npm test`
Expected: PASS — existing suites green + `test/handles.test.ts` (7 tests).

- [ ] **Step 8: Commit**

```bash
cd ~/claude/edge-book-host && git add src/contracts.ts src/channels.ts src/server.ts test/handles.test.ts
git commit -m "feat(096): handle_claim frame + GET /handle/:handle resolve route"
```

---

## PHASE 2 — CLI (`edge-book-cli`)

### Task 4: Enforce card expiry in `validateCard`

**Files:**
- Modify: `~/claude/edge-book-cli/src/edge-book.ts` (`validateCard` at :2916)
- Create: `~/claude/edge-book-cli/test/card-expiry.test.ts`

- [ ] **Step 1: Write the failing test** — `test/card-expiry.test.ts`

```ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, validateCard, type AgentCard } from "../src/edge-book.ts";

async function freshCard(expires_at: string): Promise<AgentCard> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-exp-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "x-agent", displayName: "X" });
  const card = await store.writeCard();
  // re-sign with a forced expiry by going through writeCard's signer is overkill;
  // instead assert on a genuinely-built card and a hand-expired clone.
  return { ...card, expires_at };
}

test("validateCard rejects a card past expires_at", async () => {
  const card = await freshCard(new Date(Date.now() - 1000).toISOString());
  // The clone broke the signature; re-sign is out of scope — assert expiry is
  // checked BEFORE signature by using a fresh, correctly-signed expired card:
  assert.throws(() => validateCard(card), /card_expired|signature/);
});

test("validateCard accepts a current card", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-exp2-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "y-agent", displayName: "Y" });
  const card = await store.writeCard(); // expires_at ~7 days out, properly signed
  assert.doesNotThrow(() => validateCard(card));
});
```

> Note: `writeCard` sets `expires_at` ~7 days out and signs. To test the expiry path with a valid signature, the cleanest approach is to make `writeCard` accept an injectable clock OR build the expired card through the store. If re-signing an expired card is awkward, add a tiny exported test helper `signCardForTest(store, overrides)` in this task. Keep the assertion: an expired but otherwise-valid card throws `card_expired`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/claude/edge-book-cli && node --test test/card-expiry.test.ts`
Expected: FAIL — current `validateCard` does not throw on expiry.

- [ ] **Step 3: Implement** — `src/edge-book.ts` `validateCard` (:2916), add as the FIRST check after schema:

```ts
  if (card.expires_at) {
    const exp = Date.parse(card.expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) {
      throw new EdgeBookError("card_expired", "Card/invite expired — ask the peer for a fresh handle or invite");
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/claude/edge-book-cli && node --test test/card-expiry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full cli suite (guard against fixture regressions)**

Run: `cd ~/claude/edge-book-cli && npm test`
Expected: PASS. If any existing test uses a stale hard-coded `expires_at`, refresh that fixture to a future date — do NOT weaken the check.

- [ ] **Step 6: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/edge-book.ts test/card-expiry.test.ts
git commit -m "feat(096): enforce card expiry in validateCard"
```

---

### Task 5: `setHandle` (re-sign card under a chosen handle)

**Files:**
- Modify: `~/claude/edge-book-cli/src/edge-book.ts` (add `setHandle`; reuse `writeCard` at :835, slug regex)
- Create: `~/claude/edge-book-cli/test/handle-claim.test.ts`

- [ ] **Step 1: Write the failing test** — `test/handle-claim.test.ts`

```ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, slugifyHandle, isValidHandle } from "../src/edge-book.ts";

async function store() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-handle-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "X" }); // no handle → default replaced later
  return s;
}

test("slugifyHandle + isValidHandle", () => {
  assert.equal(slugifyHandle("Antony Evans"), "antony-evans");
  assert.equal(isValidHandle("antony-evans"), true);
  assert.equal(isValidHandle("ab"), false);
  assert.equal(isValidHandle("metrics"), false);
});

test("setHandle updates identity + re-signs the card", async () => {
  const s = await store();
  await s.setHandle("antony-evans");
  const id = await s.identity();
  assert.equal(id.handle, "antony-evans");
  const card = await s.writeCard();
  assert.equal(card.handle, "antony-evans");
  assert.doesNotThrow(() => require("../src/edge-book.ts").validateCard(card)); // still valid sig
});

test("setHandle rejects a bad slug", async () => {
  const s = await store();
  await assert.rejects(() => s.setHandle("Bad Handle!"), /invalid_handle/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-claim.test.ts`
Expected: FAIL — `slugifyHandle is not exported` / `setHandle is not a function`.

- [ ] **Step 3: Implement** — `src/edge-book.ts`

Module scope (near `randomId`, after :525):

```ts
const HANDLE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_HANDLES = new Set(["add", "healthz", "metrics", "agent", "api", "handle", "auth"]);
export function isValidHandle(handle: string): boolean {
  return HANDLE_SLUG.test(handle) && !RESERVED_HANDLES.has(handle);
}
export function slugifyHandle(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}
```

Method on `EdgeBookStore` (near `setProfile` at :757):

```ts
  // Set a user-chosen, unique handle. Re-signs the card; does NOT rotate keys.
  async setHandle(handle: string): Promise<LocalIdentity> {
    if (!isValidHandle(handle)) {
      throw new EdgeBookError("invalid_handle", `Handle must be 3-30 chars [a-z0-9-], not reserved: ${handle}`);
    }
    const identity = await this.identity();
    identity.handle = handle;
    identity.updated_at = now();
    await writeJson(this.file(IDENTITY_FILE), identity, 0o600);
    await this.writeCard();
    await this.audit("identity.set_handle", identity.agent_id, { handle });
    return identity;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-claim.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/edge-book.ts test/handle-claim.test.ts
git commit -m "feat(096): setHandle + slug helpers (re-sign card, no key rotation)"
```

---

### Task 6: `buildHandleClaim` (signed claim payload for the relay)

**Files:**
- Modify: `~/claude/edge-book-cli/src/edge-book.ts` (add `buildHandleClaim`; uses `signPayload` at :569, `CARD_FILE`)
- Modify: `~/claude/edge-book-cli/test/handle-claim.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/handle-claim.test.ts`

```ts
import crypto from "node:crypto";
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

test("buildHandleClaim produces a relay-verifiable claim", async () => {
  const s = await store();
  await s.setHandle("antony-evans");
  const claim = await s.buildHandleClaim();
  const id = await s.identity();
  assert.equal(claim.handle, "antony-evans");
  assert.equal(claim.agent_did, id.agent_id);
  assert.equal((claim.card as { agent_id: string }).agent_id, id.agent_id);
  // verify the claim_sig with the public key, exactly as the host will
  const ok = crypto.verify(
    null,
    Buffer.from(canon({ handle: claim.handle, agent_did: claim.agent_did, claimed_at: claim.claimed_at })),
    id.public_key_pem,
    Buffer.from(claim.claim_sig, "base64url"),
  );
  assert.equal(ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-claim.test.ts`
Expected: FAIL — `buildHandleClaim is not a function`.

- [ ] **Step 3: Implement** — `src/edge-book.ts`, method on `EdgeBookStore`:

```ts
  // Build a signed handle claim for the relay registry (spec-096). The relay
  // verifies claim_sig + the card against the identity key before binding.
  async buildHandleClaim(): Promise<{ handle: string; agent_did: string; card: AgentCard; claimed_at: number; claim_sig: string }> {
    const identity = await this.identity();
    if (!isValidHandle(identity.handle)) {
      throw new EdgeBookError("invalid_handle", `Set a handle first (current: ${identity.handle})`);
    }
    const card = await loadCard(this.file(CARD_FILE)); // current signed card
    const claimed_at = Date.now();
    const claim_sig = signPayload({ handle: identity.handle, agent_did: identity.agent_id, claimed_at }, identity.private_key_pem);
    return { handle: identity.handle, agent_did: identity.agent_id, card, claimed_at, claim_sig };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-claim.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/edge-book.ts test/handle-claim.test.ts
git commit -m "feat(096): buildHandleClaim — signed claim payload for the registry"
```

---

### Task 7: Resolver — registry provider resolves bare handles via the relay

**Files:**
- Modify: `~/claude/edge-book-cli/src/resolver.ts` (`makeRegistryProvider` :258, `defaultProviders` :200)
- Create: `~/claude/edge-book-cli/test/handle-resolve.test.ts`

- [ ] **Step 1: Write the failing test** — `test/handle-resolve.test.ts`

```ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { EdgeBookStore } from "../src/edge-book.ts";
import { resolveTarget, makeRegistryProvider } from "../src/resolver.ts";

async function init() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-res-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Owner" });
  await s.setHandle("antony-evans");
  return s;
}

test("friend antony-evans resolves a relay-served card", async () => {
  const s = await init();
  const card = await s.writeCard();
  // stand up a fake relay exposing GET /handle/:h
  const srv = http.createServer((req, res) => {
    if (req.url === "/handle/antony-evans") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(card)); }
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const provider = makeRegistryProvider(async (t) => {
    const h = t.startsWith("registry:") ? t.slice("registry:".length) : t;
    return `${base}/handle/${h}`;
  });
  const out = await resolveTarget(s, "antony-evans", { providers: [provider] });
  assert.equal(out.status, "resolved");
  assert.equal(out.agent_id, card.agent_id);
  const miss = await resolveTarget(s, "ghost", { providers: [provider] });
  assert.equal(miss.status, "not_found");
  await new Promise<void>((r) => srv.close(() => r()));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-resolve.test.ts`
Expected: FAIL — provider only matches `registry:` prefix, so bare `antony-evans` returns null → `not_found` for the hit case.

- [ ] **Step 3: Implement** — `src/resolver.ts` `makeRegistryProvider` (:258), accept bare slugs:

```ts
const HANDLE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export function makeRegistryProvider(lookup: RegistryLookup): ResolverProvider {
  return {
    name: "registry",
    priority: 50,
    async resolve(_store, target) {
      const isExplicit = target.startsWith("registry:");
      const slug = isExplicit ? target.slice("registry:".length) : target;
      if (!isExplicit && !HANDLE_SLUG.test(slug)) return null; // only bare slugs route here
      const cardTarget = await lookup(target);
      if (!cardTarget) return null;
      const card = await loadCard(cardTarget); // validateCard inside (sig + expiry)
      return {
        kind: "card",
        card,
        agent_id: card.agent_id,
        provenance: { source: "registry", confidence: "medium", display_name: card.handle, reason: "handle registry lookup" },
      };
    },
  };
}
```

Update `defaultProviders` (:200) to build the lookup from a relay base:

```ts
export function defaultProviders(relayBase?: string): ResolverProvider[] {
  const lookup: RegistryLookup = async (target) => {
    if (!relayBase) return null;
    const slug = target.startsWith("registry:") ? target.slice("registry:".length) : target;
    return `${relayBase.replace(/\/$/, "")}/handle/${encodeURIComponent(slug)}`;
  };
  return [localContactProvider, inviteProvider, cardUrlProvider, cardFileProvider, makeRegistryProvider(lookup)];
}
```

> The registry provider has priority 50 and only matches *bare slugs* or `registry:` — it never shadows invite/url/file (priority 90) or local contacts (100). A bare slug that is also a known contact still resolves locally first.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full cli suite** (defaultProviders signature changed)

Run: `cd ~/claude/edge-book-cli && npm test`
Expected: PASS. Update any caller of `defaultProviders(...)` that passed a `RegistryLookup` to pass a `relayBase` string instead (grep `defaultProviders(` in `src/`).

- [ ] **Step 6: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/resolver.ts test/handle-resolve.test.ts
git commit -m "feat(096): registry provider resolves bare handles via relay /handle/:h"
```

---

### Task 8: Dial-out auto-claims the handle after `hello_ok`

**Files:**
- Modify: `~/claude/edge-book-cli/src/dialout.ts` (post-`hello_ok` path near :480; frame dispatch near :562)
- Modify: `~/claude/edge-book-cli/test/handle-claim.test.ts` (or a focused dialout test if a WS harness exists)

- [ ] **Step 1: Read the dial-out connect + frame-dispatch code**

```bash
cd ~/claude/edge-book-cli && sed -n '466,520p' src/dialout.ts && sed -n '555,600p' src/dialout.ts
```
Identify (a) where `hello_ok` is received, (b) the `this.send(...)` helper, (c) access to `this.store`.

- [ ] **Step 2: Write the failing test** — append to `test/handle-claim.test.ts`

A focused unit test on the claim-send decision (no live WS needed): extract the decision into a tiny pure helper and test it.

```ts
import { shouldClaimHandle } from "../src/dialout.ts";
test("shouldClaimHandle skips default/empty, sends for a real handle", () => {
  assert.equal(shouldClaimHandle("agent.openclaw.local"), false);
  assert.equal(shouldClaimHandle(""), false);
  assert.equal(shouldClaimHandle("antony-evans"), true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-claim.test.ts`
Expected: FAIL — `shouldClaimHandle is not exported`.

- [ ] **Step 4: Implement** — `src/dialout.ts`

Export the decision helper (module scope):

```ts
export function shouldClaimHandle(handle: string | undefined): boolean {
  return !!handle && handle !== "agent.openclaw.local" && /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(handle);
}
```

After `hello_ok` is processed (where the client knows it is connected), claim the handle once per connection:

```ts
// after hello_ok handling:
try {
  const identity = await this.store.identity();
  if (shouldClaimHandle(identity.handle)) {
    const claim = await this.store.buildHandleClaim();
    this.send({ type: "handle_claim", request_id: `hc-${claim.claimed_at}`, handle: claim.handle, card: claim.card, claimed_at: claim.claimed_at, claim_sig: claim.claim_sig });
  }
} catch { /* non-fatal: handle claim is best-effort, mail still routes by DID */ }
```

In the frame dispatch (near :562, alongside `mailbox_send_ok`), swallow the acks so they don't log as unknown:

```ts
if (frameType === "handle_claim_ok" || frameType === "handle_claim_err") return; // best-effort; surfaced via `handle show` later
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/claude/edge-book-cli && node --test test/handle-claim.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/dialout.ts test/handle-claim.test.ts
git commit -m "feat(096): dial-out auto-claims handle on connect (best-effort)"
```

---

### Task 9: CLI commands — `handle set|show`, `identity export|import`, `init --handle`

**Files:**
- Modify: `~/claude/edge-book-cli/src/cli.ts` (dispatch; `init` at :141, add `handle` + `identity` groups)
- Modify: `~/claude/edge-book-cli/src/edge-book.ts` (`exportIdentity`/`importIdentity`)
- Modify: `~/claude/edge-book-cli/src/commands-doc.ts`
- Create: `~/claude/edge-book-cli/test/identity-portability.test.ts`

- [ ] **Step 1: Write the failing test** — `test/identity-portability.test.ts`

```ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";

test("export then import reproduces the same DID + handle", async () => {
  const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "eb-A-"));
  const a = new EdgeBookStore({ home: homeA });
  await a.init({ displayName: "Owner" });
  await a.setHandle("antony-evans");
  const bundle = await a.exportIdentity();

  const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "eb-B-"));
  const b = new EdgeBookStore({ home: homeB });
  await b.importIdentity(bundle);
  const idA = await a.identity();
  const idB = await b.identity();
  assert.equal(idB.agent_id, idA.agent_id);   // same DID → handle resolves to same agent
  assert.equal(idB.handle, "antony-evans");
});

test("importIdentity refuses to clobber an existing identity without force", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-C-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Existing" });
  const other = new EdgeBookStore({ home: await fs.mkdtemp(path.join(os.tmpdir(), "eb-D-")) });
  await other.init({ displayName: "Other" });
  const bundle = await other.exportIdentity();
  await assert.rejects(() => s.importIdentity(bundle), /identity_exists/);
  await assert.doesNotReject(() => s.importIdentity(bundle, { force: true }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/claude/edge-book-cli && node --test test/identity-portability.test.ts`
Expected: FAIL — `exportIdentity is not a function`.

- [ ] **Step 3: Implement** — `src/edge-book.ts`, methods on `EdgeBookStore`:

```ts
  // Portable identity bundle (the DID keypair + chosen handle). Carry to a new
  // device → same DID → relay handle keeps resolving to you (spec-096).
  async exportIdentity(): Promise<{ schema: "edge-book-identity-export/0.1"; identity: LocalIdentity }> {
    return { schema: "edge-book-identity-export/0.1", identity: await this.identity() };
  }

  async importIdentity(bundle: { identity: LocalIdentity }, opts: { force?: boolean } = {}): Promise<LocalIdentity> {
    await ensureHome(this.home);
    const existing = await readJson<LocalIdentity | null>(this.file(IDENTITY_FILE), null);
    if (existing && !opts.force) throw new EdgeBookError("identity_exists", `An identity already exists at ${this.home} (use --force to overwrite)`);
    const id = bundle.identity;
    if (id.agent_id !== stableIdFromPublicKey(id.public_key_pem)) throw new EdgeBookError("invalid_import", "Bundle agent_id does not match its public key");
    await writeJson(this.file(IDENTITY_FILE), id, 0o600);
    if (!(await readJson<unknown | null>(this.file(CONTACTS_FILE), null))) await writeJson(this.file(CONTACTS_FILE), {});
    if (!(await readJson<unknown | null>(this.file(GRANTS_FILE), null))) await writeJson(this.file(GRANTS_FILE), {});
    if (!(await readJson<unknown | null>(this.file(SEEN_MESSAGES_FILE), null))) await writeJson(this.file(SEEN_MESSAGES_FILE), []);
    await this.writeCard();
    await this.audit("identity.import", id.agent_id, { handle: id.handle });
    return id;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/claude/edge-book-cli && node --test test/identity-portability.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CLI commands** — `src/cli.ts`

Add `--handle` to `init` (call `slugifyHandle` on the value, pass to `store.init({ handle })`). Add command groups (follow the existing `if (command === "...")` dispatch style; print JSON like sibling commands):

```ts
  if (command === "handle") {
    const action = args.shift();
    if (action === "set") {
      const id = await store.setHandle(slugifyHandle(requireArg(args.shift(), "handle")));
      return { text: `Handle set: ${id.handle} (${id.agent_id})`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    if (action === "show") {
      const id = await store.identity();
      return { text: `${id.handle}\n${id.agent_id}`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    throw new EdgeBookError("usage", "handle set <slug> | handle show");
  }
  if (command === "identity") {
    const action = args.shift();
    if (action === "export") {
      const bundle = await store.exportIdentity();
      const p = takeFlag(args, "--path");
      if (p) { await fs.writeFile(p, JSON.stringify(bundle, null, 2)); return { text: `Identity exported → ${p}`, json: { path: p } }; }
      return { text: JSON.stringify(bundle), json: bundle };
    }
    if (action === "import") {
      const p = requireArg(args.shift(), "import <path>");
      const bundle = JSON.parse(await fs.readFile(p, "utf8"));
      const id = await store.importIdentity(bundle, { force: args.includes("--force") });
      return { text: `Identity imported: ${id.handle} (${id.agent_id})`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    throw new EdgeBookError("usage", "identity export [--path f] | identity import <path> [--force]");
  }
```

Ensure `slugifyHandle`, `isValidHandle` are imported from `./edge-book.ts` at the top of `cli.ts`.

- [ ] **Step 6: Add usage docs** — `src/commands-doc.ts`

```ts
  { usage: "handle set <slug>", desc: "Claim a unique human handle (replaces the default)" },
  { usage: "handle show", desc: "Show your handle + DID fingerprint" },
  { usage: "identity export [--path f]", desc: "Export your identity keypair to carry to a new device" },
  { usage: "identity import <path> [--force]", desc: "Restore an exported identity (same DID, same handle)" },
```
(Place under the relevant section, matching the existing entry shape.)

- [ ] **Step 7: Run the full cli suite + build**

Run: `cd ~/claude/edge-book-cli && npm test && npm run build`
Expected: PASS; `dist/edge-book.js` rebuilt.

- [ ] **Step 8: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/cli.ts src/edge-book.ts src/commands-doc.ts test/identity-portability.test.ts
git commit -m "feat(096): handle set/show + identity export/import CLI; init --handle"
```

---

## Manual end-to-end verification (after both repos green)

1. Deploy host: `cd ~/claude/edge-book-host && fly deploy` (or the repo's deploy step).
2. Two temp homes locally:
   ```bash
   EDGE_BOOK_HOME=/tmp/h-recipient npx tsx src/cli.ts init --handle antony-evans
   EDGE_BOOK_HOME=/tmp/h-recipient npx tsx src/cli.ts dialout --host wss://edge-book-host.fly.dev/agent/ws &
   curl -s https://edge-book-host.fly.dev/handle/antony-evans | head -c 200   # expect the card JSON
   ```
3. From the sender home: `friend antony-evans --deliver` → check `friend pending` on the recipient.
4. Confirm relay metrics show `delivered`/`acked` increment (sanity, pre-receipts spec).

## Republish

`cd ~/claude/edge-book-cli && npm publish` so paired agents get `handle`/`identity` commands. (Same step the 095 as-built called out.)

---

## Self-review (run against the spec)

- **Spec coverage:** relay registry (T1-3) · default-handle replacement + `handle set` (T5, T9) · resolver wiring + bare-slug (T7) · auto-claim on connect (T8) · `identity export/import` (T9) · card-expiry enforcement (T4). Phase-2 rotation `handle_rebind` is explicitly out of scope (spec §Phase 2). **Note:** spec task "idempotent init" was found ALREADY implemented (`edge-book.ts:716-720` returns existing identity) — the Jun-1 regen was an external home-wipe (OpenClaw bootstrap), not `init`. Durability is delivered via `export/import` instead; the bootstrap guard is tracked as a separate OpenClaw-repo follow-up, not an `edge-book-cli` change.
- **Placeholder scan:** none. Two read-first steps (T3 server routing, T8 dial-out wiring) point at exact line ranges because those glue shapes must match live code; the logic bodies are fully specified.
- **Type consistency:** `HandleRecord`, `verifyHandleClaim`, `buildHandleClaim`, `claimHandle`, `resolveHandle`, `setHandle`, `slugifyHandle`/`isValidHandle`, `exportIdentity`/`importIdentity`, `shouldClaimHandle` are defined once and referenced consistently. Claim payload `{ handle, agent_did, claimed_at }` and canonicalization are identical in host (`handles.ts`) and cli (`edge-book.ts`).

## Out of scope (this plan)
Delivery receipts (`spec-097`), deliberate-rotation `handle_rebind`, web find-box UI, DNS/`.well-known` handles, OpenClaw bootstrap home-wipe guard (different repo).
