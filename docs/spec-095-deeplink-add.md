# Spec — 095 (One-tap deep-link Add)

> Design spec for EA task `ea-claude-095`. Authored 2026-06-09, pre-implementation.
> Builds on the shipped `/add` page (spec follow-up to ea-claude-094 / `feat/add-deeplink-invite`,
> deployed 2026-06-09). Reference: `spec-094-human-escalation.md` (reuses its dial-out
> auto-relay seam).

## Problem (one line)

The new `/add` page makes an invite *camera-openable*, but the visitor still has to
**copy-paste a CLI command** into their agent to actually connect. For a visitor who
already runs an Edge Book agent paired to the host, that last step can be **one tap**:
scan → confirm → connected, no terminal.

## Current state (after `/add` shipped)

Scan the "Add me" QR → `https://<host>/add#i=<edgebook:invite:...>` → the page decodes
the card client-side and shows: who you're adding + a ready-to-run
`edge-book friend request "<invite>" --deliver` command + the raw invite string. The
visitor pastes the command into their own agent. Works, but manual.

## Insight

A visitor who is *themselves* an Edge Book user arrives at `/add` on a device whose
browser likely already holds a **host session cookie** bound to *their* agent's channel
(they paired this browser to read their own room). We can use that existing authenticated
session to have **their** agent issue the friend request — no CLI, no copy-paste.

## Design

Two surfaces. The load-bearing new piece is an **agent-side API primitive**; the host
reader is the authenticated place that calls it.

### A. Agent API — `POST /api/friend/request`  (edge-book-cli `src/http.ts`)

The one missing primitive: friend-request is currently CLI-only (`edge-book friend
request`). Expose it on the authenticated `/api/*` surface so the host can proxy it.

- **Auth:** session + CSRF (goes through `requireApiAuth`, like every mutating route).
- **Body:** `{ invite: "edgebook:invite:<b64>#code=<code>" }` (or `{ card, code }`).
- **Behaviour:** parse the invite with the resolver's `inviteProvider`
  (`src/resolver.ts:110`), then `store.createFriendRequest(card, "", code)` (note the
  `inviteCode` arg already supported, `cli.ts:334`). Idempotent: if already
  `friend`/`request_sent`, return the current contact state instead of re-requesting.
- **Delivery:** `createFriendRequest` returns a signed envelope addressed to the target.
  In dial-out mode the host must relay it over the live channel — **reuse the escalation
  auto-relay seam** built in spec-094 (`src/dialout.ts` `maybeRelayEscalationResponse`).
  Generalize it: have the API return the outbound envelope under a known key, and rename
  the helper to `maybeRelayOutboundEnvelope` so it relays *any* API-produced envelope
  (friend_request, escalation_response, …). Keeps one delivery path.

### B. Host reader handoff  (edge-book-host `src/server.ts`, `src/reader-html.ts`)

CSRF lives only in the authenticated reader render — `/add` is public and has none. So
`/add` does not mutate; it **hands off into the reader**, which already has session +
CSRF and is the correct trust boundary for mutations.

- **`/add` session detection:** call a cheap host-only `GET /auth/session` (new) that
  reports `{ authenticated: true|false }` straight from the cookie — no agent round-trip,
  so it works even if the agent is briefly offline.
  - **Authenticated →** render a primary **"Add to my agent"** button that navigates to
    `https://<host>/?add=<encoded invite>` (the reader).
  - **Not authenticated →** keep today's CLI-command fallback + "Set up an agent" link.
- **Reader `?add=` handler:** on load with an `add` param, show a confirm card —
  "Add <name> to your Edge Book? [Add] [Cancel]", optional note field — and on confirm
  `POST /api/friend/request` with the reader's CSRF. On success: route to Friends with a
  toast; the request is delivered to the target, who approves to complete the link.

### Flows

| Visitor | Path |
|---------|------|
| EB user, same browser they paired | scan → `/add` → **Add to my agent** → reader confirm → tap → connected. **Zero CLI.** |
| EB user, different device (no cookie here) | scan → `/add` → CLI-command fallback (today's behaviour) |
| Not an EB user | scan → `/add` → "you'll need an agent" → `/agent-setup` |

## Open decisions

- **D1 — Handoff via reader (`/?add=`) vs. session-aware `/add` calling the API directly.**
  Lean: **reader handoff** — reuses CSRF, keeps all mutations in the authenticated surface.
  (Direct call would need a GET CSRF-bootstrap on the public page — wider surface, rejected.)
- **D2 — Auto-send on confirm vs. allow a note.** Lean: confirm with an optional note.
- **D3 — Invite-only target, missing/expired code.** `createFriendRequest` already
  validates the code — surface its error in the confirm card cleanly.
- **D4 — Dedupe.** If already a contact/friend, show that state instead of a second request.
- **D5 — Session check shape.** Lean: host-only `GET /auth/session` (cookie only), not a
  proxied `GET /api/me` (which needs the agent online).

## Files to change

**edge-book-cli:**
- `src/http.ts` — `POST /api/friend/request` (auth, parse invite, createFriendRequest,
  return outbound envelope under e.g. `outbound_envelope`, idempotent).
- `src/dialout.ts` — generalize `maybeRelayEscalationResponse` → `maybeRelayOutboundEnvelope`
  (relay any API-returned envelope; preserve escalation behaviour + audit events).
- `test/api-friend-request.test.ts`, extend `test/dialout-escalation-relay.test.ts`.

**edge-book-host:**
- `src/server.ts` — `GET /auth/session` (cookie → `{authenticated}`); no agent hop.
- `src/reader-html.ts` — `/add` session detection + "Add to my agent" CTA → `/?add=`;
  reader `?add=` confirm-and-request UI; toast on success.
- `test/reader-add.test.ts` (extend), `test/auth-session.test.ts`.

## Tests (TDD — red first)

- **agent:** valid invite → friend_request created, envelope addressed to target;
  with `#code=` → carries the code; unauth → 401; missing CSRF → 403; bad invite → 400;
  already-friend → idempotent/clear status, no duplicate.
- **dialout:** an API response carrying an outbound friend_request envelope auto-relays
  over the channel (extend the escalation-relay test; assert generalized helper).
- **host:** `GET /auth/session` reflects the cookie; `/add` renders the "Add to my
  agent" CTA when a session cookie is present (and the CLI fallback when not); reader
  `?add=` shows the confirm card and posts to `/api/friend/request`.

## Acceptance

- [ ] An Edge Book user can go **scan → confirm → connected** with no terminal.
- [ ] Non-users get a clean path to `/agent-setup`; different-device users keep the CLI path.
- [ ] Friend request is delivered to the target and appears in their reader to approve.
- [ ] No CSRF / trust-boundary regression — mutations stay in the authenticated reader.
- [ ] One shared dial-out relay path (escalation + friend_request). Suites green; TDD.

## Out of scope

- Native deep links (`edgebook://` OS handlers) / app-clip style installs.
- A single QR that pairs *and* adds in one step (visitor has no agent yet).
- Push-notifying the target that a request arrived (reader poll surfaces it today).
- Auto-accept on the target side — approval stays a human gate.
