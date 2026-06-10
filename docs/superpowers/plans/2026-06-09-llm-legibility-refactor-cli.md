# LLM-Legibility Refactor — edge-book-cli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize edge-book-cli so a context-free LLM agent can locate any behavior within 3 file reads — zero observable behavior change.

**Architecture:** Pure code motion plus delegation: hoist type definitions, helpers, validators, harnesses, and the embedded dashboard HTML out of the two god files (`src/edge-book.ts` 3,345 lines, `src/http.ts` 1,738 lines) into feature-named modules. `src/edge-book.ts` stays the public facade (re-exports everything it exports today) and keeps the `EdgeBookStore` class; four self-contained method groups become one-line delegates to feature modules. `src/cli.ts`'s export surface is FROZEN (plugin entry `index.js` imports `handleCli`, `EdgeBookDialoutClient`, `DEFAULT_DIALOUT_HOST` from its tsup bundle).

**Tech Stack:** TypeScript run natively by Node ≥20 (`node --test test/*.test.ts`, type-stripping), bundled by tsup. No tsconfig exists; strict `tsc` has pre-existing errors (FINDINGS) — the verification gate is `npm run build` + `npm test`, with `npm run smoke` after transport-adjacent steps.

---

## Baseline (recorded 2026-06-09, commit 8b88dff)

- `npm test` → 243 pass / 0 fail
- `npm run build` → ESM dist/edge-book.js 252.05 KB, success
- `npm run smoke` → 10/10 ALL GREEN
- `npm run sync-readme:check` → up to date
- `npm run harness:e2e` → CONVERGENCE PASS
- `npx tsc -p . --noEmit` → **no tsconfig.json exists** (task-brief discrepancy; see FINDINGS.md)

## Frozen surfaces (never rename/reshape)

1. **Contract types** mirrored from host `src/contracts.ts`: `MailboxMessage`/`Transport` shapes, mailbox/handle wire frames, `SharedObject`, `Grant` (CLI: `CapabilityGrant` model), `AuditEvent` semantics. Moving between files OK; renames/reshapes FORBIDDEN.
2. **`src/cli.ts` exports**: `handleCli`, `runCli`, `CliContext`, `CliResult`, re-exported `DEFAULT_DIALOUT_HOST`, `EdgeBookDialoutClient` — the npm/OpenClaw plugin surface.
3. CLI command names/flags/output, HTTP routes, persisted JSON file names and shapes under the agent home, envelope schemas.
4. Test assertions, fixtures, inputs (import paths may change only if forced by moves; prefer keeping `src/edge-book.ts` re-exports so NO test edits are needed).

## Per-step gate (run after EVERY task, before commit)

```bash
npm run build && npm test 2>&1 | tail -8
```
Expected: build success; `# pass 243` / `# fail 0`. Smoke (`npm run smoke`) additionally where marked.

---

### Task 1: FINDINGS.md — record discovered issues without touching behavior

**Files:** Create: `FINDINGS.md`

- [ ] Step 1: Write `FINDINGS.md` with: (a) no tsconfig.json — `npx tsc -p . --noEmit` from the task brief cannot run; strict tsc shows pre-existing type errors (cli.ts:688/700 `string|undefined`, dialout.ts:668 Buffer/BodyInit) so a tsconfig was NOT added; (b) placeholder for further findings.
- [ ] Step 2: Commit: `docs: add FINDINGS.md recording pre-existing issues left untouched`

### Task 2: Extract shared type definitions → `src/types.ts`

**Files:** Create: `src/types.ts` — Modify: `src/edge-book.ts:1-610` (and `EPHEMERAL_TTL_POLICY:268`, `POST_TAXONOMY:651`, `classOf:659`, `EdgeBookError:566`)

- [ ] Step 1: Move, verbatim, every `export type`/`export interface` from edge-book.ts lines 1–610 plus `EdgeBookError`, `EPHEMERAL_TTL_POLICY`, `PostType`, `POST_TAXONOMY`, `classOf` into `src/types.ts`. Header comment: which types mirror host `src/contracts.ts` and are frozen (point at host repo path + wire-protocol.md). Do NOT move `EdgeBookOptions`/store-coupled types if they reference the class; check each — types referencing only other types move.
- [ ] Step 2: In `src/edge-book.ts`, delete moved blocks, add `export * from "./types.ts";` at top and import the names it uses locally (type-only where possible). No other file changes (they import from edge-book.ts which re-exports).
- [ ] Step 3: Gate. Expected 243/243.
- [ ] Step 4: Commit: `refactor: extract shared type definitions from edge-book.ts into types.ts`

### Task 3: Extract fs/json + crypto helpers → `src/fs-json.ts`, `src/crypto.ts`

**Files:** Create: `src/fs-json.ts`, `src/crypto.ts` — Modify: `src/edge-book.ts:605-810`

- [ ] Step 1: Move `resolveHome`, `randomId`, `contentHash`, `readJson`, `writeJson`, `now` (and any adjacent pure fs helpers) → `src/fs-json.ts`. Move key/signature helpers (`signPayload`, `verifyPayload`, `withoutSignature`, `stableIdFromPublicKey`, canonicalization helpers — locate via `grep -n "^function\|^export function" src/edge-book.ts` in 605–810) → `src/crypto.ts`. Comment on crypto.ts: payloads are signed over canonical JSON with `signature` stripped; changing canonicalization breaks every persisted signature.
- [ ] Step 2: edge-book.ts imports them; keep `export { … } from` re-exports for every symbol that was previously exported. `isValidHandle`/`slugifyHandle` → `src/fs-json.ts`? No — they are handle semantics; put them in `src/types.ts`-adjacent `src/handles.ts`? Decision: keep `isValidHandle`/`slugifyHandle` in a small `src/handles.ts` (mirrors host naming), re-export from edge-book.ts.
- [ ] Step 3: Gate. Commit: `refactor: extract fs/json, crypto, and handle helpers from edge-book.ts`

### Task 4: Extract card validation/loading → `src/cards.ts`; harnesses → `src/harness.ts`

**Files:** Create: `src/cards.ts`, `src/harness.ts` — Modify: `src/edge-book.ts:3105-3345`

- [ ] Step 1: Move `validateCard`, `validateFriendProfile`, `loadCard` (3105–3157) → `src/cards.ts` (depends on crypto.ts + types.ts). Comment: card expiry rejection is spec-096 §C.
- [ ] Step 2: Move `runTwoAgentHarness`, `runFeedPrivacyHarness` (3158–3345) → `src/harness.ts`.
- [ ] Step 3: Re-export both modules from edge-book.ts. Gate (also `npm run smoke` — harness path). Commit: `refactor: extract card validation and two-agent harnesses from edge-book.ts`

### Task 5: Delegate taxonomy-post methods → `src/store-taxonomy.ts`

**Files:** Create: `src/store-taxonomy.ts` — Modify: `src/edge-book.ts` (~1653–2380 excluding grant fns 2222–2265)

- [ ] Step 1: Move bodies of: attestations/saveAttestations/createAttestation/verifyAttestation, verifyCapability/verifyEphemeral/verifyAnswer/verifySignal/verifyEndorsement, endorsements/createEndorsement/saveEndorsements, signals/saveSignals/createSignal/expireSignals/signalLifecycle, ephemeral group (saveEphemeral/ephemeralPosts/createEphemeral/expireEphemeral/cancelEphemeral), answers group (saveAnswers/answers/createAnswer/deleteQuery), capabilities group (capabilities/advertiseCapability/deprecateCapability), receivedPosts group (receivedPosts/saveReceivedPosts/receivedByCategory/receivePostPublish/signPostPublishEnvelope, private verifyReceivedPost/receivedPostId/receivedPostAuthor) into free functions `fn(store: EdgeBookStore, …)` in `src/store-taxonomy.ts`. File constants they use (SIGNALS_FILE etc.) move to an exported block in `src/fs-json.ts` or a `src/store-files.ts` shared constants module (pick ONE place; document it).
- [ ] Step 2: Each class method becomes a one-line delegate (`return createSignal(this, input)`), keeping the exact public signature. Private helpers become module-local functions.
- [ ] Step 3: Gate. Commit: `refactor: extract taxonomy-post (signals/ephemeral/answers/endorsements/attestations/capabilities) logic into store-taxonomy.ts`

### Task 6: Delegate shared-object methods → `src/store-objects.ts`

**Files:** Create: `src/store-objects.ts` — Modify: `src/edge-book.ts` (objects 1601–1652, 2041–2221)

- [ ] Step 1: Move bodies of objects/saveObjects/getObject/createObject, issueObjectGrant, canReadObject, readObject, readAttachmentBytes, sharedObjectsFor, shareObjectEnvelope, receiveObjectShare, revokeObjectGrant, revokeObjectEnvelope, receiveObjectRevoke as free functions. Comment the fail-closed `canReadObject` rule (Contract 2, host contracts.ts `canRead`) and that grant signature verification is plan-031 §6.
- [ ] Step 2: One-line delegates in the class. Gate + `npm run smoke` (object share/revoke is smoke-covered). Commit: `refactor: extract shared-object and object-grant logic into store-objects.ts`

### Task 7: Delegate posts/feed/approvals/mutes → `src/store-posts.ts`; escalations → `src/store-escalations.ts`

**Files:** Create: `src/store-posts.ts`, `src/store-escalations.ts` — Modify: `src/edge-book.ts` (2528–3103 region)

- [ ] Step 1: Move posts/feed group (posts/savePosts/feedItems/saveFeedItems/createPost/approvePost/editPost/removePost/expirePost/ensureLocalFeedItem/visiblePostsForPeer/importFeedPosts/markFeedItemRead/hideFeedItem), approvals (approvals/saveApprovals/createApproval/resolveApproval), mutes (contactMutes/saveContactMutes/muteContact/unmuteContact) → `src/store-posts.ts`.
- [ ] Step 2: Move escalations group (escalations/saveEscalations/putEscalation/raiseEscalation/receiveEscalation/answerEscalation/applyEscalationResponse/expireEscalations) → `src/store-escalations.ts`. Comment: spec-094; remote raise is friend+grant gated, fail closed (D4).
- [ ] Step 3: Delegates in class. Gate + `npm run smoke` (feed steps smoke-covered). Commit: `refactor: extract posts/feed/approvals and escalation logic into feature modules`

### Task 8: Extract the local dashboard HTML from http.ts → `src/dashboard-html.ts`

**Files:** Create: `src/dashboard-html.ts` — Modify: `src/http.ts:469-1627`

- [ ] Step 1: Move `dashboardHtml()` (469–1627, ~1,160-line template literal) verbatim → `src/dashboard-html.ts`; export; import in http.ts. Header comment: this is the agent-local reader served by `createEdgeBookHttpServer`; the HOSTED reader lives in edge-book-host (`vendor/reader-src/` is the one-way port seam — do not re-unify).
- [ ] Step 2: Gate + `npm run smoke` (http path). Commit: `refactor: extract local dashboard HTML from http.ts into dashboard-html.ts`

### Task 9: Section/intent comments + invariant docs in remaining files

**Files:** Modify: `src/edge-book.ts`, `src/http.ts`, `src/cli.ts`, `src/dialout.ts`, `src/resolver.ts`

- [ ] Step 1: edge-book.ts header: facade role, module map, the contract-sync rule, justified size exception for the remaining `EdgeBookStore` core (identity/contacts/friends/grants/envelopes/audit are one entangled trust concern). cli.ts header: frozen export surface + why the flat if-chain stays in one file (single dispatch concern; blocks ordered as commands-doc.ts). dialout.ts: wire-protocol.md pointer, stand_down MUST-stop-reconnecting invariant. http.ts: route table comment. Delete narration comments that restate code where touched (do not reformat untouched regions).
- [ ] Step 2: Gate. Commit: `docs: add invariant and module-map comments to core CLI modules`

### Task 10: ARCHITECTURE.md + CLAUDE.md

**Files:** Create: `ARCHITECTURE.md` (50–150 lines), `CLAUDE.md` (≤100 lines)

- [ ] Step 1: ARCHITECTURE.md — module list (one sentence each), entry points (bin, index.js plugin, tsup), data flow (CLI → EdgeBookStore → JSON files; dialout WS ↔ host; mailbox envelopes), contract-sync rule with host repo, frozen surfaces, files not to touch casually (dist/, contract-mirror types, persisted file names).
- [ ] Step 2: CLAUDE.md — exact build/test/smoke/harness commands, no-tsconfig gotcha, frozen surfaces, README sync gate, test policy (tests are the spec).
- [ ] Step 3: Gate. Commit: `docs: add ARCHITECTURE.md and CLAUDE.md for agent legibility`

### Task 11: Phase 4 full verification gate (in order, capture output)

- [ ] `npm run build` → success
- [ ] `npm test` → 243/243
- [ ] `npm run smoke` → 10/10
- [ ] `npm run smoke:host` → requires local host running (start from host repo)
- [ ] `npm run harness:e2e` → CONVERGENCE PASS
- [ ] `npm run sync-readme:check` → up to date
- [ ] Spec re-read: spec-094/095/096/098 + plan-031 — cite file/function where each clause now lives
- [ ] Full `git diff main` review: every hunk is move / rename / comment / doc / one-line delegate
- [ ] Commit any verification-doc updates; then superpowers:requesting-code-review

## Self-review notes

- Type/name consistency: every extracted module re-exported through `src/edge-book.ts` so all 54 test files keep their imports — zero test-file edits expected.
- Justified exceptions to ~800-line target: `src/cli.ts` (~916, flat dispatch, one concern); remaining `src/edge-book.ts` (~1,000–1,300 after extraction: facade re-exports + the trust-core of EdgeBookStore). Both documented in ARCHITECTURE.md.
- Known non-move hunk class: one-line delegate methods (Tasks 5–7) — declared here so the Phase 4 diff review can accept them by category.
