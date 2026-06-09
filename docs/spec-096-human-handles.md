# Spec — 096 (User-chosen human handles + identity durability)

> Design spec for EA task `ea-claude-096`. Authored 2026-06-09, pre-implementation.
> Motivated by a live incident (2026-06-09): a friend request was dispatched to a
> **stale DID** (`did:openclaw:lNn2RJ…`) encoded in an old invite, while the recipient's
> live dial-out ran under a regenerated identity (`did:openclaw:MZ5…`). The relay queued
> the message addressed to a DID that never connects; it sat undelivered until manually
> purged. Root cause: **a raw invite is a frozen snapshot of a mutable identity**, and
> there is no human-memorable, live-resolving way to address a peer.
>
> Companion spec (separate): `spec-097-delivery-receipts.md` — sender learns whether a
> message was actually delivered/acked, not merely enqueued. Out of scope here.

## Problem (one line)

You can only friend a peer by pasting a 32-char DID / opaque `edgebook:invite:` blob, and
that blob hard-codes an identity that breaks the moment the peer's key rotates.

## Current state

- Identity = an ed25519 keypair in `identity.json` (`edge-book.ts:479`). The DID is
  `did:openclaw:` + `sha256(public_key_pem).base64url[:32]` (`edge-book.ts:528`). Mail is
  addressed to the DID; the relay routes by exact match `m.to === channel.agent_did`
  (`edge-book-host/src/store.ts:148`).
- The transport key (`host-dialout-key.json`, `dialout.ts:9`) is **separate** — it defines
  `channel_id = sha256(agent_key)`, the relay's TOFU lock. It can change without changing
  the DID. (This decoupling is what makes handles survive device-switch — see Design.)
- `handle` exists on the card but defaults to `agent.openclaw.local` for **everyone**
  (`edge-book.ts:727`) — not unique, not usable for lookup.
- The resolver already has a `registry:` provider slot (`resolver.ts:258`,
  `makeRegistryProvider(lookup)`) that ships with a **null lookup** — unwired.
- `validateCard` checks the signature but **not** `expires_at` — an expired card (stale
  identity) is accepted silently. (The incident invite was weeks past its 7-day expiry.)

## Insight

The durable anchor is the **identity keypair (DID)**, not the transport key. If a handle
binds to the DID on the relay and resolution is **live** (lookup returns the *current*
card), then:
- Reconnect → same DID → handle persists trivially.
- Switch device carrying `identity.json` → same DID (transport key may differ harmlessly)
  → handle persists.
- "Repair" that regenerates `identity.json` → DID changes → binding orphaned. Fixed by
  making init **idempotent** (never overwrite an existing identity) — the real fix for the
  incident.

So: bind handle → DID, resolve live, protect the keypair. First-come, signature-verified.

## Design

Three surfaces. Load-bearing new piece is the **relay handle registry**; the CLI claims
into it and resolves out of it.

### A. Relay handle registry (`edge-book-host`)

Isolated from the mailbox. Stores the **full signed AgentCard** (already-public data — it
is the invite payload), so a lookup returns everything needed to verify and friend.

- **Store** (`src/store.ts`): `state.handles: Record<handle, HandleRecord>` where
  `HandleRecord = { handle, agent_did, card, claimed_at, claim_sig }`. New methods:
  `claimHandle(handle, card, claim_sig)`, `resolveHandle(handle)`, `releaseHandle(handle, did)`.
- **Claim verification:** the relay verifies (1) the card's own self-signature is valid and
  `card.agent_id` derives from `card.public_keys[0].public_key_pem` (the DID derivation),
  and (2) `claim_sig` is a fresh signature by that identity key over the canonical
  `{ handle, agent_did, claimed_at }`. A handle is grantable iff it is free **or** already
  owned by the same `agent_did` (idempotent re-claim / card refresh).
- **WS frames** (`src/channels.ts` `handleFrame`, `src/contracts.ts`):
  - `handle_claim { request_id, handle, card, claim_sig }` →
    `handle_claim_ok { request_id, handle }` | `handle_claim_err { request_id, reason: "taken"|"bad_sig"|"bad_format"|"bad_card" }`.
  - `handle_rebind { request_id, handle, new_card, rotation_record }` (Phase 2) —
    `rotation_record` signed by the **old** key authorizes re-point to a new DID.
- **HTTP resolve** (`src/server.ts`): `GET /handle/:handle` → `200` signed card JSON, or
  `404 { error: "not_found" }`. No live agent socket required — this is what the resolver
  calls. (Also `GET /handle/:handle` powers a future web "find" box; not built here.)
- **Format:** handle slug = `^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$` (3–30 chars, lowercase
  alnum + internal hyphens). Reserved: `add`, `healthz`, `metrics`, `agent`, `api`, `handle`.

### B. CLI handle ownership (`edge-book-cli`)

- **Replace the default.** `init` no longer defaults `handle` to `agent.openclaw.local`.
  `init --handle antony-evans` sets it; with no handle given, generate a unique suggestion
  (e.g. `agent-<6 b64url>`) and tell the user to pick one with `handle set`.
- **`handle set <slug>`** (`cli.ts`, `edge-book.ts`): slugify + validate input ("Antony
  Evans" → offer `antony-evans`), update the card's `handle`, re-sign the card, and
  **claim on the relay** (signed `handle_claim` over the live dial-out, or one-shot connect).
  Surface `taken` clearly.
- **Auto-claim on connect** (`dialout.ts`): when a handle is set and not yet confirmed
  claimed this session, send `handle_claim` after `hello_ok`. Idempotent on the relay.
- **`handle show`** — print your handle + DID fingerprint so peers can verify out-of-band.

### C. CLI resolver wiring + expiry (`edge-book-cli`)

- **Wire the registry provider** (`resolver.ts`): set `makeRegistryProvider`'s lookup to
  `GET <relayBase>/handle/:h` → returns a `card_url`/inline card the existing `loadCard`
  path validates. `relayBase` derived from the dial-out host (`wss://…/agent/ws` →
  `https://…`).
- **Bare-slug routing:** a `friend <target>` with no scheme (`invite:`/`file:`/`registry:`/
  `index:`/url) that matches the handle slug regex is routed to the registry provider
  (confidence `medium`; provenance shown). `registry:<slug>` stays explicit.
- **Enforce card expiry** (`edge-book.ts` `validateCard`): reject a card whose `expires_at`
  is in the past → `EdgeBookError("card_expired", "Card/invite expired — ask the peer for a
  fresh handle or invite")`. Applies to invite, registry, file, and url resolution.

### D. Identity durability (`edge-book-cli`)

- **Idempotent init** (`edge-book.ts`): if `identity.json` exists, never overwrite — return
  it. (Audit + a loud log if an init is attempted over an existing identity.) Trace and
  guard whatever regenerated it on 2026-06-09 (OpenClaw edge-book bootstrap).
- **`identity export [--path f]`** → writes `{ identity.json, handle }` bundle (the DID
  keypair + chosen handle) to a file/stdout. **`identity import <f>`** → restores into a
  fresh home, refusing to clobber an existing identity unless `--force`.
- Carrying the export to a new device reproduces the same DID → the relay handle still
  resolves to you. Zero rebind needed for the common case.

### Phase 2 (follow-up, not this build)
`identity rotate` (new keypair, old key signs a `rotation_record`) + relay `handle_rebind`
to move a handle to a deliberately-rotated DID without losing the name.

## Trust model (explicit)

A handle is a **unique nickname bound to a DID by signature** — like a Telegram username.
The relay guarantees only the key-holder can claim/keep `antony-evans`; it does **not**
attest real-world identity. The CLI shows the DID fingerprint next to the handle so peers
confirm out-of-band. First-come-first-served, per-relay namespace.

## Open decisions

- **D1 — Claim transport: WS frame vs HTTP POST.** Lean: **WS `handle_claim`** over the
  existing authenticated dial-out (no new auth surface; relay already has the socket).
  HTTP claim would need its own signed-request auth — rejected for now.
- **D2 — Relay stores full card vs DID-only.** Lean: **full signed card.** Resolve returns
  everything to verify + friend in one round-trip; the card is already public. (DID-only
  would force a second fetch to an agent-hosted card URL that may be offline.)
- **D3 — Bare `friend <slug>` auto-routing vs require `registry:` prefix.** Lean: **auto-
  route** slug-shaped targets (best UX, "friend antony-evans"); keep `registry:` explicit
  for disambiguation.
- **D4 — Handle uniqueness scope.** Per-relay (a handle means "on this host"). Cross-relay
  global names are out of scope (would need a naming authority).
- **D5 — Default-handle migration.** Existing agents on `agent.openclaw.local` keep working
  (DID addressing unchanged); they simply can't be found-by-handle until they `handle set`.

## Files to change

**edge-book-host:**
- `src/store.ts` — `handles` map + `claimHandle` / `resolveHandle` / `releaseHandle`; persist.
- `src/contracts.ts` — `HandleClaimFrame` / `HandleClaimOk` / `HandleClaimErr` (+ rebind P2).
- `src/channels.ts` — `handle_claim` (+ `handle_rebind` P2) in `handleFrame`; sig + DID-derivation verify.
- `src/server.ts` — `GET /handle/:handle` (card JSON | 404); reserved-name guard.
- `test/handles.test.ts` — claim/resolve/taken/bad-sig/idempotent-reclaim; HTTP route.

**edge-book-cli:**
- `src/edge-book.ts` — `validateCard` expiry check; `init` idempotency + no default handle;
  `setHandle()` (re-sign card); `exportIdentity()` / `importIdentity()`; DID-derivation helper reuse.
- `src/resolver.ts` — wire `makeRegistryProvider` lookup → relay `/handle/:h`; bare-slug → registry.
- `src/dialout.ts` — auto-`handle_claim` after `hello_ok`; claim ack handling.
- `src/cli.ts` — `handle set|show`, `identity export|import` command groups; `--handle` on `init`.
- `src/commands-doc.ts` — usage entries.
- `test/handles-resolve.test.ts`, `test/identity-portability.test.ts`, `test/card-expiry.test.ts`.

## Tests (TDD — red first)

- **relay:** free handle claims OK; second claim by a different DID → `taken`; re-claim by
  same DID (card refresh) → OK; tampered `claim_sig` → `bad_sig`; card whose `agent_id`
  doesn't derive from its public key → `bad_card`; bad slug → `bad_format`; `GET /handle/:h`
  returns the stored card and 404s for unknown / reserved names.
- **cli resolve:** `friend antony-evans` → registry lookup → validated card → friend_request
  to the card's DID; unknown handle → clean "no such handle" (no crash); `registry:` prefix
  path equivalent.
- **cli expiry:** a past-`expires_at` card → `card_expired` on friend (invite + registry).
- **cli identity:** `init` over an existing `identity.json` is a no-op (same DID, no
  overwrite); `export` then `import` into a fresh home reproduces the same DID; `import`
  refuses to clobber without `--force`.
- **cli handle:** `handle set "Antony Evans"` → slug `antony-evans`, card re-signed, claim
  sent; `taken` surfaced.

## Acceptance

- [ ] A user runs `handle set antony-evans`; a peer runs `friend antony-evans` and the
      request lands in the peer's `friend pending` — no DID, no invite blob.
- [ ] The default `agent.openclaw.local` is replaced by a real, unique, user-chosen handle.
- [ ] Handle resolves **live**: after a key rotation done via carrying `identity.json`
      (same DID) or a fresh card refresh, `friend <handle>` still reaches the current agent.
- [ ] `init` never silently regenerates an existing identity; `export`/`import` round-trips
      a DID across devices.
- [ ] Expired cards/invites are rejected with a clear message instead of orphaning mail.
- [ ] Both suites green; relay deployed; `edge-book` republished to npm. TDD throughout.

## Out of scope

- Delivery receipts (sender-side delivered/acked feedback) → `spec-097-delivery-receipts.md`.
- Phase 2 deliberate-rotation rebind (`identity rotate` + `handle_rebind`).
- Cross-relay / global unique names; any real-world identity attestation (KYC, domain proof).
- A web "find by handle" search box (the `GET /handle/:h` endpoint enables it later).
- DNS / `.well-known` handles (`name@domain`) — deferred; registry chosen for simplest UX.
