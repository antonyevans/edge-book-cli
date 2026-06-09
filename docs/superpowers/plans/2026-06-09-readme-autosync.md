# README refresh + auto-sync system (ea-claude-085) Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** (1) Make the CLI command reference impossible to let drift: a single command registry feeds BOTH `edge-book --help` AND the README table, regenerated automatically on commit. (2) Refresh the README prose for the 0.9.0 feature set (two-tier profiles, friend-request notify/approve/profile-exchange, abuse floor, escalation).

**Architecture:** New `src/commands-doc.ts` exports a structured `COMMAND_GROUPS` registry (groups → rows of `{usage, desc}`). `usage()` in `src/cli.ts` renders its text from the registry (output stays equivalent). `scripts/sync-readme.ts` renders a markdown table from the SAME registry and rewrites the README between `<!-- COMMANDS:START -->`/`<!-- COMMANDS:END -->` markers; `--check` mode exits non-zero if stale. A tracked `.githooks/pre-commit` runs the sync and `git add README.md`; `core.hooksPath` is wired via an npm `prepare` script. `prepublishOnly` runs `--check` so a stale README can't be published.

**Tech Stack:** TS (ESM, node20), `node --test`, `tsup`, `tsx` (already a devDep). No new deps. Base: branch off `main` (`63f0686`+; 0.9.0 features all merged). Baseline suite 194/194, smoke 10/10.

**No tests assert `--help`/usage text** (verified), so rendering usage() from the registry is safe — but keep output sensible and run the full suite.

---

## File Structure

| File | Change |
|---|---|
| `src/commands-doc.ts` | NEW — `COMMAND_GROUPS` registry (single source of truth) + `renderUsage()` + `renderReadmeTable()` |
| `src/cli.ts` | `usage()` delegates to `renderUsage()` |
| `scripts/sync-readme.ts` | NEW — write/`--check` the README command block from the registry |
| `.githooks/pre-commit` | NEW — run sync + `git add README.md` |
| `package.json` | `prepare` (wire hooksPath), `sync-readme`, `sync-readme:check`, `prepublishOnly` += check |
| `README.md` | markers + generated table; refreshed prose for 0.9.0 |
| `test/commands-doc.test.ts` | NEW — registry covers all CLI commands; render round-trips |

---

## Task 1: command registry + renderers (TDD)

**Files:** `src/commands-doc.ts` (new); `test/commands-doc.test.ts` (new)

- [ ] **Step 1: Failing test** — `test/commands-doc.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_GROUPS, renderUsage, renderReadmeTable } from "../src/commands-doc.ts";

test("registry is non-empty and every row has usage + desc", () => {
  const rows = COMMAND_GROUPS.flatMap((g) => g.rows);
  assert.ok(rows.length >= 20);
  for (const r of rows) { assert.ok(r.usage.trim()); assert.ok(r.desc.trim()); }
});

test("renderUsage produces grouped text including key commands", () => {
  const u = renderUsage();
  for (const c of ["init", "profile set", "profile visibility", "friend request", "friend pending",
                    "friend policy", "report", "object share", "escalation raise", "candidates list"]) {
    assert.ok(u.includes(c), `usage missing: ${c}`);
  }
});

test("renderReadmeTable is a markdown table with a header and the same commands", () => {
  const t = renderReadmeTable();
  assert.ok(t.includes("| Command | What it does |"));
  assert.ok(t.includes("`friend policy"));
  assert.ok(t.includes("`report"));
});
```

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3: Implement** `src/commands-doc.ts`. Define `interface CommandRow { usage: string; desc: string }` and `interface CommandGroup { title: string; rows: CommandRow[] }`, export `COMMAND_GROUPS: CommandGroup[]` covering EVERY current command (read `src/cli.ts` command handlers to enumerate — include: `init`, `profile show/set/visibility/broadcast`, `card show/export/invite`, `dialout`, `pair`, `sessions list/revoke`, `doctor`, `resolve`, `candidates list`, `friend request/accept/apply-response/revoke/block/pending/mark-notified/notify-config/policy`, `report`, `object create/share/revoke/list/read`, `contacts list/refresh`, `message send/receive`, `inbox list/pull`, `escalation raise/list/receive/answer/respond`, plus the post-taxonomy commands `attest/endorse/signal/capability/query/share/coordinate/delegate/answer` if present). Then:
  - `renderUsage(): string` — produce the grouped help text (header `Edge Book\n\nUsage:` + each group's title + rows as `  edge-book <usage>` lines). Keep it readable.
  - `renderReadmeTable(): string` — a single markdown table `| Command | What it does |` with one row per command (escape `|` in usage as `\|`), optionally grouped by `### <title>` subheaders between table chunks (simplest: one flat table).

- [ ] **Step 4:** Run → PASS; `npm run build`. Commit: `feat(docs): command registry single-source for help + README`

## Task 2: wire usage() to the registry

**Files:** `src/cli.ts`

- [ ] **Step 1:** Replace the body of `usage()` (lines 27-82) with `return renderUsage();` and import `renderUsage` from `./commands-doc.ts`. Keep the `--help` behavior (the `help` command returns `{ text: usage() }`).
- [ ] **Step 2:** `node bin/edge-book.js --help` after `npm run build` prints the grouped list including the new commands. Full suite green. Commit: `refactor(cli): render usage() from the command registry`

## Task 3: sync-readme script + markers (TDD-ish)

**Files:** `scripts/sync-readme.ts` (new); `README.md` (add markers)

- [ ] **Step 1:** In `README.md`, replace the hand-maintained `## Command reference` table with marker-wrapped generated content:

```
## Command reference

<!-- COMMANDS:START (auto-generated from src/commands-doc.ts — do not edit by hand) -->
<!-- COMMANDS:END -->

`edge-book --help` lists everything. `--home <dir>` runs against a specific agent directory.
```

- [ ] **Step 2: Implement** `scripts/sync-readme.ts`:
  - Import `renderReadmeTable` from `../src/commands-doc.ts`.
  - Read `README.md`, find the `<!-- COMMANDS:START ... -->` and `<!-- COMMANDS:END -->` markers, replace everything between with `\n` + `renderReadmeTable()` + `\n`.
  - If `--check` is passed: do NOT write; if the regenerated content differs from current, print a message and `process.exit(1)`; else exit 0.
  - Otherwise write the file. Throw clearly if markers are missing.

- [ ] **Step 3:** Run `npx tsx scripts/sync-readme.ts` → README table populated. Run `npx tsx scripts/sync-readme.ts --check` → exit 0 (in sync). Manually break the table, re-run `--check` → exit 1. Restore via a write run.

- [ ] **Step 4:** Add npm scripts to `package.json`: `"sync-readme": "tsx scripts/sync-readme.ts"`, `"sync-readme:check": "tsx scripts/sync-readme.ts --check"`, and change `"prepublishOnly"` to `"npm run sync-readme:check && npm run build"`. Commit: `feat(docs): sync-readme script (generate + --check) and prepublish guard`

## Task 4: pre-commit hook auto-wired

**Files:** `.githooks/pre-commit` (new); `package.json` (`prepare`)

- [ ] **Step 1:** Create `.githooks/pre-commit` (executable, `chmod +x`):

```sh
#!/bin/sh
# Auto-sync the README command reference from src/commands-doc.ts on commit.
if [ -x node_modules/.bin/tsx ]; then
  node_modules/.bin/tsx scripts/sync-readme.ts || { echo "edge-book: sync-readme failed"; exit 1; }
  git add README.md
fi
exit 0
```

(If tsx isn't installed — a fresh clone before `npm i` — the hook no-ops so it never blocks a commit.)

- [ ] **Step 2:** Add `"prepare": "git config core.hooksPath .githooks || true"` to `package.json` scripts. This wires the hook path on any dev `npm install` (and no-ops for registry consumers, who don't run a published package's `prepare`).

- [ ] **Step 3:** Activate now: run `git config core.hooksPath .githooks` and `chmod +x .githooks/pre-commit`. Verify: edit a command's `desc` in `src/commands-doc.ts`, `git commit` it, and confirm the hook regenerated + staged README in the same commit (the README change rides the commit). Then revert the test edit.

- [ ] **Step 4:** Commit: `feat(docs): pre-commit hook auto-syncs README; prepare wires hooksPath`

## Task 5: refresh README prose for 0.9.0

**Files:** `README.md`

- [ ] **Step 1:** Update the **Naming & privacy** section → **Your profile** to describe the two-tier model: minimal public card vs the friend-only `FriendProfile` (name, bio, location, socials), **default-on for friends, per-field visibility `friends`/`public`/`off`**; show `profile set --name "You" --bio "…" --social telegram=@you` and `profile visibility bio=off telegram=public`. Note the legacy `--owner/--share-owner` still work and that existing identities migrate (name → friends by default).

- [ ] **Step 2:** Add a **Friend requests** subsection to the connect flow: an inbound request notifies the human (Notifications section) AND surfaces in the reader as an Accept/Reject approval; accepting exchanges friend profiles and issues the friend grant; the requester's reply auto-routes back.

- [ ] **Step 3:** Add an **Abuse floor** subsection: open by default (anyone resolving you may request); `friend policy --invite-only` flips to invite-only (unsolicited dropped unless they carry an invite code from `card invite --uses N`); inbound throttle protects your approval queue; `report <peer> [--block]`.

- [ ] **Step 4:** Add a one-paragraph **Escalation** mention: an agent (or a collaborating friend, gated by a grant) can ask your human a question/decision and route the answer back (`escalation raise/list/answer`, Escalations tab in the reader).

- [ ] **Step 5:** Run `npm run sync-readme` (regenerate the table for any final registry tweaks), `npm run sync-readme:check` (exit 0), `npm run build`, full suite + smoke green. Commit: `docs: refresh README for 0.9.0 (profiles, friend requests, abuse floor, escalation)`

---

## Self-Review
- **Drift prevention:** registry is the single source; `usage()` + README table both render from it; pre-commit regenerates + stages; `prepublishOnly --check` blocks publishing a stale README. ✅
- **Robustness:** hook no-ops without tsx (never wedges commits); `prepare` wires hooksPath for devs, no-ops for consumers; markers make the generated region explicit.
- **Content:** prose covers every 0.9.0 surface (profiles, notify, approve, exchange, abuse floor, escalation, candidates already covered).
- **No placeholders:** all code/markup given; registry enumerated from the actual cli.ts handlers (implementer confirms the full set before writing).
