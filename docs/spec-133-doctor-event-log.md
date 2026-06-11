# spec-133 — Protocol event log + `edge-book doctor` diagnostic bundle

> Design spec for EA task ea-claude-137. Authored 2026-06-10. Status: implemented (branch `debug-harness`).
> Repo: **edge-book-cli** only — no host/wire-protocol changes, no new frames, no persisted-format changes to existing files.
> Follow-ups out of scope here: trace-id propagation across agents (the `trace_id` field is reserved), `doctor --send` (shipping the bundle somewhere).

## Problem (one line)

When the protocol misbehaves in the field, nothing records what actually happened: diagnosing the June 9 friending incident meant reading `state.json` by hand, and there is no single command a user can run (and paste) that says what their agent can see, reach, and has done.

## Current state

- `doctor` (cli-identity.ts → store-identity.ts `doctor`) checks only the local store: file presence/modes, card validity, key-file permissions. It dumps raw `config` (which may embed a notify-command token) and says nothing about the relay, dial-out, friends, or history.
- The audit trail (`audit.jsonl`) is append-only and unbounded, keyed to trust actions, and stores error strings — useful, but not a paste-safe operational record and never read by any command.
- Protocol touchpoints (dial-out connects/reconnects, envelopes in/out, dedup rejections, signature failures, notification delivery, cron self-install) leave no queryable trace at all.

## Insight

A tiny sanitized-by-construction flight recorder plus one read-only command closes the gap: every protocol touchpoint appends one NDJSON line of ids/kinds/keys (never bodies, never keys, never tokens), and `doctor` assembles identity + reachability + store counts + the event tail into one bundle that is safe to paste into a public issue.

## Design

### A. Protocol event log (`src/event-log.ts`, new module)

1. **File:** `events.ndjson` in the agent home (registered in `store-files.ts` — a persisted name like every other store file). One JSON object per line.
2. **Record shape:** `{ ts: ISO-string, kind: string, ...context fields, trace_id?: string }`. Context fields are scalars only (`string | number | boolean`). `trace_id` is reserved for cross-agent correlation — nothing sets it yet (follow-up task).
3. **Ring buffer (deterministic cap):** `MAX_EVENT_LINES = 2000`; when an append pushes the file past the cap, it is atomically rewritten (temp + rename, same discipline as `fs-json.writeJson`) keeping only the newest `COMPACT_KEEP_LINES = 1000`.
4. **Never-throw invariant (normative):** `logEvent` swallows all failures — event logging must never break the protocol path it observes. `readEvents` tolerates corrupt/partial lines (skip, same policy as `readJsonl`).
5. **Sanitized by construction (normative):** call sites log agent ids, fingerprints, envelope kinds, dedup keys, hosts, counts, and booleans — **never** message/post bodies, private keys, or tokens. The one deliberate omission: `notify.failed` does NOT log the delivery error string (a notify command's stderr could echo the message body); the audit trail keeps it.

### B. Instrumented touchpoints

| Kind | Where | Fields |
|---|---|---|
| `dialout.connected` | dialout.ts `hello_ok` | host |
| `dialout.disconnected` | dialout.ts socket close | host, stopped |
| `dialout.reconnect_scheduled` | dialout.ts backoff | host, delay_ms |
| `dialout.stand_down` | dialout.ts stand_down frame | host, reason, idle_ms |
| `envelope.sent` | dialout.ts `sendEnvelope` | envelope_kind, to, dedup_key (message_id) |
| `envelope.received` | dialout.ts `handleMailboxDeliver` | envelope_kind, from, dedup_key, applied, error? |
| `envelope.dedup_hit` | store-trust.ts `verifyEnvelope` replay check | envelope_kind, from, dedup_key |
| `envelope.signature_failed` | store-trust.ts `verifyEnvelope` | envelope_kind, from, dedup_key |
| `notify.attempted` / `notify.delivered` / `notify.failed` / `notify.suppressed` | notify.ts `notifyInbound` | kind, from, dedup_key (+ reason on suppressed) |
| `friend.request_received` | store-friends.ts `receiveFriendRequest` | from, dedup_key |
| `friend.accepted` | store-friends.ts `acceptFriend` | peer |
| `friend.state_changed` | store-friends.ts `setRelationship` | peer, previous, next, event_type |
| `cron.notifier_installed` / `cron.notifier_already_present` | cli.ts `dialout` / `ensure-notifier` call sites | — |

### C. `edge-book doctor` (src/doctor.ts, rewired cli-identity.ts block)

1. **Command surface (additive — name unchanged, flags new):** `doctor [--json] [--host <wss-url>]`. Default output is human-readable text; `--json` prints the full `DoctorReport`. `--host` follows the standard resolution (flag > `EDGE_BOOK_HOST` > default).
2. **Sections:** package version; identity (fingerprint = agent DID, handle, display name); relay reachability (one GET against the https base derived from the dial-out host, 3 s timeout, any HTTP status = reachable, latency reported, offline degrades to `reachable: false` + error — never throws); dial-out state (transport-key presence + last `dialout.connected` / `dialout.disconnected` events); pending friend requests (count + requester id/display name); notify status (`notify_cmd` configured **as a boolean only**, per-type toggle, Hermes notifier-cron state); store counts (contacts/friends/posts/objects/escalations/pending approvals); event-log tail (last 50).
3. **Back-compat:** the legacy store-check fields (`initialized`, `pass`, `card_valid`, `private_key_mode_ok`, `files`, `home`) stay at the top level of the JSON (test/edge-book.test.ts pins them). The legacy raw `config` echo is **dropped** from the CLI output — `config.notify_cmd` may embed a channel token and the bundle must be paste-safe. `EdgeBookStore.doctor()` itself is unchanged (internal callers unaffected).
4. **Paste-safety is tested, not asserted:** test/doctor.test.ts seeds a store with a known message body and post body and proves neither the JSON nor the rendered text contains the marker or any private-key material.

### D. Compatibility

- `events.ndjson` is a new persisted file name; nothing existing is renamed or reshaped. Agents upgrading start logging on first protocol action; doctor on a pre-upgrade home shows an empty tail.
- No wire-protocol, envelope-schema, or `/api/*` route changes. The frozen `cli.ts` export surface is untouched.

## Test plan (implemented)

- `test/event-log.test.ts` — append/read ordering, ring-buffer cap + eviction determinism, corrupt/partial-line tolerance, never-throw on unwritable home, persisted file location.
- `test/doctor.test.ts` — full-report section coverage on a seeded two-friend store, sanitization (message/post body marker + private-key material absent from JSON and text), offline relay grace, uninitialized-home grace, CLI text vs `--json` shapes.
- `test/edge-book.test.ts` legacy doctor test unchanged in its assertions (now pins `--host` to a closed local port so the reachability probe never touches the network).
