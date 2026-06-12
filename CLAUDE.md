# edge-book-cli — agent instructions

Read `ARCHITECTURE.md` for the code map. Specs in `docs/` (spec-094/095/096/098,
plan-031) are normative for behavior.

## Size rules (read first — a hook enforces these)

- No source file may exceed 500 code lines (`npm run lint`; a PostToolUse hook
  blocks oversized edits).
- New features get new modules — see @DESIGN.md for the placement table.
  **If unsure where code goes: create a new file, never append.**
- Never add `eslint-disable max-lines` without a justification comment and a
  follow-up extraction task.

## Verification commands (spec-0042 — run before claiming done)

All non-interactive with meaningful exit codes. A completion claim names the
command(s) run and their observed output — "done" without evidence is not done.

```bash
npm run lint           # eslint src — size/style gates, must be clean
npm run typecheck      # tsc -p . --noEmit (strict) — must be clean
npm test               # node --test test/*.test.ts — full suite, must stay green
npm run build          # tsup → dist/edge-book.js
npm run smoke          # 2-agent end-to-end against a local in-process host
npm run smoke:host     # same against a running edge-book-host
npm run harness:e2e    # convergence e2e (pair→share→revoke→audit)
npm run sync-readme:check  # README command table gate (runs on prepublish)
```

CI (`ci.yml`) runs lint → typecheck → tests on every push and PR; merging on
red is prohibited.

## Workflow (spec-0041 / spec-0042)

This repo is **plain** (merging does not deploy). After a fresh-context review
passes, the agent may merge — unless the task says otherwise.

- Worktree + branch per task (`feat|fix|refactor|chore/<slug>`); never work on
  `main`. Hard ceiling: 4 parallel agent sessions per repo (default 2–3).
- Target PR size ≤ ~400 changed lines of authored code; bigger work splits
  into independently reviewable stacked PRs.
- Production-bound work gets a **fresh-context review**: a separate session
  with no memory of writing the code reads the full diff before the PR is
  ready. Self-review by the writing session does not count.
- **Frozen tests:** during refactors, assertions/fixtures/inputs are frozen —
  a failing test means the step changed behavior; revert the step, never edit
  the test. A test believed wrong goes to FINDINGS.md untouched.
- New behavior ships with tests in the same PR, colocated per repo pattern.
- **Reversions:** agent code substantially rewritten or reverted within 30
  days of merge gets one line (date, PR, cause) in FINDINGS.md `## Reversions`.

## Learnings (docs/LEARNINGS.md)

- Read `docs/LEARNINGS.md` before any non-trivial task; treat entries as hints
  to verify, not overrides of current evidence.
- Every incident or refactor session appends an entry there (Trigger /
  Observation / Action / Confidence / Status) — or updates an existing one.
  Two-strikes rule: the second occurrence of the same lesson promotes it to a
  formal rule in this file.
- Division of labor: FINDINGS.md holds the facts (grandfathered exceptions;
  `## Reversions` date/PR/cause); LEARNINGS.md holds the why/avoid lesson —
  cross-reference, never restate.
- The monthly gardening pass (spec-0038) prunes stale/low-confidence entries,
  promotes 2x-triggered patterns, and updates the `_Last gardening pass_` header.

## Gotchas

- `npm run typecheck` is a real gate (strict + `noUncheckedIndexedAccess`,
  scoped to `src/`) but node runs the TS sources via type-stripping and tsup
  bundles without typechecking — a type error will NOT fail `npm test`, so
  always run typecheck separately. History in FINDINGS.md.
- Internal imports use explicit `.ts` extensions (`./edge-book.ts`).
- A pre-commit hook regenerates the README command table from
  `src/commands-doc.ts` — never edit the table by hand.
- New CLI commands must be added to `commands-doc.ts` or the README sync gate
  fails on publish.

## Frozen surfaces (do not rename/reshape)

- `src/cli.ts` exports (npm + OpenClaw plugin contract via `index.js`)
- wire frames (canonical: `edge-book-host/docs/wire-protocol.md`)
- contract types mirrored from `edge-book-host/src/contracts.ts`
- persisted file names/shapes (`src/store-files.ts`) and envelope schemas
- CLI command names/flags and `/api/*` routes (the hosted reader renders them)

## Conventions

- `store-*.ts` feature modules export free functions `fn(store, …)`;
  `EdgeBookStore` keeps same-named one-line delegates. Add new store behavior
  in a feature module, not inline in the class.
- The test suite is the behavioral spec: never weaken an assertion to make a
  change pass.

## Ownership

- ARCHITECTURE.md "Module ownership" names the accountable owner per module
  class; .github/CODEOWNERS routes review. Frozen surfaces change only via an
  owner-approved PR — never reshaped in place (supersede, do not edit).
