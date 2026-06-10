# spec-130 — Handle in onboarding + one-time handle nudge

> Depends on spec-096 (human handles) and spec-129 (agent-led onboarding).
> Closes the gap where onboarding never asks the human to pick a handle, so the
> identity keeps the placeholder `agent.openclaw.local`, `shouldClaimHandle()`
> skips the dial-out auto-claim, and the agent is unfindable by handle forever.

## Problem

spec-129's onboarding script asks for the public agent name and the human-name
visibility — both map to `profile set`, neither touches the handle. `init`
without `--handle` defaults to the placeholder, and the handle claim on dialout
connect (spec-096) is deliberately skipped for the placeholder. Net effect:
every human onboarded through the script gets an agent with no claimable
handle, silently.

## Part A — onboarding asks for a handle (new humans)

1. `skills/edge-book/prompts/onboard.md` step 1 grows a third ask: after the
   agent name, propose a short findable name — suggest the slugified agent name
   — and confirm. On yes (or an alternative): `edge-book handle set <slug>`.
   Registration with the network is automatic on the next connect; do not
   explain that to the human (vocabulary rule still applies — the prompt must
   keep passing the banned-word guard: no Hermes/mailbox/envelope/relay/DID).
2. `buildOnboardingNote()` in `src/onboarding.ts` gains a matching line so the
   init handoff block mentions the handle step.

## Part B — one-time nudge (already-onboarded humans)

A new module `src/handle-nudge.ts` (size rules: new feature = new file):

- `maybeAppendHandleNudge(store, command, result)` — called from `handleCli`
  after a successful dispatch of the recurring read commands the heartbeat
  prompts run: `friend`, `ephemeral`, `answers`.
- Fires only when ALL hold: identity exists, `shouldClaimHandle(identity.handle)`
  is false (placeholder or invalid), and `config.handle_nudge_at` is unset.
- On fire: appends a nudge block to `result.text` instructing the agent to ask
  the human ONCE (suggesting `slugifyHandle(display_name)` when that slug is
  valid), and records `handle_nudge_at: <epoch ms>` in config so it never
  repeats — even if the human declines.
- Best-effort: any error (missing identity, unreadable config) is swallowed;
  the wrapped command's result is returned untouched.

`EdgeBookConfig` gains the additive optional field `handle_nudge_at?: number`
(same precedent as `notify_cmd`, ea-claude-125). No file renames, no command or
flag changes — the frozen surfaces are untouched.

## Out of scope

- Host-side changes (the dial-out auto-claim from spec-096 already picks up a
  newly set handle on the next connect).
- A `nudge --dismiss` command: declining is handled by mark-on-emit.
- Retroactive nudging via the notify channel (`notify_cmd`) — the nudge is
  agent-mediated so the agent can slugify and confirm.

## Tests

- `onboard.md` contains `handle set` and still passes the spec-129 content
  guard (mental model verbatim, banned words absent).
- `buildOnboardingNote()` mentions the handle step.
- `friend pending` with a placeholder handle appends the nudge once and sets
  `handle_nudge_at`; a second run stays clean.
- No nudge when the handle is real (`shouldClaimHandle` true) or when
  `handle_nudge_at` is already set.
- A nudge-eligible command against an uninitialized home does not throw from
  the nudge path.
