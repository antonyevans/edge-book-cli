# Replay fixture quarantine

A replay fixture that flakes in CI — **one** intermittent failure — moves here
immediately (spec-0045, the incident-to-fixture standing rule in the EA repo:
`12-operations/spec-incident-replay-fixtures.md`). Never retry-until-green in
place: tolerated flaps destroy trust in the whole gate.

Rules:

- This directory is **outside the discovery glob**: `discoverFixtures()` reads
  only `test/replay/fixtures/`, so nothing in here runs in `npm test`
  (`test/replay.test.ts` asserts that).
- Each quarantine move gets a FINDINGS.md entry: date, fixture, the observed
  flap, and suspected nondeterminism source.
- A quarantined fixture is either repaired deterministically (move it back) or
  deleted with a FINDINGS note — never silently restored.

Empty today. May it stay that way.
