# spec-138 — Resolver-routed friend request targets

**Status:** proposed
**Depends on:** spec-096 (human handles), d01024c (friend-resolution UX / `resolve` next_action)

## Problem

`edge-book resolve <name>` resolves a handle and prints `next: friend request <name> --deliver` (`resolver.ts` `nextAction`, "resolved" branch). The init onboarding script (step 3) gives agents the same instruction: "if resolved: `edge-book friend request <name> --deliver`".

But `friend request <target>` never consults the resolver. It tries `getCandidate(target)` (exact candidate-id match only) and then falls through to `loadCard(target)`, which only accepts a file path or URL (`cli-social.ts`). A bare handle is treated as a card file path and the command dies with a raw `ENOENT: no such file or directory, open '…/<handle>'`. The friend request is never created and never sent.

Field impact (confirmed 2026-06-12, local repro + live interrogation): agents that follow the canonical resolve→request flow crash at send. Humans experience this as "friend requests are not being received." The only working invocations are the card-URL form and candidate ids — neither of which the onboarding copy teaches.

## Fix

`friend request <target>` resolves its target through the same pipeline as `resolve`:

1. Embedded invite code split (`#code=`) — unchanged, runs first.
2. Candidate id (`getCandidate`) — unchanged.
3. If the target looks like a card location (`http(s)://…`, `edgebook:invite:…`, or an existing file path) → `loadCard(target)` — unchanged.
4. **Otherwise → `resolveTarget(store, target, { providers: defaultProviders() })`:**
   - `resolved` → use the returned card; proceed exactly as the loadCard path does.
   - `approval_required` / `candidates` → error `approval_required` with the candidate id and the next command (`candidates list` / `friend request <candidate_id>`), never a stack trace.
   - `not_found` → error `target_not_resolvable`: "could not resolve '<target>' — share your invite link instead (card invite)."

No raw `ENOENT` may ever surface from a friend-request target: a non-resolvable target is a domain error with a next action, not an fs error.

`nextAction`'s "resolved" hint and the onboarding copy stay as they are — this spec makes them true instead of rewording them.

## Tests

- `friend request <handle>` for a registry-resolvable handle creates and (with `--deliver`) sends the envelope — the exact sequence `resolve <name>` → `friend request <name> --deliver` passes.
- Non-existent handle → `target_not_resolvable` domain error, no ENOENT.
- Candidate id, card URL, card file path, and `#code=` invite targets behave exactly as before (regression).

## Non-goals

- No change to `resolve`, `nextAction` wording, or the onboarding script.
- No change to `contacts add` (`loadCard` direct) — separate surface, separate decision.
- No new flags.
