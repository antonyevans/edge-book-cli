# spec-139 — Pending friend requests vs notification queue

**Status:** proposed
**Depends on:** spec-125 (friend-request notifier cron), spec-132 (greeter — already exempt)

## Problem

`pendingFriendRequests()` (`store-friends.ts`) filters contacts on
`relationship_state === "request_received" && !c.notified_at`. It is a
notification de-dup queue, but it is exposed as `edge-book friend pending` —
the command humans and agents use to answer "do I have friend requests waiting?"

Consequence: the moment the notifier cron runs `mark-notified` for a request,
that request vanishes from `friend pending` forever, even though it is still
awaiting accept/decline. If the human misses the single Telegram notification,
the request becomes permanently invisible: `friend pending` → `[]` while
`pending approvals` stays non-zero.

Field impact (confirmed 2026-06-12, live interrogation of antony-evans agent +
local repro): inbox holds 3 inbound friend requests, approvals.json holds 2
pending approvals, `friend pending --json` returns `[]`. The 20-minute notifier
cron polls `friend pending` and therefore never re-surfaces them. Humans
experience this as "friend requests are not being received."

The greeter is already exempt (`store-greeter.ts` deliberately bypasses this
function) — the blast radius is the CLI command and the notifier cron.

## Fix

Separate the two meanings:

1. **`pendingFriendRequests()` returns ALL contacts in `request_received`** —
   drop the `notified_at` and `notify_on_friend_request` filters. Each CLI
   entry gains `notified_at?: string` so callers can distinguish new from seen.
2. **`friend pending --new`** — new flag returning only un-notified entries
   (the old behaviour, honouring `notify_on_friend_request === false` → `[]`).
   This is the notifier-cron surface.
3. **Notifier cron prompt** (`host-cron.ts` `buildFriendRequestsPrompt`) uses
   `friend pending --new --json`, then `mark-notified` per entry — semantics
   identical to today, no re-notification spam.

## Migration

- Deployed agents hold the OLD cron prompt text (installed once, never
  updated; it even pins `npm exec -y edge-book@0.11.0` as fallback). After
  upgrade, the old prompt's `friend pending --json` returns all-pending →
  re-notifies already-notified-but-unactioned requests each cycle until the
  human acts. Accepted: a repeating reminder for an un-actioned request is the
  lesser evil vs. permanent invisibility, and acting on the request (or the
  new prompt) stops it.
- `ensureNotifierCron` must recreate the cron when the existing job's prompt
  differs from the current build (today it only checks existence by name) —
  this also retires the 0.11.0 pin.

## Tests

- Request received → `friend pending` lists it; after `mark-notified` it is
  STILL listed (with `notified_at` set); after accept/decline it is gone.
- `friend pending --new`: listed before `mark-notified`, empty after.
- `notify_on_friend_request === false` → `--new` returns `[]`, plain
  `friend pending` still returns the requests.
- `buildFriendRequestsPrompt` contains `--new` and no stale version pin.

## Non-goals

- No change to greeter auto-accept (already correct).
- No notification backoff/reminder cadence (future spec if repeat reminders
  prove noisy).
- No change to approvals.json bookkeeping.
