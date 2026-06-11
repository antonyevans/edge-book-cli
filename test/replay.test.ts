// spec-135 / ea-claude-141 — record-and-replay harness.
//
// Two halves:
//   1. Unit tests of the harness itself: fixture validation rejects bad input
//      with clear errors, synthetic keys are seed-deterministic, the skeleton
//      extractor turns bundle events into a loadable fixture, and a fixture
//      whose expectation contradicts real behavior FAILS (the harness is a
//      test, not a formality).
//   2. Fixture discovery: every *.json in test/replay/fixtures/ is validated
//      and replayed through the real dial-out receive path. Dropping a new
//      fixture file in is all the wiring a regression test needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  REPLAY_FIXTURE_SCHEMA,
  discoverFixtures,
  keyPairFromSeed,
  loadFixture,
  runReplayFixture,
  validateFixture,
} from "./replay/replay-harness.ts";
import type { ReplayFixture } from "./replay/replay-harness.ts";
import { buildFixtureSkeleton, eventsFromBundle } from "./replay/fixture-skeleton.ts";

const SEED_A = "a".repeat(64);

function minimalFixture(overrides: Partial<ReplayFixture> = {}): ReplayFixture {
  return {
    schema: REPLAY_FIXTURE_SCHEMA,
    title: "inline",
    identities: { mallory: { seed: SEED_A, handle: "mallory.replay.local" } },
    steps: [{
      deliver: {
        from: "mallory", type: "friend_request",
        message_id: "msg-inline-1", trace_id: "trace-inline-1",
        created_at: "2026-06-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
        body: { note: "inline" },
      },
      expect: { outcome: "accepted" },
    }],
    ...overrides,
  };
}

test("validateFixture rejects malformed fixtures with errors naming the problem", () => {
  assert.throws(() => validateFixture(null, "f"), /must be a JSON object/);
  assert.throws(() => validateFixture({ ...minimalFixture(), schema: "nope" }, "f"), /schema must be "edge-book-replay-fixture\/0.1"/);
  assert.throws(() => validateFixture({ ...minimalFixture(), title: "" }, "f"), /title/);
  assert.throws(
    () => validateFixture({ ...minimalFixture(), identities: { mallory: { seed: "short", handle: "m" } } }, "f"),
    /identities\.mallory\.seed must be 64 hex chars/,
  );
  assert.throws(() => validateFixture({ ...minimalFixture(), steps: [] }, "f"), /steps must be a non-empty array/);
  const fixture = minimalFixture();
  assert.throws(
    () => validateFixture({ ...fixture, steps: [{ ...fixture.steps[0], deliver: { ...(fixture.steps[0] as { deliver: object }).deliver, from: "ghost" } }] }, "f"),
    /steps\[0\]\.deliver\.from "ghost" is not in identities/,
  );
  assert.throws(
    () => validateFixture({ ...fixture, steps: [{ deliver: (fixture.steps[0] as { deliver: object }).deliver, expect: { outcome: "exploded" } }] }, "f"),
    /expect\.outcome must be one of/,
  );
  assert.throws(() => validateFixture({ ...fixture, steps: [{ note: "neither" }] }, "f"), /either "deliver" or "local"/);
  // The error message carries the fixture name so a failing file is findable.
  assert.throws(() => validateFixture(null, "broken.json"), /broken\.json/);
});

test("synthetic identities are seed-deterministic (same seed, same key — never a real user key)", () => {
  const a1 = keyPairFromSeed(SEED_A);
  const a2 = keyPairFromSeed(SEED_A);
  const b = keyPairFromSeed("b".repeat(64));
  assert.equal(a1.public_key_pem, a2.public_key_pem);
  assert.equal(a1.private_key_pem, a2.private_key_pem);
  assert.notEqual(a1.public_key_pem, b.public_key_pem);
});

test("a fixture whose expectation contradicts real behavior fails with the step index", async () => {
  const fixture = minimalFixture();
  (fixture.steps[0] as { deliver: { tamper?: string } }).deliver.tamper = "signature"; // will signature-fail…
  await assert.rejects(runReplayFixture(fixture), /steps\[0\].*expected outcome=accepted, got signature_failed/);
});

test("fixture discovery finds the checked-in seed fixtures", async () => {
  const files = (await discoverFixtures()).map((f) => path.basename(f));
  for (const expected of ["friend-request-accept.json", "duplicate-friend-request-dedup.json", "tampered-friend-request-signature.json"]) {
    assert.ok(files.includes(expected), `missing seed fixture ${expected}; found: ${files.join(", ")}`);
  }
});

test("skeleton extractor: bundle events for a trace become a loadable fixture with TODO bodies", () => {
  const bundle = {
    events: [
      { ts: "2026-06-09T10:00:00.000Z", kind: "envelope.sent", envelope_kind: "friend_request", to: "did:openclaw:peer", dedup_key: "msg-out-1", trace_id: "trace-x" },
      { ts: "2026-06-09T10:00:01.000Z", kind: "envelope.received", envelope_kind: "friend_request", from: "did:openclaw:stranger", dedup_key: "msg-in-1", trace_id: "trace-x", applied: true },
      { ts: "2026-06-09T10:00:02.000Z", kind: "envelope.dedup_hit", envelope_kind: "friend_request", from: "did:openclaw:stranger", dedup_key: "msg-in-2", trace_id: "trace-x" },
      { ts: "2026-06-09T10:00:02.100Z", kind: "envelope.received", envelope_kind: "friend_request", from: "did:openclaw:stranger", dedup_key: "msg-in-2", trace_id: "trace-x", applied: false, error: "Replay detected for msg-in-2" },
      { ts: "2026-06-09T11:00:00.000Z", kind: "envelope.received", envelope_kind: "escalation", from: "did:openclaw:other", dedup_key: "msg-in-3", trace_id: "trace-OTHER", applied: true },
    ],
  };
  const { fixture, notes } = buildFixtureSkeleton(bundle, "trace-x");
  validateFixture(fixture, "skeleton"); // a skeleton must load in the harness as-is
  assert.equal(fixture.steps.length, 2, "one deliver step per envelope.received in the trace");
  const [first, second] = fixture.steps as unknown as [{ deliver: { message_id: string; body?: Record<string, unknown> }; expect: { outcome?: string } }, { deliver: { message_id: string }; expect: { outcome?: string } }];
  assert.equal(first.deliver.message_id, "msg-in-1");
  assert.equal(first.expect.outcome, "accepted");
  assert.equal(second.expect.outcome, "dedup_hit");
  assert.ok(JSON.stringify(first.deliver.body).includes("TODO"), "body is a TODO placeholder — bundles never contain bodies");
  // The stranger DID got exactly one synthetic stand-in identity with a fresh seed.
  assert.equal(Object.keys(fixture.identities).length, 1);
  assert.match(Object.values(fixture.identities)[0]!.seed, /^[0-9a-f]{64}$/);
  assert.ok(notes.some((n) => n.includes("outbound")), "outbound envelope.sent is noted as skipped");

  // Unknown trace ids fail loudly and list what IS available.
  assert.throws(() => buildFixtureSkeleton(bundle, "trace-missing"), /available trace_ids: .*trace-x.*trace-OTHER/);
  // Support-bundle wrapping (body.report.events) is unwrapped transparently.
  assert.equal(eventsFromBundle({ body: { report: { events: bundle.events } } }).length, bundle.events.length);
});

// ── Fixture discovery loop: every checked-in fixture replays green ──────────
const fixtureFiles = await discoverFixtures();
for (const file of fixtureFiles) {
  test(`replay fixture: ${path.basename(file)}`, async () => {
    const fixture = await loadFixture(file);
    const result = await runReplayFixture(fixture);
    assert.equal(result.steps.length, fixture.steps.length, "every step produced a transcript entry");
  });
}
