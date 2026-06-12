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
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FakeSocket,
  REPLAY_FIXTURE_SCHEMA,
  discoverFixtures,
  keyPairFromSeed,
  loadFixture,
  runReplayFixture,
  validateFixture,
} from "./replay/replay-harness.ts";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { readEvents } from "../src/event-log.ts";
import type { ReplayFixture } from "./replay/replay-harness.ts";
import { buildFixtureSkeleton, eventsFromBundle } from "./replay/fixture-skeleton.ts";

const SEED_A = "a".repeat(64);

function minimalFixture(overrides: Partial<ReplayFixture> = {}): ReplayFixture {
  return {
    schema: REPLAY_FIXTURE_SCHEMA,
    title: "inline",
    provenance: { origin: "synthetic", source_type: "manual-craft" },
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
  assert.throws(() => validateFixture({ ...minimalFixture(), schema: "nope" }, "f"), /schema must be "edge-book-replay-fixture\/0.2"/);
  assert.throws(() => validateFixture({ ...minimalFixture(), schema: "edge-book-replay-fixture/0.1" }, "f"), /schema must be/);
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

test("provenance is mandatory and vocabulary-checked (spec-0045 / spec-0044)", () => {
  const { provenance: _p, ...withoutProvenance } = minimalFixture();
  assert.throws(() => validateFixture(withoutProvenance, "f"), /provenance \(object with origin\/source_type\) is required/);
  assert.throws(
    () => validateFixture(minimalFixture({ provenance: { origin: "genuine", source_type: "manual-craft" } as never }), "f"),
    /provenance\.origin must be one of real \| synthetic \| synthetic-promoted/,
  );
  assert.throws(
    () => validateFixture(minimalFixture({ provenance: { origin: "synthetic", source_type: "vibes" } as never }), "f"),
    /provenance\.source_type must be one of capa \| judge-log \| trace \| incident-note \| manual-craft/,
  );
  // real / synthetic-promoted need a resolvable source_ref…
  assert.throws(
    () => validateFixture(minimalFixture({ provenance: { origin: "real", source_type: "incident-note" } }), "f"),
    /provenance\.source_ref .* is required when origin is "real"/,
  );
  assert.throws(
    () => validateFixture(minimalFixture({ provenance: { origin: "synthetic-promoted", source_type: "incident-note" } }), "f"),
    /source_ref .* is required when origin is "synthetic-promoted"/,
  );
  assert.throws(
    () => validateFixture(minimalFixture({ provenance: { origin: "real", source_type: "incident-note", source_ref: "" } }), "f"),
    /source_ref must be a non-empty string/,
  );
  // …and can never be manual-craft (a real incident has a source class).
  assert.throws(
    () => validateFixture(minimalFixture({ provenance: { origin: "real", source_type: "manual-craft", source_ref: "ea-claude-130" } }), "f"),
    /"manual-craft" pairs only with origin "synthetic"/,
  );
  // Valid combinations pass.
  assert.doesNotThrow(() => validateFixture(minimalFixture({ provenance: { origin: "real", source_type: "incident-note", source_ref: "ea-claude-130" } }), "f"));
  assert.doesNotThrow(() => validateFixture(minimalFixture({ provenance: { origin: "synthetic-promoted", source_type: "trace", source_ref: "trace-x" } }), "f"));
  assert.doesNotThrow(() => validateFixture(minimalFixture(), "f")); // synthetic/manual-craft, no ref
});

test("deliver timestamps must parse and expires_at must be pinned far-future (ea-claude-141 follow-up)", () => {
  const withDeliver = (patch: Record<string, unknown>): unknown => {
    const fixture = minimalFixture();
    const deliver = { ...(fixture.steps[0] as { deliver: object }).deliver, ...patch };
    return { ...fixture, steps: [{ deliver, expect: { outcome: "accepted" } }] };
  };
  assert.throws(() => validateFixture(withDeliver({ created_at: "not-a-date" }), "f"), /created_at "not-a-date" is not a parseable date/);
  assert.throws(() => validateFixture(withDeliver({ expires_at: "soonish" }), "f"), /expires_at "soonish" is not a parseable date/);
  // A near-term expiry would flip the fixture's outcome mid-life — rejected.
  assert.throws(() => validateFixture(withDeliver({ expires_at: "2027-01-01T00:00:00.000Z" }), "f"), /expires_at must be pinned far-future/);
  assert.doesNotThrow(() => validateFixture(withDeliver({ expires_at: "2099-01-01T00:00:00.000Z" }), "f"));
  // card_expires_at: parseable, card-bootstrap kinds only (PAST values allowed — that is the point).
  assert.throws(() => validateFixture(withDeliver({ card_expires_at: "junk" }), "f"), /card_expires_at must be a parseable date/);
  assert.throws(
    () => validateFixture(withDeliver({ type: "object_share", card_expires_at: "2026-06-01T00:00:00.000Z" }), "f"),
    /card_expires_at only applies to card-bootstrap kinds/,
  );
  assert.doesNotThrow(() => validateFixture(withDeliver({ card_expires_at: "2026-06-01T00:00:00.000Z" }), "f"));
});

test("send_friend_request local steps validate peer, recipient_live, and expect.outbox", () => {
  const base = minimalFixture();
  const withLocal = (local: Record<string, unknown>, expect?: Record<string, unknown>): unknown =>
    ({ ...base, steps: [{ local, ...(expect ? { expect } : {}) }] });
  assert.throws(() => validateFixture(withLocal({ action: "send_friend_request", peer: "ghost" }), "f"), /peer "ghost" is not in identities/);
  assert.throws(
    () => validateFixture(withLocal({ action: "accept_friend", peer: "mallory", recipient_live: false }), "f"),
    /recipient_live .* only applies to send_friend_request/,
  );
  assert.throws(
    () => validateFixture(withLocal({ action: "send_friend_request", peer: "mallory" }, { outbox: { recipient_live: false } }), "f"),
    /expect\.outbox must be an object with envelope_type/,
  );
  assert.doesNotThrow(() => validateFixture(
    withLocal({ action: "send_friend_request", peer: "mallory", recipient_live: false }, { outbox: { envelope_type: "friend_request", recipient_live: false } }), "f"));
});

test("validateFixture rejects notify_cmd and unknown recipient.config keys (fixtures are data, not code)", () => {
  const base = { schema: REPLAY_FIXTURE_SCHEMA, title: "t", provenance: { origin: "synthetic", source_type: "manual-craft" }, identities: { a: { seed: "0".repeat(64), handle: "a" } }, steps: [{ local: { action: "accept_friend", peer: "a" } }] };
  assert.throws(
    () => validateFixture({ ...base, recipient: { config: { notify_cmd: "evil.sh" } } }, "cfg"),
    /notify_cmd is not an allowed fixture config key/,
  );
  assert.doesNotThrow(() => validateFixture({ ...base, recipient: { config: { open_friend_requests: true } } }, "cfg"));
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

test("fixture discovery finds the checked-in fixtures and never reaches into quarantine", async () => {
  const files = await discoverFixtures();
  const names = files.map((f) => path.basename(f));
  for (const expected of [
    "friend-request-accept.json", "duplicate-friend-request-dedup.json", "tampered-friend-request-signature.json",
    "stale-card-friend-request-rejected.json", "queued-friend-request-offline-recipient-outbox.json",
  ]) {
    assert.ok(names.includes(expected), `missing fixture ${expected}; found: ${names.join(", ")}`);
  }
  // Quarantine convention (spec-0045): flaky fixtures move to test/replay/quarantine/,
  // which the discovery glob must never pick up.
  assert.ok(files.every((f) => !f.includes("quarantine")), "discovery must only read test/replay/fixtures/");
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
  // Bundle-derived skeletons carry incident provenance keyed on the trace (spec-0045).
  assert.deepEqual(fixture.provenance, { origin: "real", source_type: "trace", source_ref: "trace-x" });
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

test("malformed mailbox_deliver blob is guarded: logged as unparseable and acked, dial-out stays up (ea-claude-141 follow-up)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-replay-blob-"));
  const store = new EdgeBookStore({ home: path.join(root, "recipient") });
  await store.init({ handle: "blob-guard.replay.local", displayName: "Blob Guard" });
  let socket: FakeSocket | undefined;
  const client = new EdgeBookDialoutClient({
    home: store.home, host: "ws://replay.fixture.test/agent",
    socketFactory: (() => { socket = new FakeSocket(); queueMicrotask(() => socket!.emit("open")); return socket!; }) as never,
    openLocalApi: false, reconnect: false, heartbeatMs: 600_000,
  });
  await client.start();
  try {
    socket!.receive({ type: "mailbox_deliver", id: "blob-1", from: "did:openclaw:garbage", blob_b64: "%%%not-base64-json%%%", ts: Date.now() });
    // handleMailboxDeliver is fire-and-forget off the message handler — poll the flight recorder.
    let logged;
    for (let i = 0; i < 50 && !logged; i++) {
      logged = (await readEvents(store)).find((e) => e.kind === "envelope.received" && e.envelope_kind === "unparseable");
      if (!logged) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logged, "malformed blob must be recorded as envelope.received envelope_kind=unparseable");
    assert.equal(logged!.applied, false);
    // The poison message is still acked so the host deletes it (no redelivery loop).
    assert.ok(socket!.sent.some((f) => f.type === "mailbox_ack" && f.id === "blob-1"), "malformed blob must still be acked");
  } finally {
    await client.stop();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
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
