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

## Commands

```bash
npm test               # node --test test/*.test.ts — full suite, must stay green
npm run build          # tsup → dist/edge-book.js
npm run smoke          # 2-agent end-to-end against a local in-process host
npm run smoke:host     # same against a running edge-book-host
npm run harness:e2e    # convergence e2e (pair→share→revoke→audit)
npm run sync-readme:check  # README command table gate (runs on prepublish)
```

## Gotchas

- **No tsconfig.json.** `tsc` is not part of the gate; node runs the TS sources
  via type-stripping and tsup bundles without typechecking. A missed type-only
  import will NOT fail tests — typecheck manually with
  `npx tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck src/*.ts`
  (3 known pre-existing errors; see FINDINGS.md).
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
