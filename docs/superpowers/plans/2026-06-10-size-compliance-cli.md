# edge-book-cli Size-Compliance Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the 4 grandfathered files (dialout.ts 642, cli.ts 835, edge-book.ts 1005, dashboard-html.ts 1157 code lines) below 500 code lines each, delete their `eslint-disable max-lines` comments, with zero observable behavior change.

**Architecture:** Pure move-refactor. Every hunk is a verbatim move of existing code to a new module, an import-path update, a disable-comment deletion, or an ARCHITECTURE.md doc update. `EdgeBookStore` keeps one-line delegates (established `store-*.ts` pattern); `handleCli` stays the frozen dispatch entry; `dashboardHtml()` output must stay byte-identical (sha256-verified).

**Tech Stack:** TypeScript on Node 22 (type-stripping, `.ts` import extensions), tsup bundle, `node --test`, ESLint `max-lines: 500` (code lines).

**Conventions that bind every task:**
- Moved code is copied VERBATIM from the stated line ranges of the source file at branch point `5473408` — no renames, no reformatting, no logic edits.
- The `eslint-disable max-lines` comment in each target file stays until that file is under 500; deleting it is the LAST edit of the final task for that file.
- After every commit: `npx eslint src --quiet` (clean except remaining grandfathered disables), `npm test` (243 pass). `npm run smoke` after any dialout/http change. Hash check after any dashboard-html change.
- ARCHITECTURE.md module table updated in the same commit as each extraction.
- Frozen: exports of `src/cli.ts`, wire frames, contract types, command names/flags, persisted file shapes.

---

### Task 0: Generator baseline hash (dashboard)

**Files:** Create `/tmp/hash-dashboard.mjs` (throwaway, not committed)

- [ ] **Step 1: Write the hash script**

```js
import { createHash } from "node:crypto";
import { dashboardHtml } from "/home/antony/.config/superpowers/worktrees/edge-book-cli/refactor-size-compliance/src/dashboard-html.ts";
console.log("dashboard.html", createHash("sha256").update(dashboardHtml()).digest("hex"));
```

- [ ] **Step 2: Capture baseline**

Run: `node /tmp/hash-dashboard.mjs | tee /tmp/baseline-hashes.txt`
Expected: one line `dashboard.html <64-hex>`.

---

### Task 1: dialout.ts (642 → ~480) — calibration target

**Files:**
- Create: `src/dialout-key.ts` (~110 code lines)
- Create: `src/dialout-local-api.ts` (~70 code lines)
- Modify: `src/dialout.ts`, `src/cli.ts:19` (type import path), `test/dialout.test.ts` (import paths)
- Tests covering: `test/dialout.test.ts`, `test/sessions-rpc.test.ts`, `test/mvp-mailbox.test.ts`, `test/handle-claim.test.ts`, relay tests, `npm run smoke`

- [ ] **Step 1: Create `src/dialout-key.ts`** — transport-key + pairing-code material. Move VERBATIM from dialout.ts: consts `KEY_FILE`, `DEFAULT_PAIR_TTL_MS`, `PAIRING_ALPHABET` (lines 24, 26, 30); interfaces `DialoutKey` (32–39), `PairRegistration` (63–71), `SessionsRevokeFrame` (73–76); functions `now` (146–148), `keyId` (150–152), `channelIdForKey` (154–156), `chmodBestEffort` (165–172), `loadOrCreateDialoutKey` (174–210), `generatePairingCode` (212–218), `createPairRegistration` (220–231), `createSessionsRevokeFrame` (233–239). Header comment: key/pairing concern, frame shapes frozen by host `docs/wire-protocol.md`. Imports: `node:crypto`, `node:fs/promises`, `node:path`, `EdgeBookStore` from `./edge-book.ts`. Export everything dialout.ts/cli.ts/tests need: `DEFAULT_PAIR_TTL_MS`, `KEY_FILE` stays module-private? — NO: dialout.ts does not use KEY_FILE elsewhere; keep `KEY_FILE` private to dialout-key.ts.
- [ ] **Step 2: Delete the moved code from dialout.ts**; import what dialout.ts still uses (`DEFAULT_PAIR_TTL_MS`, `DialoutKey` type?, `channelIdForKey`?, `loadOrCreateDialoutKey`, `createPairRegistration`, `createSessionsRevokeFrame`, `now`?) from `./dialout-key.ts`. Do NOT re-export (no barrel) — update importers instead:
  - `test/dialout.test.ts`: `createPairRegistration`, `createSessionsRevokeFrame`, `loadOrCreateDialoutKey` → from `../src/dialout-key.ts`
  - `src/cli.ts:19`: `SessionsRevokeFrame` type → from `./dialout-key.ts`
  - grep `channelIdForKey|generatePairingCode|DialoutKey|PairRegistration` across src/ test/ scripts/ and update any other importer.
- [ ] **Step 3: Verify** — `npx eslint src --quiet` clean, `npm test` 243 pass, `npm run smoke` 10/10.
- [ ] **Step 4: Update ARCHITECTURE.md module table** (add dialout-key.ts row).
- [ ] **Step 5: Commit** `refactor: extract dialout-key.ts from dialout.ts`
- [ ] **Step 6: Create `src/dialout-local-api.ts`** — local-API bridge for proxied `/api/*` frames. Move VERBATIM: interfaces `DialoutApiRequest` (41–51), `DialoutApiResponse` (53–61), `LocalApi` (139–144); functions `serverBaseUrl` (255–259), `closeServer` (261–263), `openLocalApi` (265–279), `normalizeApiPath` (281–284), `apiUrl` (286–288), `requestBody` (290–296). Imports: `node:http`, `EdgeBookError, EdgeBookStore` from `./edge-book.ts`, `startEdgeBookServer` from `./http.ts`. Export all of the above (`LocalApi` too — the client class fields reference it).
- [ ] **Step 7: Delete moved code from dialout.ts**, import from `./dialout-local-api.ts`. Update any external importers of `DialoutApiRequest`/`DialoutApiResponse` (grep first).
- [ ] **Step 8: Verify** eslint (dialout.ts must now be under 500 — temporarily check via `sed '/eslint-disable.*max-lines/d' src/dialout.ts | npx eslint --stdin --stdin-filename src/dialout.ts`), tests, smoke.
- [ ] **Step 9: DELETE the `eslint-disable max-lines` comment at dialout.ts:1.** Re-run `npx eslint src --quiet`.
- [ ] **Step 10: Update ARCHITECTURE.md**, commit `refactor: extract dialout-local-api.ts from dialout.ts; drop max-lines disable`

---

### Task 2: cli.ts (835 → ~190) — per-command feature modules

**Files:**
- Create: `src/cli-shared.ts` (~95), `src/cli-identity.ts` (~210), `src/cli-social.ts` (~320), `src/cli-taxonomy.ts` (~140)
- Modify: `src/cli.ts` (dispatch stays; blocks become one-line calls)
- Tests: full suite (cli.test.ts and friends exercise every command), `npm run smoke`, `npm run sync-readme:check`

`handleCli` keeps its frozen signature and remains the only dispatch entry. Each feature module exports one handler `handle<X>Cli(command: string, args: string[], ctx: CliContext, home: string | undefined): Promise<CliResult | null>` mirroring the existing block bodies exactly; returns null when the command is not its concern. NOTE: inspect actual block-local variables (`home`, `store`, `host`…) when extracting — pass exactly what each block already computes from `parseHome`/`parseHost`; do not restructure logic. If a block constructs `store` inline, the moved code does the same inside the feature module.

- [ ] **Step 1: Create `src/cli-shared.ts`** with the parsing/delivery helpers moved VERBATIM from cli.ts: `usage` stays in cli.ts (uses commands-doc); move `takeFlag` (46–52), `parseHome` (54–56), `parseHost` (58–61), `relayBaseFromHost` (63–65), `requireArg` (67–70), `takeBoolFlag` (72–78), `takeRepeatedKV` (80–92), `takeRepeated` (94–102), `readEnvelope` (104–106), `deliverToEndpoint` (108–111), `deliverToPeer` (113–125), `broadcastPost` (127–142), `serverAddress` (144–148). Also move type definitions `CliContext` (30–35) and `CliResult` (37–40) here, and in cli.ts re-export: `export type { CliContext, CliResult } from "./cli-shared.ts";` (cli.ts is the allowed frozen re-export surface — its public exports must not change).
- [ ] **Step 2: Verify + commit** `refactor: extract cli-shared.ts from cli.ts` (eslint, npm test).
- [ ] **Step 3: Create `src/cli-identity.ts`** — move VERBATIM the `init` (160–183), `handle` (184–196), `identity` (197–220), `profile` (221–322), `doctor` (323–327), `card` (328–358) blocks into `handleIdentityCli`. In cli.ts replace those blocks with:
  ```ts
  const identityResult = await handleIdentityCli(command, args, ctx);
  if (identityResult) return identityResult;
  ```
  (adjust to the actual per-block local variables — keep evaluation order identical: the blocks run in the same position in the dispatch sequence).
- [ ] **Step 4: Verify + commit** `refactor: extract cli-identity.ts from cli.ts`.
- [ ] **Step 5: Create `src/cli-social.ts`** — move `resolve` (359–366), `candidates` (367–377), `friend` (378–512), `object` (513–568), `contacts` (569–581), `message` (582–598), `escalation` (599–652), `inbox` (653–667) blocks into `handleSocialCli`. Same dispatch replacement pattern, same position.
- [ ] **Step 6: Verify + commit** `refactor: extract cli-social.ts from cli.ts`. Run `npm run smoke` too (friend/object flows).
- [ ] **Step 7: Create `src/cli-taxonomy.ts`** — move `attest` (789–798), `endorse` (799–818), `signal` (819–830), `capability` (831–853), `query|share|coordinate|delegate` (854–869), `answer` (870–890), `query-delete` (891–896), `ephemeral` (897–901), `answers` (902–906), `report` (907–917) into `handleTaxonomyCli`.
- [ ] **Step 8: Verify** — cli.ts must now be under 500 (stdin-eslint check). DELETE the disable at cli.ts:1. `npx eslint src --quiet`, `npm test`, `npm run smoke`, `npm run sync-readme:check`.
- [ ] **Step 9: Update ARCHITECTURE.md** (4 new rows), commit `refactor: extract cli-taxonomy.ts from cli.ts; drop max-lines disable`.

(The `serve/dialout/ensure-notifier/pair/sessions/relay/harness` blocks, usage, runCli, and the dispatch skeleton stay in cli.ts — ~190 code lines.)

---

### Task 3: edge-book.ts (1005 → ~430) — continue store-*.ts extraction

**Files:**
- Create: `src/store-identity.ts` (~300), `src/store-trust.ts` (~250), `src/store-notify.ts` (~115)
- Modify: `src/edge-book.ts` (bodies become one-line delegates `return fn(this, …)`)
- Tests: full suite (identity/grants/envelope/session tests), `npm run smoke`

Pattern (established): free functions `fn(store: EdgeBookStore, …)`; class keeps same-named one-line delegates so the public class API (the test spec) is unchanged. edge-book.ts is the allowed facade — it keeps its re-export surface.

- [ ] **Step 1: Create `src/store-identity.ts`** — move bodies VERBATIM (each becomes `export async function x(store: EdgeBookStore, …)` with `this` → `store`): `init` (159–189), `setProfile` (202–252), `setHandle` (255–266), `exportIdentity` (270–272), `importIdentity` (274–289), `updateConfig` (295–309), `buildCard` (311–342), `writeCard` (344–348), `buildHandleClaim` (352–361), `buildFriendProfile` (365–377), `doctor` (379–419), `deregister` (809–845), `reviewLocalDataImport` (1286–1307), `exportLocalData` (1309–1321). Class methods become one-line delegates. NOTE `this.` → `store.` is the ONLY permitted textual transform. `identity()` and `config()` (pure readJson, 3 lines each) STAY in the class — every module calls them constantly.
- [ ] **Step 2: Verify + commit** `refactor: extract store-identity.ts from edge-book.ts`.
- [ ] **Step 3: Create `src/store-trust.ts`** — move: `enforceInboundRate` (463–483), `issueGrant` (562–580), `storeGrant` (582–595), `sendPrivilegedMessage` (597–621), `receivePrivilegedMessage` (623–640), `findUsableGrant` (905–915), `verifyGrantSignature` (923–935), `assertGrantSignature` (940–945), `signEnvelope` (981–991), `verifyEnvelope` (993–1015), and the web sessions cluster `createSession` (1086–1104), `requireSession` (1106–1116), `revokeSession` (1118–1126). Keep `sessions`/`saveSessions`/`contacts`/`saveContacts`/`grants`/`saveGrants`/`inbox`/`audit`/`auditEvents` in the class (3-line readers used by everything). Preserve the security comments verbatim with the moved code.
- [ ] **Step 4: Verify + commit** `refactor: extract store-trust.ts from edge-book.ts`. Run `npm run smoke` (envelope/grant paths).
- [ ] **Step 5: Create `src/store-notify.ts`** — move: `NotifyPolicy` type (59–62), `peerName` (65–67), `NOTIFY_POLICIES` (69–132), `notificationIntent` body (1037–1046), `wasNotified` (1050–1053), `recordNotified` (1055–1060).
- [ ] **Step 6: Verify** — edge-book.ts under 500 (stdin-eslint check; if marginally over, also delegate `receiveEnvelope` routing (1021–1032) into store-trust.ts as `receiveEnvelope(store, envelope)`). DELETE the disable at edge-book.ts:1. Full gate: eslint, npm test, npm run smoke.
- [ ] **Step 7: Update ARCHITECTURE.md** (3 new rows + amend the "WHAT STAYS IN THIS FILE" header comment in edge-book.ts to reflect the new layout), commit `refactor: extract store-notify.ts from edge-book.ts; drop max-lines disable`.

---

### Task 4: dashboard-html.ts (1157 → ~100) — byte-identical generator split

**Files:**
- Create: `src/dashboard-styles-base.ts` (~300), `src/dashboard-styles-components.ts` (~300), `src/dashboard-script.ts` (~470)
- Modify: `src/dashboard-html.ts` (keeps `dashboardHtml()` markup + composition)
- Verification: sha256 hash vs `/tmp/baseline-hashes.txt` after EVERY step; `npm test`; `npm run smoke`

The template literal contains ZERO `${}` interpolations. Split = cut the literal at exact line boundaries into exported `const X = \`…\`` strings and recompose with `${X}` insertions such that the concatenation is byte-identical (watch the cut points: the char after a cut must line up exactly — cut at line boundaries and keep the newline ownership consistent).

- [ ] **Step 1: Create `src/dashboard-script.ts`** — `export const DASHBOARD_SCRIPT` = the inline script body (current lines 697–1161, i.e. between `<script>` and `</script>` tags; tags stay in the composing template). Recompose in dashboard-html.ts via `${DASHBOARD_SCRIPT}`.
- [ ] **Step 2: Hash check** `node /tmp/hash-dashboard.mjs` (pointing at the worktree) — MUST equal baseline. `npm test`. If hash differs: revert, re-cut.
- [ ] **Step 3: Commit** `refactor: extract dashboard-script.ts from dashboard-html.ts` (+ARCHITECTURE.md row).
- [ ] **Step 4: Create the two style modules** — split the `<style>` inner content (current lines 17–611) at a top-level rule boundary nearest the midpoint (~line 314, find exact `}` / selector start): `DASHBOARD_STYLES_BASE` (root vars, layout, shell) and `DASHBOARD_STYLES_COMPONENTS` (cards, lists, items, buttons, inspector…). Each file must be under 500 code lines. Recompose via `${DASHBOARD_STYLES_BASE}${DASHBOARD_STYLES_COMPONENTS}`.
- [ ] **Step 5: Hash check** — byte-identical. `npm test`.
- [ ] **Step 6: dashboard-html.ts under 500 → DELETE disable at line 1.** `npx eslint src --quiet`.
- [ ] **Step 7: Update ARCHITECTURE.md**, commit `refactor: split dashboard styles/script into modules; drop max-lines disable`.

---

### Task 5: Repo gate (Phase 3)

- [ ] `npx eslint src --quiet` → clean
- [ ] `grep -rn "eslint-disable max-lines" src/` → no output
- [ ] `npm test` → 243 pass
- [ ] `npm run build` → tsup OK
- [ ] Manual typecheck: `npx tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck src/*.ts` → only the 3 known pre-existing errors (FINDINGS.md)
- [ ] `npm run smoke` → 10/10; `npm run smoke:host` (needs host — if it spins one up locally, run; record result); `npm run harness:e2e`; `npm run sync-readme:check`
- [ ] `node /tmp/hash-dashboard.mjs` → matches baseline
- [ ] Read entire branch diff (`git diff origin/main`) — every hunk is a move / import update / disable deletion / doc update
- [ ] Code review (superpowers:requesting-code-review), finish branch (superpowers:finishing-a-development-branch), open PR. DO NOT MERGE.

**Per-file final code-line counts** (verify each new module < 500 via `npx eslint src --quiet` staying silent).
