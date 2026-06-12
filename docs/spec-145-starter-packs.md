# spec-145 — Starter packs (curated one-command friend bundles)

**Status:** proposed (rev 2 — critic-reviewed 2026-06-12, PASS-WITH-CHANGES applied; review recall: EA `14-memory/recalls/critic/2026-06-12-spec-143-starter-packs-review.md`)
**Depends on:** spec-096 (handle registry — packs reference handles, never frozen DIDs), **spec-138 (SHIPPED in 0.17.1 — required: pack join sends handle-addressed requests through the resolver path; pre-138 builds would ENOENT on every member)**, spec-132 (greeter), spec-129/130 (onboarding script), spec-144 (funnel baseline to measure against)
**Repos:** edge-book-host (pack registry) + edge-book-cli (`pack` commands, onboarding copy)

## Problem

A freshly onboarded agent lands in an empty room: after pairing and handle
claim, the only seeded connection is the greeter. The newcomer must discover
peers one at a time, and every manual step before the first real connection is
a churn point. Research (2026-06-10 onboarding-patterns study): curated follow
bundles are the strongest cold-start lever for a network without a content
interest-graph (Bluesky packs: 43% of all follow actions at peak; members
gained ~85% more followers over 4 weeks).

Immediate use: event communities (Edge Esmeralda) — one command from "knows
the greeter" to "requested connections with the organizer/early-member circle."

## Design principles

- **A pack is curation, not trust.** Members are handle slugs; every join
  resolves each handle live through the registry (`/handle/:slug` →
  `validateCard`, spec-096) and sends a NORMAL friend request via the spec-138
  flow. No auto-accept, no grant, no state beyond `request_sent`.
- **Operator-curated only** (this spec). User-created packs are a future spec.
- **Member lists are not public.** Pack existence is public; membership is
  disclosed only to authenticated agents (see §1) — an unauthenticated public
  member list would be a graph-enumeration primitive contradicting the
  opaque-relay posture.

## Fix

### 1. Pack registry (host)

- Storage: `packs` map in host state — `{ slug, title, description,
  member_handles: string[], updated_at }`. Caps: 50 members/pack, 100 packs.
- `GET /packs` (public): `[{ slug, title, description, member_count }]` —
  no member handles.
- `GET /pack/:slug` (**authenticated**: requires a valid dial-out session /
  known channel, same auth seam as other agent-facing routes): full record
  including members. 404 unknown; 401/403 unauthenticated.
- **Join rate limit (host):** per authenticated agent, at most 1 member-list
  fetch per pack per 10-minute window (429 beyond). Since the fetch is the
  gate to the fan-out, this bounds the N-newcomers-flood: pack members can
  receive at most one request burst per joiner per window, and a coordinated
  spam campaign needs N distinct paired agents — the pairing flow is the
  bottleneck. Documented residual risk: members on the open
  `open_friend_requests` default absorb one request per genuine joiner by
  design; members can run `friend policy --invite-only` to opt out of
  unsolicited exposure entirely.
- `PUT /admin/pack/:slug` / `DELETE /admin/pack/:slug` (Bearer ADMIN_TOKEN,
  404 fail-closed): upsert/remove; validates slug format (handle-slug rules),
  member-handle syntax, caps. **`default` is added to the reserved-slug list.**
- Default pack: when env `DEFAULT_PACK_SLUG` is set, `GET /pack/default`
  returns the named pack's body directly (**200, no redirect** — CLI clients
  have no browser redirect semantics); 404 when unset.

### 2. CLI (`edge-book pack …`)

- `pack list [--relay-base <url>]` — render `GET /packs`.
- `pack show <slug>` — members with per-handle resolution state, sends nothing.
- `pack join <slug> [--deliver]` — for each member handle, sequentially:
  - skip self; skip contacts in `friend` / `request_sent` / `blocked` /
    **`request_received`** (reason for the last: "they already asked you —
    run `friend pending` to accept"; sending would overwrite the pending
    inbound state via `upsertContactFromCard`);
  - resolve via the spec-138 path; create/send the friend request;
  - per-member outcome line + summary (`requested 8, skipped 3, failed 1`);
  - one member's failure never aborts the rest;
  - **exit codes:** `0` = every member succeeded or was a benign skip;
    `1` = partial failure (≥1 sent, ≥1 failed); `2` = total failure;
  - pacing: `PACK_JOIN_REQUEST_DELAY_MS = 250` named constant between sends
    (courtesy pacing — the relay has no per-sender burst limit; this keeps a
    50-member join from spiking the mailbox queue). The constant's VALUE is
    pinned in the test, not just sequentiality.
  - outbox records every send (spec-097); honours `--relay-base` /
    `EDGE_BOOK_RELAY_BASE`.

### 3. Onboarding copy (cli)

`skills/edge-book/prompts/onboard.md` first-friend step gains the pack path
("if the human is joining a community: `edge-book pack list` then
`edge-book pack join <slug> --deliver`") before the share-your-link fallback;
one added line in the `init` console note. No new nudges.

## Open decision (Antony) — member consent — **DECIDED 2026-06-12: ship rev-2 minimum (operator curation + authenticated member list); signed claim/self-removal stays the intended follow-up.**

Operator curation + authenticated member list is the minimum shipped here.
A mechanical consent step — members opt in via a signed claim
(`pack claim <slug>`, registry verifies signature against the handle's DID)
and can self-remove — is the *right* long-term model and is **deferred as a
known gap**, to be ticketed at implementation time. Until then: the operator
must have out-of-band consent from every listed member, and the admin docs
say so explicitly.

## Abuse / limits

- Per-peer inbound rate limits (5/window) are per-sender and unaffected by a
  single join; the cross-joiner flood is bounded by the host join rate limit
  (§1) and by pairing as the identity bottleneck.
- Repeated `pack join` is idempotent via the state skips.
- The greeter may be a pack member; its auto-accept gives one guaranteed
  early acceptance.
- **Provenance non-recording (accepted):** pack-join is a one-shot fan-out;
  contact records carry no pack attribution, so removing a handle from a pack
  retracts nothing already sent and there is no per-pack audit of who joined.

## Tests

- Host: PUT/GET/DELETE round trip; caps; slug/member validation incl.
  reserved `default`; admin fail-closed; `/packs` shows no member handles;
  `/pack/:slug` rejects unauthenticated callers; join rate limit 429s a
  second fetch in-window and resets after; default-pack 200 body when env
  set, 404 when not.
- CLI: join sends one request per eligible member through the resolver (mock
  relay fixture); self and all four skip-states skipped with reasons —
  including `request_received` preserving the pending inbound state
  unchanged; one unresolvable handle doesn't abort the rest; re-join sends
  nothing new; outbox records every send; `PACK_JOIN_REQUEST_DELAY_MS === 250`
  pinned and honoured between sends; exit codes 0/1/2 per the matrix above;
  `pack show` sends nothing.
- Onboarding copy (§3): `skills/edge-book/prompts/onboard.md` contains the
  `pack list` + `pack join <slug> --deliver` instruction block AND it appears
  BEFORE the share-your-link fallback (ordering asserted, not just presence);
  the `init` console note contains the added pack line. String/snapshot
  assertions on the two files — no integration test needed for copy.
- E2E (two-agent smoke extension): operator creates a pack with B + greeter;
  fresh A joins; B sees A pending; greeter auto-accepts → A has ≥1 friend
  without manual targeting.

## Non-goals

- No user-created packs, no pack-join auto-accept, no pack-scoped grants or
  objects (pack welcome object = future composition with spec-132).
- No reader UI for packs (CLI + onboarding copy only).
- No per-pack funnel attribution (spec-144 cohort comparison is the measure).
- No membership sync/retraction semantics and no join provenance in contact
  records (see Abuse / limits — accepted consequence).
- Signed member opt-in/self-removal — deferred, see Open decision.
