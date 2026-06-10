# Spec: Generic default-on inbound notifications (notify-hook for any message type)

**Status:** draft / ready for Codex+Superpowers implementation
**Date:** 2026-06-09
**Author:** Claude (EA session, diagnosing ea-claude-111)
**Related:** ea-claude-096 (notifications, shipped but never auto-provisioned), ea-claude-094 (human escalation channel), ea-claude-111 (bug: friend requests never reach Telegram), ea-claude-125 (this work)

> Scope note: originally scoped to friend_request only. Per owner direction (2026-06-09) this is **generalised to notify on ANY inbound envelope type** — friend_request is just the first registered type. The system must be usable for any current or future inbound format.

---

## Problem

Edge Book is **transport-free by design** — it never sends Telegram/Slack itself; delivery is the host runtime's job. Today the only notifier is a **manual** Hermes-cron README step scoped to friend requests. As a result:

- `edge-book init` never mentions notifications → users are **silent-by-default**;
- it covers friend_request only — an inbound **gated message, object share, or escalation produces no notification at all**;
- the "automatic" install path (agentvillage `DIGEST_CRON_SPECS`) was documented but never built.

Confirmed live (ea-claude-111): inbound friend requests are received + acked by the dial-out but never notified. The same silent-by-default gap applies to **every inbound message type**, every user, every runtime.

## Goals

1. **Default-on, generic notifications.** A fresh agent running the dial-out notifies its human on **any notifiable inbound envelope** — friend_request, friend_response, gated message, object_share, escalation, and future types — with no manual cron.
2. **Extensible to any inbound format.** Adding a new inbound type = register one policy+renderer entry; no changes to transport or delivery code.
3. **Transport-free.** Edge Book invokes a **host-provided notify command**; it never learns about Telegram.
4. **Universal across transports.** Notifiability is decided at the single inbound choke point so it works whether the envelope arrived via mailbox, direct, relay, or local.
5. **Real-time**, with a **fallback** poll for standing-state types and a coordinated dedup so nothing double-notifies.

## Non-goals

- Implementing any specific transport inside edge-book (host supplies the command).
- Reply/accept routing ("human says yes" → accept) — separate from notification.
- Changing the relay/mailbox or any message data model.

---

## Design

### 1. Core: a transport-free notification dispatcher (the heart of the generalisation)

Add a single choke point at `EdgeBookStore.receiveEnvelope(...)` (src/edge-book.ts) — the one place **every** inbound envelope is applied regardless of transport. After a successful apply, compute an optional **NotificationIntent** from a per-type registry:

```ts
interface NotificationIntent {
  kind: string;          // envelope.type, e.g. "friend_request", "friend_gated_message"
  message: string;       // pre-rendered, human-readable, safe to display
  from_id: string;       // envelope.from_agent_id
  from_name?: string;    // resolved display_name (best-effort)
  dedup_key: string;     // stable per logical notification (default: envelope.message_id)
  meta?: Record<string,string>; // extra type-specific fields for the host command env
}

type NotifyPolicy = (env: MessageEnvelope, store: EdgeBookStore) =>
  Promise<NotificationIntent | null>; // null = silent
```

A **registry** maps `envelope.type → NotifyPolicy`. Each policy decides notify-vs-silent and renders a type-appropriate message. `receiveEnvelope` returns/emits the intent (or null) **without performing any delivery** — keeping core transport-free. Delivery is the entry point's job (§2).

**Default policy table** (config-overridable; see §4):

| Inbound type | Default | Renderer gist | Dedup key | Cron-sweepable? |
|---|---|---|---|---|
| `friend_request` | notify | "<name> wants to connect — reply yes / ignore" | contact-based (`notified_at`) | yes (pending list) |
| `friend_response` | notify | "<name> accepted/declined your request" | message_id | no (event) |
| `friend_gated_message` | notify | "<name>: <message preview>" | message_id | no (event) |
| `object_share` | notify | "<name> shared <object summary>" | message_id | no (event) |
| `escalation` (ea-094) | notify | escalation prompt for the human | escalation/approval id | yes (pending) |
| `escalation_response` | route/notify | per ea-094 | message_id | no |
| `profile_share` | silent | internal two-step completion | — | — |
| `revoke` | silent (audit) | — | — | — |
| unknown / unregistered | configurable default (recommend: silent + audit `notify.unhandled_type`) | generic | message_id | no |

The registry is the extension point: **a new inbound format becomes notifiable by adding one row** (policy + renderer). Everything downstream (delivery, dedup, env contract) is type-agnostic.

### 2. Entry points: invoke the host notify command

Each inbound entry point consumes the intent and delivers it:

- **Dial-out (primary, ships first):** the seam already exists — `EdgeBookDialoutClient.handleMailboxDeliver` fires `this.options.onEnvelope?.(envelope,{applied,error})` (src/dialout.ts:440) but the `dialout` CLI command (src/cli.ts:658) passes no handler. Wire `onEnvelope` to: take the intent produced by `receiveEnvelope`, and if non-null, invoke the host `notify_cmd`.
- **Future:** an HTTP/local-server receive path can reuse the identical intent → notify_cmd step. Because the intent is computed in core, no per-transport rendering logic is duplicated.

### 3. Notify-command contract (the transport-free boundary)

- **Config (host-set, trusted), priority:** `--notify-cmd` flag → `EDGE_BOOK_NOTIFY_CMD` env → `notify_cmd` in `config.json`.
- **Invocation:** run the operator-configured command; pass **untrusted, remote-controlled content only via stdin + env** — never string-interpolated into the command.
  - **stdin:** `intent.message` (UTF-8).
  - **env:** `EB_NOTIFY_KIND=intent.kind`, `EB_NOTIFY_FROM_ID`, `EB_NOTIFY_FROM_NAME`, `EB_NOTIFY_DEDUP_KEY`, plus flattened `intent.meta.*` as `EB_NOTIFY_<KEY>`.
- The host command is **type-agnostic**: it just delivers stdin to the human's channel (on Hermes, a thin wrapper over the existing telegram home-channel delivery). One command serves all message types.
- **Timeout** the spawn (~10s); timeout = failure.

### 4. Config surface

- `notify_cmd` (above).
- `notify_types`: optional list/whitelist of inbound types to notify on (default = the table's `notify` rows). Lets an operator broaden/narrow without code.
- Per-type opt-outs keep working (e.g. existing `notify_on_friend_request:false`); generalise to `notify_<type>:false` honoured by the policy.
- `notify_default_unhandled`: `silent` (recommended) | `generic` — what to do with unregistered types.

### 5. Idempotency + fallback coordination

- **Generic notified ledger** keyed by `dedup_key` (default `message_id`), persisted (extend `seen-messages.json` or a new `notified.json`). The entry point records the key **only on notify success**; checks it before sending to prevent double-notify across (a) multiple entry points, (b) hook + cron, (c) mailbox redelivery. Apply-once (`verifyEnvelope` replay rejection) already gives most of this; the ledger covers the rest.
- **Standing-state types** (`friend_request`, `escalation`) keep their existing pending queries + `notified_at` stamp so the **fallback cron** can sweep them. The cron and hook share the stamp/ledger → never double-notify.
- **Event types** (gated message, object_share, friend_response) are transient — **the hook is their notifier**; there is no cron sweep for them (you cannot poll for a past event). This is acceptable because the hook is default-on once `notify_cmd` is set. The fallback cron remains a backstop for standing-state types only.

### 6. Fallback install (backstop for standing-state types)

Provision the existing friend-requests poll automatically instead of by hand:
- **Hermes/agentvillage:** add to declarative `DIGEST_CRON_SPECS` / `reconcileDigestCronJobs` (cross-repo; not local).
- **OpenClaw:** verify the heartbeat loader schedules the plugin's `skills/edge-book/heartbeat.md`.
Generalise the poll prompt to surface pending **escalations** too, not just friend requests.

### 7. Onboarding

`edge-book init` must stop implying notifications "just work": surface that a `notify_cmd` (real-time, all types) or a host cron (standing-state fallback) is required, ideally via an `edge-book setup-notifications` helper.

---

## Trust boundary / security (must-have)

- `notify_cmd` is **operator-trusted** config — only from flag/env/local config, **never** from any remote envelope/field.
- All remote-attacker-controlled strings (display_name, note, message body, object summaries — for **every** type) pass **only via stdin/env**, never concatenated into a shell command. Spawn so untrusted data is never shell-evaluated. Injection test is mandatory.
- Hook only fires on **applied** envelopes (already rate-limited via `enforceInboundRate`); add a per-run spawn cap so an inbound burst can't fork unbounded notify processes.

## Testing (TDD — write failing tests first)

1. Each registered type with `notify_cmd` set → command spawned once; `EB_NOTIFY_KIND` correct; stdin = rendered message; ledger records `dedup_key`.
2. `profile_share` / `revoke` → no spawn (silent policy).
3. Unregistered type → respects `notify_default_unhandled` (silent + audit by default).
4. Per-type opt-out (`notify_<type>:false`) → no spawn.
5. **Injection across types:** malicious `display_name` / message body / object summary `"$(reboot)" / \`rm -rf\``→ inert stdin/env data, no shell eval. (Critical.)
6. notify_cmd non-zero / timeout → ledger NOT recorded; standing-state types stay pending for the cron; event types audited `notify_failed`.
7. Dedup: same applied envelope cannot notify twice (ledger); hook-then-cron for a friend_request → cron skips it.
8. No `notify_cmd` configured → no spawn, no crash; standing-state types fall to cron.
9. Mailbox redelivery of an already-notified message → no second notification (ledger).

## Rollout

1. Land core dispatcher + registry (friend_request, friend_response, gated_message, object_share, escalation) + dial-out wiring in `edge-book-cli`; publish.
2. Configure `notify_cmd` on live Hermes (wrap telegram home-channel delivery) → real-time notifications for all types; replaces the manual cron as primary.
3. Land declarative installer entry (agentvillage) as the standing-state fallback; verify OpenClaw heartbeat.

## Open questions

- Spawn model: `/bin/sh -c "<operator cmd>"` with untrusted data strictly via stdin/env (recommended) vs require argv array in config.
- Ledger storage: extend `seen-messages.json` vs new `notified.json`; retention/GC for the ledger.
- Message previews for gated messages: truncate length + strip control chars before rendering (privacy + safety).
- Should `notify_types` default to "all registered notify rows" or be explicit per type in config from day one?
