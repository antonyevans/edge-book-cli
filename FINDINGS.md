# FINDINGS — issues observed during the 2026-06-09 legibility refactor, left untouched

Behavior in this repo is intentionally preserved bug-for-bug by the refactor.
Items here are observations only; none were "fixed".

## 1. No tsconfig.json — typecheck gate unavailable

The refactor brief assumed `npx tsc -p . --noEmit` works here. There is no
`tsconfig.json` in this repo (tsup compiles without typechecking; node runs the
TS sources via type-stripping). A probe with strict compiler flags reports
pre-existing type errors, e.g.:

- `src/cli.ts:688` and `:700` — `string | undefined` assigned to `string`
- `src/dialout.ts:668` — `Buffer` not assignable to `fetch` `BodyInit`

**RESOLVED 2026-06-09 (with owner authorization):** a `tsconfig.json` was added
(host-repo style: `strict: true`, ES2022, Bundler resolution, scoped to `src/`,
plus `allowImportingTsExtensions`/`noEmit` because this repo imports `.ts`
extensions and tsup/node handle compilation). `noUncheckedIndexedAccess` (which
the host enables) is deliberately omitted: it surfaces ~60 additional
indexed-access sites whose fixes would exceed the minimal-change mandate.
The strict-mode errors above were fixed type-level only, with no behavior change:

- `src/cli.ts` — the two `ensureNotifierCron` call sites use a documented
  `home as string` cast: `home` may legitimately be undefined and the function
  reports/catches failures at runtime, so narrowing the value would have changed
  behavior.
- `src/dialout.ts` — `requestBody`'s return annotation tightened from `Buffer`
  to `Uint8Array<ArrayBuffer>` (which `Buffer.from` satisfies), making it
  assignable to fetch's `BodyInit`. Annotation-only.

`npm run typecheck` (`tsc -p . --noEmit`) is now a real gate alongside
`npm run build` + `npm test` + `npm run smoke`.

**RESOLVED 2026-06-10 (with owner authorization):** `noUncheckedIndexedAccess`
is now enabled (PR #3). The 58 surfaced indexed-access sites were fixed
type-level only, zero runtime behavior change:

- `src/http.ts` (13 sites) — non-null assertions on mandatory regex capture
  groups after a successful `.exec` (invariant documented inline).
- `src/store-taxonomy.ts` + `src/edge-book.ts` — `Object.keys(obj)` loops now
  hoist a single asserted alias (`const x = obj[id]!`) per iteration; same
  object reference, identical mutations.
- `src/resolver.ts` — `opportunities[0]!` after the length guard.
- `src/store-friends.ts` — `codes[idx]!` after `findIndex !== -1`.
- `src/harness.ts` (2 sites) — assertions on contacts created earlier in the
  same scenario.

No guards or new code paths were introduced. Test files needed no changes
(tsconfig scopes to `src/`). The bundled `dist/` diff vs the prior main build
contains only the hoisted-alias hunks; pure assertions erase to zero diff, so
no npm publish was required.
