# spec-097 — Delivery receipts: delivered/acked truth for senders

> Design spec for EA task ea-claude-130. Authored 2026-06-10. Status: draft (pending judge).
> Status: approved (judge PASS, 2 iterations, 2026-06-10).
> Deferred from spec-096 (the June 9 stale-DID incident's "single fix that would have made it self-diagnosing").
> Repos: **edge-book-host** (relay frames + receipt ledger) + **edge-book-cli** (sender outbox, status command, send-time warnings). Coordinated release.

## Problem (one line)

"Dispatched successfully" lies: the sender only ever sees the relay's *enqueue* ack, so mail addressed to a dead DID sits orphaned forever while both humans believe it arrived (the June 9 friending incident).

## Current state

- Wire flow (docs/wire-protocol.md:87-125): sender → `mailbox_send` → relay replies `mailbox_send_ok {id}` (enqueue only); recipient gets `mailbox_deliver {id}` when a live channel claims the address; recipient's `mailbox_ack {id}` **deletes** the message. The same host-assigned `id` flows end-to-end.
- The relay records only **aggregate** counters (`enqueued/delivered/acked/ack_rejects`, server.ts:405-414 `/metrics`); per-message delivery state dies with the ack-delete (`ackMailbox`, store.ts:186). Diagnosing June 9 required `fly ssh console` + reading `state.json` by hand.
- The sender CLI (`--deliver` paths, cli-social.ts) prints `(host id ${ack.id})` and discards the id; `deliverEnvelopeViaMailbox` (dialout.ts:545-554) closes the socket immediately after `mailbox_send_ok`, so no async frame could reach it anyway.
- The `sessions_list`/`sessions_list_ok` RPC pair (wire-protocol.md:137-160) is the established pattern for synchronous request/response frames keyed by `request_id`.
- Liveness is knowable at send time: the relay resolves recipients to live channels by channel_id or DID scan (channels.ts:396-405) — it just never tells the sender.

## Insight

Receipts do not require push-to-offline-senders (a sender mailbox — out of scope). Two cheap, synchronous truths close the gap: (1) at **send time**, the relay already knows whether any live channel claims the recipient — say so in `mailbox_send_ok`; (2) at **any later time**, a `mailbox_status` RPC over per-message state (queued with timestamps / delivered / acked, the last preserved in a small receipts ledger) lets the sender's CLI answer "did it actually arrive?" — which makes a stale queue visible the moment anyone asks, instead of never.

## Design

### A. Relay: per-message state (edge-book-host)

1. `StoredMailboxMessage` gains `delivered_at?: number` — set (first time only) when the message is pushed in a `mailbox_deliver`. **Stamping strategy (normative):** `mailboxForRecipient` strips host-internal fields before returning wire shapes (store.ts:175, the `{ expires_at: _omit, ...wire }` pattern — `delivered_at` joins that strip list), so the stamp cannot ride on the returned object. Instead `deliverQueued` calls a new store method `markDelivered(id, now)` for each message it actually writes to the socket, which sets `delivered_at` directly on `state.mailbox[id]` and persists. Absent = never pushed.
2. **Receipts ledger:** on authorized ack, before deleting the message, record `receipts[id] = { acked_at, to, from }` (`from` is the channel_id the host stamped at enqueue — see §B auth). New `receipts: Record<string, ReceiptEntry>` key in `State`. **Bounds (normative):** entries expire after `EDGE_BOOK_RECEIPT_TTL_MS` (default 7 days) — implemented by extending the existing `store.purge()` loop (store.ts:140-153), which today iterates pairing_codes/sessions/device_tokens/mailbox; receipts purge compares `acked_at + TTL` against now. Cap (default 10 000) enforced at insert time: when over cap, sort entries by `acked_at` ascending and delete oldest until at cap (`Record` carries no order; `acked_at` is the order). Stored in state.json — restart-safe like the mailbox itself.
3. Aggregate counters and `/metrics` unchanged (additive: `receipts_ledger_size` may be added to `/metrics`).

### B. Wire protocol: two additive changes (docs/wire-protocol.md updated)

1. **`mailbox_send_ok` gains `recipient_live: boolean`** — whether, at enqueue time, any live channel claims `to`. **Ordering (normative):** today the handler sends `mailbox_send_ok` and *then* calls `deliverQueued(to)` (channels.ts:301-322), so the liveness answer must be computed before the ack. Extract the recipient→live-channel resolution that `deliverQueued` does inline (channels.ts:396-405, channel_id lookup + DID scan) into a shared helper `resolveLiveChannel(to)`; the send handler calls it for the ack field, `deliverQueued` reuses it for delivery. `resolveLiveChannel` reads from the **in-memory `channels` Map** (the only place liveness exists — the store has no liveness concept; resolving against the store would yield always-false). Read-only, no behavior change to delivery itself. Old hosts omit the field; old clients ignore it. Nothing else about the frame changes.
2. **New RPC pair** (modeled on `sessions_list`):

```
Agent → Host: { "type": "mailbox_status", "request_id": "<uuid>", "ids": ["<message_id>", ...] }   // ≤50 ids
Host → Agent: { "type": "mailbox_status_ok", "request_id": "<uuid>", "statuses": [
  { "id": "...", "state": "queued" | "delivered" | "acked" | "unknown",
    "queued_ms": <number, present for queued/delivered>, "recipient_live": <boolean, present for queued/delivered> }
] }
```

- `queued` = in mailbox, `delivered_at` unset. `delivered` = in mailbox, pushed at least once but not acked (push may have been lost — at-least-once semantics, redelivery on reconnect still applies). `acked` = in receipts ledger. `unknown` = neither (expired, evicted, or never existed). For `acked`/`unknown`, `queued_ms` and `recipient_live` are **absent** (key omitted, not null) — standard optional-field discipline.
- **Authorization (fail closed):** a status entry is returned only if the requesting channel's `channel_id` equals the message's stored `from` (the host stamps `from` with the sender's channel_id at enqueue, store.ts:159-164 — there is never a DID in `from`, so channel_id equality is the whole rule). Otherwise that id reports `unknown`. Mirrors the `mailbox_ack` recipient-authorization rule (channels.ts:324-342); probing reveals nothing. **Known limit (accepted):** a sender who regenerates their transport key (`host-dialout-key.json`) gets a new channel_id and loses visibility into receipts for messages sent under the old one — receipts are a diagnostic convenience, not durable history, and transport-key rotation is already documented as harmless precisely because nothing durable binds to it. Not worth DID-indexing the ledger for.
- Malformed frame → `mailbox_status_err { request_id, error }` (same shape discipline as `mailbox_send_err`).

### C. Sender CLI (edge-book-cli)

1. **Outbox ledger (new `src/store-outbox.ts`, `outbox.json` in the agent home, sibling of `identity.json`/`candidates.json`):** a **JSON array** (insertion-ordered; not the keyed-object house pattern, because cap eviction needs order) of `{ id, to_agent_id, envelope_type, sent_at, recipient_live }`; every successful `--deliver` appends; capped at 200 entries by dropping from the front. This is what makes receipts usable later — today the id is printed and lost.
2. **Honest send-time output:** after `mailbox_send_ok`, the `--deliver` paths replace "Delivered … (host id …)" with state-accurate text:
   - `recipient_live: true` → `Sent — recipient's agent is connected (host id <id>).`
   - `recipient_live: false` → `Queued — recipient's agent is NOT connected; it will arrive when they reconnect. Check later: edge-book outbox (host id <id>).`
   - field absent (old host) → current wording unchanged (graceful degradation).
   The word "Delivered" no longer appears at enqueue time anywhere.
3. **`edge-book outbox` (new command):** reads outbox.json, opens one transient connection, sends a single `mailbox_status` for the recorded ids, prints one line per entry: type, recipient (contact display name where known), age, and state — with a **loud warning** for any entry `queued` with `queued_ms > EDGE_BOOK_STALE_QUEUE_MS` (default 10 minutes) **or** `recipient_live: false`: `"⚠ undelivered for <age> — the recipient's agent may be running under a different identity; ask them for a fresh invite."` (the June 9 diagnosis, automated). `--json` for agents. Against an old host → prints local ledger with `state: "unknown (host does not support receipts)"`, exit 0. **Degradation mechanism (normative):** an old host answers an unknown frame with `{ type: "error", error: "unknown_message_type", ref: "mailbox_status" }` (wire-protocol.md error frame), which today falls through unhandled in `handleMessage` (dialout.ts:442) and the pending RPC times out. The client handles **both** paths: resolve the pending `mailbox_status` request on a matching `error` frame (fast path) *and* on RPC timeout (lost-frame path) — same local-only outcome either way.
4. The dial-out's transient-connection model is unchanged: `mailbox_status` is request/response on an open socket (send path can reuse the already-open connection; `outbox` opens its own), no long-lived listener needed.

### D. Compatibility & rollout

All changes additive: old client + new host (extra field ignored, RPC unused) and new client + old host (field absent → old wording; RPC timeout → graceful local-only outbox) both work. Rollout order: host deploy first, then npm publish. wire-protocol.md is updated in the same host PR (frozen-surface discipline: no existing frame field renamed or removed).

## Out of scope

Push receipts to offline senders (sender-side mailbox — a future spec if outbox polling proves insufficient); read receipts (recipient *human* saw it — only agent-applied `ack` exists); relay-initiated stale-queue alerts (cron/metrics alerting is ops, not protocol); deliberate key-rotation `handle_rebind` / `identity rotate` (spec-096 Phase 2); any change to envelope formats or dedup semantics.

## Files to change

| Repo | File | Change |
|---|---|---|
| host | `src/store.ts` | `delivered_at`, receipts ledger (record/lookup/purge/cap) |
| host | `src/channels.ts` | stamp `delivered_at`; `recipient_live` in `mailbox_send_ok`; `mailbox_status` handler + sender auth |
| host | `docs/wire-protocol.md` | new field + RPC pair documented |
| host | `test/mailbox-receipts.test.ts` | NEW — host tests below |
| cli | `src/store-outbox.ts` | NEW — outbox ledger |
| cli | `src/dialout.ts` | `mailbox_status` RPC client (pending-request pattern, like sessions_list); surface `recipient_live` from send ack |
| cli | `src/cli-social.ts` | honest send wording; record outbox entries |
| cli | `src/cli.ts` / `src/commands-doc.ts` | `outbox` command + README regen |
| cli | `test/outbox.test.ts` | NEW — cli tests below |

## Tests (TDD — red first)

**Host (`mailbox-receipts.test.ts`, TestAgent pattern from mailbox.test.ts):**
- Send to offline recipient → `mailbox_send_ok.recipient_live === false`; to online recipient → `true`.
- `mailbox_status` from the sender: offline-recipient message reports `queued` with `queued_ms ≥ 0`, `recipient_live: false`; after recipient connects (delivery pushed, no ack) → `delivered`; after ack → `acked` with the message gone from the mailbox but present in the ledger; a random id → `unknown`.
- Authorization: a third agent querying someone else's message id gets `unknown` (not the real state); the recipient (non-sender) also gets `unknown`.
- Restart-safety: acked receipt survives a store reload; `delivered_at` survives reload.
- Ledger bounds: entry older than TTL purged; cap eviction drops oldest.
- `/metrics` unchanged shape (existing observability tests stay green).

**CLI (`outbox.test.ts`, FakeMailboxHost/FakeSocket pattern from mvp-mailbox.test.ts, extended with the new frames):**
- `--deliver` against a host reporting `recipient_live: false` → output contains `Queued` and `NOT connected`, never `Delivered`; ledger entry written with the id.
- `--deliver` with `recipient_live: true` → `Sent — recipient's agent is connected`.
- Old-host shape (no `recipient_live`, no `mailbox_status_ok`) → legacy wording; `outbox` exits 0 with unknown states.
- `outbox` with a fake host returning `queued` + stale `queued_ms` → output contains the loud warning line; `--json` round-trips states.
- Outbox cap: 201st entry evicts the oldest.
- Old-host error-frame path: fake host replies `{type:"error", error:"unknown_message_type", ref:"mailbox_status"}` → `outbox` resolves immediately to local-only output (no timeout wait).

**End-to-end offline→reconnect→ack (host repo, not the smoke):** the full sequence lives in `mailbox-receipts.test.ts` using the TestAgent pattern — the existing keystone test (mailbox.test.ts:104-136) already exercises offline → reconnect → deliver → ack against a real host instance; the receipts test extends that sequence with `mailbox_status` assertions at each stage (queued → delivered → acked). The two-agent smoke gains **no new step** (its FakeSocket/host harness has no mid-test disconnect facility); live verification against the deployed host is an acceptance item instead.

Both repos: existing suites green, lint green, README sync green.

## Acceptance

- [ ] Reproduce the June 9 scenario (mail to a DID no channel claims): the sender is told at send time the recipient is not connected, and `edge-book outbox` shows the loud stale warning — no `fly ssh` required.
- [ ] Happy path: send → deliver → ack is visible as `acked` from the sender's CLI.
- [ ] No third party can read another sender's message states (fail-closed auth proven by test).
- [ ] Old client ↔ new host and new client ↔ old host both behave gracefully (proven by tests).
- [ ] wire-protocol.md updated in the same PR; host deployed before npm publish; live smoke green against the deployed host.
