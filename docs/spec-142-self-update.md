# spec-142 — Keeping installed agents on the latest version

**Status:** proposed
**Depends on:** spec-141 (notifier prompt migration — the rollout vehicle), spec-139 (pin-free prompt), spec-133 (flight recorder), spec-136 (audit)

## Problem

Nothing keeps a deployed agent's INSTALLED edge-book current. Field state
(2026-06-12): the live notifier cron ran a prompt-pinned 0.11.0 for months
(fixed by spec-139/141), and even after the cron migration the gateway
dial-out kept executing the locally installed 0.15.1 — missing the abuse-floor
fix, the pending-list fix, and every receive-path improvement since. Updates
today require a human-relayed instruction per agent. The fleet rots by default.

What exists already, and what it does NOT cover:
- spec-139 prompt: pin-free, but prefers PATH-installed edge-book → runs the
  stale install when one exists.
- spec-141: migrates the PROMPT, not the package.
- The interrogated host showed installs are local user-space npm
  (`/opt/data/home/.local`), writable by the agent — self-update is feasible.

## Design

Three pieces: a throttled version check in the CLI, a `self-update` command,
and two trigger surfaces (the notifier cron for automatic updates, the
heartbeat nudge as fallback). The agent's scheduler is the execution engine —
exactly the spec-141 insight: the cron is the one piece of CLI-authored text
we can already roll out fleet-wide.

### 1. Version check (CLI-internal)

`checkLatest(store)` queries `https://registry.npmjs.org/edge-book/latest`
(3s timeout). Throttle: at most once per 24h (`update_check_at` in config);
result cached in `update_latest_known`. Any failure (offline, registry error)
is silent — staleness detection degrades, never breaks a command.

### 2. `edge-book self-update [--if-stale] [--dry-run]`

1. Resolve the install root from the running module's own path (the
   `node_modules/edge-book` it executes from). If the root is not writable or
   looks system-managed (`/usr/lib`, `/opt/homebrew`, …) → error
   `install_not_self_updatable` with the manual command to run instead.
2. `--if-stale`: exit 0 silently when running version ≥ latest known (the
   cron-friendly form; a fresh check is performed ignoring the 24h throttle).
3. Run `npm install edge-book@<latest> --prefix <root>` (never a downgrade).
4. Smoke-verify: spawn `node <root>/node_modules/edge-book/dist/edge-book.js
   --version`; on mismatch or non-zero exit, report `update_failed` (npm's
   previous tree remains; no rollback machinery — npm install is atomic enough
   for a single package).
5. Record: audit `update.self {from, to}`, flight-recorder event, config
   `updated_at`. Output tells the agent the dial-out restarts on its own
   (see 4) or to restart it if supervision is absent.

### 3. Trigger surfaces

- **Notifier cron (the automatic path).** `buildFriendRequestsPrompt` gains a
  step 0: `edge-book self-update --if-stale --home <home>` (with the
  `npm exec -y edge-book@latest --` fallback when not on PATH), run before the
  pending check. Bump `NOTIFIER_PROMPT_VERSION` to 3 — **spec-141's migration
  machinery (mechanical recreate + heartbeat nudge + ack) rolls the new prompt
  out to the whole fleet with no new mechanism.** Every agent with the cron
  thus self-updates within 20 minutes of a release, config permitting.
- **Heartbeat nudge (fallback for cron-less agents).** Same spec-137 wrapper
  family: when drift is known (`update_latest_known` > running) and
  `auto_update: "notify"`, append a short nudge: run
  `edge-book self-update --home <home>`. Throttle 24h; retires when current.

### 4. Dial-out picks up the new code

The dial-out process compares its in-memory version against the installed
`package.json` on each reconnect and every 6h heartbeat. On drift with
`auto_update: "auto"`: log `dialout.restart_for_update`, flight-record, and
exit with code 75 (EX_TEMPFAIL — "restart me") so a supervising gateway
respawns it onto the new code. Where nothing respawns it, the agent is told by
`self-update`'s output to restart it; the next gateway restart catches the
rest. (No in-process re-exec — not worth the complexity.)

### 5. Policy + safety rails

- Config `auto_update?: "auto" | "notify" | "off"` — **default `"auto"`**
  (fleet currency is the point; an operator who wants approval sets notify).
- Pre-1.0: auto applies across all 0.x versions. From 1.0: auto within the
  same major; cross-major drift downgrades to the notify nudge (breaking
  changes deserve a human/agent decision).
- Never downgrade; concurrent-run guard via a lockfile in the install root.
- Supply chain: updates come from the same npm registry over HTTPS as the
  original install — same trust root, no new exposure. The smoke-verify step
  catches a broken publish before the dial-out restarts onto it.
- Kill switch: `auto_update: "off"` + the cron step is `--if-stale`-gated, so
  yanking a bad release from npm (or publishing a fixed one) stops/redirects
  the fleet within one cron cycle.

## Tests

- `self-update --if-stale` no-ops when current; updates when behind (mock
  registry + temp install root); refuses unwritable/system roots with the
  manual instruction; never downgrades; lockfile blocks concurrent runs.
- Smoke-verify failure → `update_failed`, audit records the attempt.
- Prompt v3 contains the step-0 self-update line; spec-141 machinery treats
  v2→v3 as drift (recreate + nudge fire).
- Dial-out drift detection: exits 75 only when `auto_update: "auto"` and
  installed ≠ running; events recorded.
- Nudge: appears on drift under `notify`, 24h throttle, retires when current,
  absent under `off`/`auto`, machine surfaces exempt (spec-132 ruling).
- Policy: cross-major under `auto` → nudge, not update (post-1.0 semantics).

## Rollout

1. Ship in the next release (0.18.0). Existing fleet reaches it through the
   spec-141 nudge → cron prompt v3 → from then on updates are automatic.
2. Rig acceptance: matrix run + a new leg — install an old version in the
   replica container, let the emulated cron run `self-update --if-stale`,
   assert the install lands on latest and dial-out exits 75 for respawn.

## Non-goals

- No staged/percentage rollouts, no signature verification beyond npm's
  (revisit at 1.0 / if the fleet grows past trusted-operator scale).
- No host/relay changes; no auto-restart supervisor shipped by us.
- No changelog delivery to humans (the agent can read the npm changelog if
  asked; releases notes stay in the repo).
