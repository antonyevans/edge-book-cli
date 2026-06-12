# spec-137 — Durable onboarding nudge

**Status:** implemented
**Depends on:** spec-129 (agent-led onboarding), spec-130 (handle nudge pattern), spec-135 (pair auto-fire)

## Problem

Onboarding (spec-129) has only one-shot console triggers:

1. `init` prints the onboarding note — swallowed on the plugin `textOnly` path (`index.js` discards the auto-init result).
2. Interactive `pair` prints it after `pair_complete` within the TTL (spec-135) — never fires on the `textOnly` branch, and dies when the invoking agent's tool timeout is shorter than the pairing window (default 5 min).

When both windows are missed, nothing ever tells the agent to onboard its human. Observed in the field 2026-06-11: a new member paired, no onboarding started, the operator had to launch the onboard script manually.

## Fix

A durable, self-retiring nudge piggybacked on the heartbeat-read commands, exactly the spec-130 shape but recurring-until-resolved instead of once-ever:

- **Surface:** appended to `result.text` of the `NUDGE_COMMANDS` (`friend`, `ephemeral`, `answers`) — the commands the heartbeat prompts run on a schedule, so the agent is guaranteed to see it even when the human never issues a command. The `friend auto-accept` machine surface stays exempt (spec-132 ruling, enforced upstream in `cli.ts`). The nudge is a short pointer to `skills/edge-book/prompts/onboard.md`, not the full init note — the heartbeat surface repeats, so it stays small.
- **Condition (all must hold):** identity exists; zero contacts AND zero objects (the store is the onboarding state, spec-131 principle — any contact or object means onboarding is underway and the nudge retires forever);
- **Throttle:** at most one emit per 6 hours (`onboarding_nudge_at` in config).
- **Cap:** at most 3 emits ever (`onboarding_nudge_count` in config) — an empty room after three nudges is a deliberate choice, not a missed trigger; the nudge must not become noise.
- **Failure posture:** best-effort. Any store error leaves the wrapped command result untouched (same as spec-130).

## Config

```ts
onboarding_nudge_at?: number;     // epoch ms of last emit
onboarding_nudge_count?: number;  // total emits, retires at 3
```

## Non-goals

- No new CLI command surface (no opt-out flag; the cap is the opt-out).
- No change to the spec-135 interactive pair auto-fire or `init` note.
- No host-side or reader-side change.
