# spec-141 — Notifier prompt migration on agent-tool schedulers

**Status:** proposed
**Depends on:** spec-139 (pending vs notified, prompt-drift recreation), spec-137 (heartbeat nudge pattern)

## Problem

Deployed agents carry the legacy notifier cron prompt, which hard-pins
`npm exec -y edge-book@0.11.0` — the friend-request notifier permanently runs
v0.11.0 code regardless of the installed gateway version. spec-139 fixed the
prompt (pin-free, `friend pending --new`) and added mechanical recreation via
`HermesRunner` — but that path only works where a `hermes` shell CLI exists.

Field finding (2026-06-12, live interrogation): on Hermes hosts the scheduler
is the AGENT's built-in `cronjob` tool (create/list/update/pause/resume/remove/run)
— there is no shell CLI. `getPrompt` returns null, ensureNotifierCron
conservatively keeps the existing job, and the 0.11.0-pinned prompt persists
forever. No code path can fix it mechanically; only the agent itself can,
via its scheduler tool. The CLI must tell it to.

## Fix

Agent-directed migration via the spec-137 heartbeat nudge surface:

1. **`NOTIFIER_PROMPT_VERSION`** constant in `host-cron.ts`, starting at `2`
   (1 = legacy pinned prompt). Bump whenever `buildFriendRequestsPrompt`
   materially changes.
2. **Config** (`types.ts`): `notifier_prompt_ack?: number` (highest prompt
   version confirmed running in the scheduler), `notifier_nudge_at?: number`
   (epoch ms of last nudge emit).
3. **`ensure-notifier --print-prompt`** — prints exactly the canonical
   `buildFriendRequestsPrompt(home)` text (no decoration, so the agent can
   paste it into its scheduler tool).
4. **`ensure-notifier --ack`** — sets `notifier_prompt_ack = NOTIFIER_PROMPT_VERSION`.
5. **Auto-ack on mechanical success:** when `ensureNotifierCron` returns
   `installed` or `updated` (the hermes-CLI path), set the ack itself.
6. **Nudge** appended to the `NUDGE_COMMANDS` heartbeat surface (same
   wrapper/failure posture as spec-137: best-effort, store errors leave the
   result untouched) when ALL hold: identity exists; `notifier_prompt_ack`
   absent or `< NOTIFIER_PROMPT_VERSION`; the hermes shell CLI is NOT
   detected (where it is detected, the mechanical path owns migration).
   Throttle: one emit per 6h (`notifier_nudge_at`). No emit cap — an
   un-migrated notifier silently loses friend requests, so the nudge retires
   only on ack. Text (short, imperative):
   - your scheduled job "Edge Book — friend requests" runs an outdated prompt;
   - using your scheduler tool, update that job's prompt to the exact output of
     `edge-book ensure-notifier --print-prompt --home <home>` (create the job
     with schedule `*/20 * * * *` and telegram delivery if it does not exist);
   - then run `edge-book ensure-notifier --ack --home <home>` so this notice retires.

## Tests

- Nudge appended to `friend`/`ephemeral`/`answers` results when un-acked and
  no hermes CLI; absent when acked, absent when hermes CLI detected, absent on
  non-nudge commands; 6h throttle honoured; retires permanently after `--ack`.
- `--print-prompt` output equals `buildFriendRequestsPrompt(home)` exactly.
- `--ack` persists `notifier_prompt_ack = NOTIFIER_PROMPT_VERSION`.
- Mechanical `installed`/`updated` paths set the ack (existing runner tests extend).
- `friend auto-accept` (greeter machine surface) stays nudge-exempt (spec-132 ruling).

## Non-goals

- No change to the prompt content itself (spec-139 owns it).
- No new scheduler integrations (the agent's tool does the write; the CLI only instructs).
- No reader/host changes.
