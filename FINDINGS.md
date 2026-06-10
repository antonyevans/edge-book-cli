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

A tsconfig was NOT added, because making strict mode pass would require code
changes (out of scope). The verification gate for this repo is
`npm run build` + `npm test` + `npm run smoke`.
