# spec-135 — Record-and-replay harness: doctor bundles → deterministic regression fixtures

> Design spec for EA task ea-claude-141. Authored 2026-06-10. Status: implemented (branch `debug-harness`).
> Repo: **edge-book-cli** only — test/scripts infrastructure; no src changes, no wire-protocol, envelope-schema, or CLI-surface changes.
> Builds on spec-133 (event log + doctor bundle), ea-claude-138 (trace_id propagation), spec-134 (`doctor --send` support channel).

## Problem (one line)

A captured user failure (a doctor bundle with an event-log tail and trace_ids) can be diagnosed but not *kept*: there is no way to turn "this envelope sequence broke the agent" into a deterministic test that runs forever in `npm test`.

## Insight

The flight recorder already captures the shape of every protocol failure (envelope kinds, dedup keys, trace_ids, outcomes) — everything except bodies and keys, which are *deliberately* absent. So a replay fixture stores the sequence shape plus a synthetic reconstruction of the missing parts, and a harness drives it through the **real** receive path: `mailbox_deliver` frames into an `EdgeBookDialoutClient` over the FakeSocket seam → `handleMailboxDeliver` → `receiveEnvelope` → `verifyEnvelope` → type handler → event log → ack. Nothing is mocked below the socket.

## Design

### A. Fixture format (`edge-book-replay-fixture/0.1`)

A fixture is one JSON file in `test/replay/fixtures/`:

```jsonc
{
  "schema": "edge-book-replay-fixture/0.1",
  "title": "failure case: duplicate friend_request hits the dedup ledger",
  "description": "…",
  "source": { "doctor_bundle": "…", "trace_id": "…", "note": "…" }, // provenance, informational only
  "identities": {                       // SYNTHETIC senders only (see C)
    "mallory": { "seed": "<64 hex>", "handle": "mallory.replay.local", "display_name": "…" }
  },
  "recipient": { "handle": "…", "display_name": "…", "config": { /* EdgeBookConfig overrides */ } },
  "steps": [
    { "deliver": {                      // an inbound envelope through the dial-out mailbox
        "from": "mallory",              // identity ref
        "type": "friend_request",       // any MessageEnvelope type
        "message_id": "msg-replay-dup-001",
        "trace_id": "trace-replay-dup-001",
        "created_at": "2026-06-01T00:00:00.000Z",
        "expires_at": "2099-01-01T00:00:00.000Z",   // pin far future (see determinism)
        "body": { "note": "synthetic reproduction" }, // card auto-embedded for bootstrap kinds
        "tamper": "signature"           // optional: mutate payload AFTER signing
      },
      "expect": {
        "outcome": "accepted" | "dedup_hit" | "signature_failed" | "rejected",
        "error": "Replay detected",     // substring of the apply error
        "events": [ { "kind": "envelope.dedup_hit", "trace_id": "…", "fields": { "applied": false } } ],
        "relationship_state": "request_received"     // sender's state in the recipient store
      } },
    { "local": { "action": "accept_friend" | "reject_friend", "peer": "mallory" },
      "expect": { "events": [{ "kind": "friend.accepted" }], "relationship_state": "friend" } }
  ]
}
```

Expected events are matched against the recipient's `events.ndjson`; for deliver steps the expected `trace_id` defaults to the step's own trace_id — the assertion that trace correlation survives the real path is built in.

### B. Replay engine (`test/replay/replay-harness.ts` — test helper, not shipped)

1. **Materialization:** each fixture identity becomes a real `EdgeBookStore` whose ed25519 keypair derives from the fixture seed (RFC 8410 PKCS8 prefix + raw seed), imported via the real `importIdentity` so `writeCard` produces valid, verifiable cards. The recipient store is `init`-ed fresh per run.
2. **Drive path:** one `EdgeBookDialoutClient` over the recipient home with the FakeSocket seam (pattern: test/dialout-friend-relay.test.ts / support.test.ts). Each deliver step is signed with the synthetic sender key (envelope fields verbatim from the fixture), base64-encoded, and injected as a `mailbox_deliver` frame; the per-step outcome is captured via `onEnvelope`.
3. **Outcome classification:** `accepted` = applied; `dedup_hit` / `signature_failed` = not applied + the matching flight-recorder event for that dedup_key; anything else not applied = `rejected` (refine with `expect.error`).
4. **Failure reporting:** the first expectation mismatch throws with fixture title + step index + got/expected (and the observed event kinds), so a red fixture reads like a bug report.
5. **Determinism (normative):** message_id, trace_id, created_at, expires_at, bodies, and sender keys all come from the fixture; no network (FakeSocket only), no test-controlled randomness. The one wall-clock dependency is `verifyEnvelope`'s expiry check — fixtures MUST pin a far-future `expires_at` (convention: `2099-01-01T00:00:00.000Z`). Incidental fresh values (recipient DID, card timestamps) exist but no assertion depends on them.

### C. Synthetic-identity rule (normative)

Fixtures store seeds/keys for **synthetic identities only — never real user keys**. We never *have* a user's private key (doctor bundles carry public ids only, by spec-133 construction), so a captured real-world failure is replayed by re-signing the reconstructed envelopes with synthetic stand-ins. Equally, bundles never contain message bodies — the operator supplies a synthetic reproduction body. A fixture therefore reproduces the *shape* of a failure (sequence, kinds, dedup keys, traces, outcomes), which is what the receive path dispatches on.

### D. Extraction path (`scripts/extract-replay-fixture.ts` + `test/replay/fixture-skeleton.ts`)

A repo script, **not** a CLI command: extraction is an operator/dev workflow that turns a received bundle into a repo test fixture. It never runs on a user's agent, so it stays off the frozen `edge-book` command surface (no commands-doc.ts/README churn, nothing added to the npm bundle).

```
node scripts/extract-replay-fixture.ts <doctor-bundle.json> [--trace <trace_id>|all] [--out <file>]
```

Accepts a raw `DoctorReport`, a received support-bundle body, or a bare `{ events: [...] }` excerpt. For the chosen trace it emits a **skeleton** fixture: one deliver step per `envelope.received` event (outcome inferred from `applied`/companion dedup/signature events), one synthetic identity per distinct sender DID (fresh random seed; original DID kept in `display_name` as provenance), TODO body placeholders, and stderr notes for skipped outbound events. Unknown trace_ids fail listing the available ones. Skeletons validate against the harness before being written.

The skeleton is a starting point, not a finished test — e.g. a `dedup_hit` whose first delivery fell outside the bundle's event tail needs the operator to add that first delivery by hand.

### E. Operator workflow

1. User: `edge-book doctor --send` (spec-134) or pastes `edge-book doctor --json`.
2. Operator: `edge-book support read <id>` → save bundle JSON; pick the failing trace from its `traces` section.
3. `node scripts/extract-replay-fixture.ts bundle.json --trace <id> --out test/replay/fixtures/<name>.json`
4. Fill in synthetic bodies, rename identities, tighten `expect` (events, relationship_state, error substrings).
5. Done — `test/replay.test.ts` discovers every `test/replay/fixtures/*.json` at load time and replays each as its own test in `npm test`. No registration step.

## Seed fixtures (checked in)

- `friend-request-accept.json` — happy path: inbound friend_request applied (`friend.request_received`, `envelope.received applied=true`), local accept → `relationship_state=friend` + `friend.accepted`.
- `duplicate-friend-request-dedup.json` — at-least-once redelivery of the same message_id: first delivery accepted, replay rejected by the seen-message ledger with `envelope.dedup_hit` carrying the original trace_id.
- `tampered-friend-request-signature.json` — payload mutated after signing: `verifyEnvelope` rejects with `envelope.signature_failed`; no contact is created.

## Test plan (implemented — test/replay.test.ts)

- Fixture validation rejects malformed input with errors naming the field, step index, and source file.
- Seed-derived keys are deterministic; distinct seeds give distinct keys.
- A fixture whose expectation contradicts real behavior **fails** with the step index (the harness can't pass vacuously).
- Discovery finds the three seed fixtures; every discovered fixture replays green.
- Skeleton extractor: trace filtering, outcome inference (accepted/dedup_hit), TODO bodies, one synthetic identity per sender, unknown-trace error listing available traces, support-bundle unwrapping.
