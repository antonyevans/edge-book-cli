# spec-134 — `edge-book doctor --send`: opt-in support channel over the relay mailbox

> Design spec for EA task ea-claude-139. Authored 2026-06-10. Status: implemented (branch `debug-harness`).
> Repos: **edge-book-cli** (send path + operator inbox) and **edge-book-host** (recipient discovery + frame-level guards).
> Builds on spec-133 (doctor bundle + event log) and ea-claude-138 (trace_id + /admin/trace).

## Problem (one line)

A user whose agent misbehaves can run `doctor` and paste the bundle somewhere — but there is no consented, rate-limited path that delivers it straight to the operator with a reference both sides can correlate.

## Current state

- `doctor` produces a sanitized-by-construction bundle (spec-133), but shipping it is manual copy-paste.
- The mailbox already relays opaque signed envelopes between any two agents, stamps `trace_id` hops relay-side, and exposes them via `GET /admin/trace/<id>` (ea-claude-138).
- There is no notion of an operator-owned recipient, no abuse floor for unsolicited bundles, and no operator-side queue.

## Insight

The support mailbox does not need new transport: the operator runs an ORDINARY agent identity as the support recipient, the host announces its DID, and `doctor --send` is just a normal directed envelope of a new kind. Everything hard (signing, opacity, store-and-forward, tracing) already exists; the new work is consent, discovery, an abuse floor, and an operator queue.

## Design decision — reserved mailbox recipient, not a host endpoint

Chosen: **well-known DID configured on the host** (`SUPPORT_DID` env var) + a tiny public discovery route. Rejected: a dedicated host-side upload endpoint, because it would force the host to store envelope-adjacent payloads outside the mailbox (new persistence, new TTL logic) and break the "host relays opaque blobs, agents own content" split. With the DID approach the host's only new behavior is frame-level guards on an address it already routes.

## Design

### A. CLI send path (`src/doctor-send.ts`, new module)

1. **Command (additive):** `doctor --send [--yes] [--note <n>] [--to <did>] [--host <wss-url>]`.
2. **Payload = `buildDoctorReport()` output, verbatim** (plus the sender's public card and an optional user-typed note). Normative: never assemble the report any other way — the bundle inherits the spec-133 sanitization guarantee, and `test/support.test.ts` re-asserts the no-secrets property on the exact bytes that leave the agent.
3. **Recipient discovery:** `GET <relay-base>/support/recipient` (or `--to <did>` override). No recipient configured/reachable → fail with `no_support_recipient` before anything is built or sent.
4. **Consent (normative):** print the consent prompt (recipient, byte size vs cap, every bundle section, the note) and require interactive confirmation. `--yes` skips it for agent-driven runs. Non-interactive without `--yes` → `confirmation_required`, FAIL CLOSED.
5. **Envelope:** new `support_bundle` kind (additive member of the `MessageEnvelope.type` union). Body `{ card, report, note? }`. The embedded card bootstraps signature verification at the stranger recipient — same mechanism as `friend_request`. Envelope `expires_at` = 7 days (matches the host mailbox TTL; `signEnvelope` gained an additive optional `expires_at` override, default unchanged at 10 minutes).
6. **Size cap:** serialized envelope ≤ **256 KiB** (`SUPPORT_BUNDLE_MAX_BYTES`, mirrors the host) → else `support_bundle_too_large`, checked client-side before consent so the user never confirms a doomed send.
7. **Support reference:** the envelope's `trace_id` is printed (`support reference: trace_…`). It is the ticket key: the user quotes it, the operator correlates relay hops via `/admin/trace/<id>` and finds the bundle in their queue (`ref=` column).
8. **Event log:** `support.sent` `{to, dedup_key, trace_id}` after the mailbox ack.

### B. Operator inbox (`src/store-support.ts` + `src/cli-support.ts`, new modules)

1. **Opt-in gate (normative, fail closed):** `config.support_inbox === true` (set via `edge-book support inbox --on`) or every inbound `support_bundle` is rejected with `support_inbox_disabled`. Checked BEFORE any verification work.
2. **Receive** (`receiveEnvelope` routes `support_bundle` here): inbound rate throttle (`enforceInboundRate`, same windows as friend requests) → `verifyEnvelope` (replay dedupe by `message_id`; key bootstrapped from the embedded card) → `validateCard` + card/sender DID match → persist to `support-bundles.json` (new persisted file name) with `status: "pending"` → audit + `support.received` event. A notify-registry row announces the bundle by ids/refs only.
3. **Queue commands:** `support pending` (oldest first: id, received_at, sender, `ref=<trace>`), `support read <id>` (renders the report, marks read), `support dismiss <id>`, `support list` (audit view incl. read/dismissed), `support receive <path>` (manual file hop).
4. **No EdgeBookStore delegates:** edge-book.ts is at 493/500 code lines; the routing and CLI import the free functions directly (documented in the module header; delegates can follow a facade split).

### C. Host (`edge-book-host`)

1. **`SUPPORT_DID` env var** — the operator support agent's DID, read per use (rotation without redeploy; ADMIN_TOKEN pattern). Unset → zero special casing.
2. **`GET /support/recipient`** (PUBLIC): `{ ok: true, did }` or fail-closed 404 when unset.
3. **Frame-level guards** on `mailbox_send` whose `to === SUPPORT_DID` (`src/support.ts`, called from channels.ts; the blob stays opaque — frozen invariant intact):
   - blob > 256 KiB → `mailbox_send_err` `support_bundle_too_large`;
   - > **5 sends per sender channel per hour** (in-memory fixed window) → `support_rate_limited`;
   - rejections log a `support_send_reject` structured line.
4. Everything else is the unmodified mailbox contract (store-and-forward, ack-to-delete, trace hops). No new frames.

### D. Events

| Kind | Where | Fields |
|---|---|---|
| `support.sent` | doctor-send.ts after mailbox ack | to, dedup_key, trace_id |
| `support.received` | store-support.ts receive | from, dedup_key, trace_id |

## Compatibility

- `support_bundle` is an additive `MessageEnvelope.type` member; old receivers that get one fail with `unsupported_envelope` (and a support-inbox-disabled agent rejects it deliberately) — nothing existing is reshaped.
- `support-bundles.json` is a new persisted file name; `signEnvelope`'s `expires_at` override is additive with an unchanged default; the frozen `cli.ts` export surface, wire frames, and `/api/*` routes are untouched.
- Host: one new PUBLIC route, no contract/frame changes; with `SUPPORT_DID` unset the host behaves byte-for-byte as before.

## Deployment (operator runbook)

1. Run a dedicated support agent (`edge-book init`, `edge-book support inbox --on`, keep `edge-book dialout` running; set `notify_cmd` to hear about new bundles).
2. `fly secrets set SUPPORT_DID=<that agent's DID>` on the host (plus `ADMIN_TOKEN` for `/admin/trace`).
3. Work the queue: `edge-book support pending` → `support read <id>` → `support dismiss <id>`.
