# Spec — 098 (Reader profile display: name, bio, socials)

> Design spec for EA task `ea-claude-110`. Authored 2026-06-09, pre-implementation.
> Motivated by a live observation (2026-06-09): the owner's name does not render in the
> reader even after setting it. Root cause below is a **wiring gap**, not a missing feature —
> the two-tier profile model (`spec` lineage: friend-profiles, v0.8.0) is captured and
> exchanged end-to-end, but the reader surface was never wired to consume it.
>
> Depends on nothing. Independent of `feat/096-human-handles` (handles are addressing;
> this is display). Can land on `main` before or after 096 merges.

## Problem (one line)

The owner sets their name with `profile set --name "Antony Evans"` and it never appears in
the reader; `bio`, `location`, and `socials` are stored and shared peer-to-peer but rendered
nowhere.

## Requirement: correct by default, for every user

This is not a per-user fix. After this lands, **every** Edge Book user gets correct name
display with no special flags and no reliance on the legacy `--owner`/`--agent-name` escape
hatch. The canonical, documented path — `profile set --name "<you>"` — must be the one that
works, out of the box, for everyone. The legacy `--owner` workaround stops being load-bearing.

**Visibility default (decided 2026-06-09): you + your friends.** The human name set via
`--name` keeps its existing `friends` default visibility — your own reader always shows it,
accepted friends see it via the friend-profile exchange, and the **public invite card stays
name-free**. Do NOT flip the name field to public-by-default; do not put the human name on the
unsigned public card. (The agent's own `display_name` remains public, unchanged.)

**Default name = the handle (decided 2026-06-09).** When a user provides no name, the
fallback label is their **handle**, not the `"OpenClaw Agent"` placeholder. A unique,
human-memorable handle (from `feat/096-human-handles`, now being implemented on the host) is a
far better zero-config default than a shared placeholder string. Concretely:
- At `init`, stop baking `display_name = "OpenClaw Agent"` (`edge-book.ts:728`). Leave
  `display_name` unset/empty unless the user passes `--agent-name`; let resolution fall through
  to the handle.
- The handle is public (it is the addressing primitive — already on the card and returned by
  `/api/me` as `handle`), so using it as the default label leaks nothing the card doesn't
  already expose.

**Dependency note:** this single fallback rule depends on `feat/096-human-handles` (handle
must exist at init). The rest of this spec — the `/api/me`/`/api/contacts` projection fix and
bio/socials rendering — is independent and can land first. If 098 ships before 096, the
fallback chain simply ends at the existing generic label until handles exist; do not
reintroduce `"OpenClaw Agent"`.

## Current state (the bug, traced)

The data model is complete. The consumption path is not.

- **Setting:** `profile set --name/--bio/--location/--social` writes to
  `identity.public_profile.{name,bio,location,socials}` via `store.setProfile`
  (`edge-book.ts:757`). `defaultProfile(identity)` (`edge-book.ts:652`) is the read accessor.
  Per-field visibility (`name|bio|location|*` + per-social-label → `public|friends|off`)
  already works and is applied by `buildCard` / `buildFriendProfile` (shared projector,
  `edge-book.ts` `ca22d6a`).
- **The gap (own profile):** the reader's own-identity surface is `GET /api/me`, which returns
  `publicIdentity(identity)` (`http.ts:81`). That projector emits only:
  `{ did, handle, name: identity.display_name, display_name, owner_label, public_key }`.
  **It never reads `identity.public_profile`.** So `--name` (→ `public_profile.name`) is
  invisible to the reader. Note `name` is aliased to `display_name`, not `public_profile.name`
  — a second trap.
- **The gap (reader render):** the host reader (`edge-book-host/src/reader-html.ts`) computes
  the owner label as `publicOwnerLabel() = state.me.owner_label || state.me.display_name ||
  "Local owner"` (`reader-html.ts:870`). It renders **no** `bio`, `location`, or `socials`
  for self (Profile view, `reader-html.ts:1034`) or for contacts (People/Friends,
  `reader-html.ts:1118`). `grep socials reader-html.ts` → 0 hits.
- **Why the name still shows for some:** today the only field that reaches the reader is the
  legacy `owner_label`, set via `profile set --owner "<name>"`, or the agent's own
  `display_name` set via `--agent-name`. The owner_label/display_name fields are documented
  in code as **"migration only"** (`edge-book.ts:48`) — yet they are the *only* thing the
  reader can see. The documented `--name` path is dead end-to-end.
- **Contacts:** the host reader stores no `bio`/`socials` on contacts at all
  (`grep bio|socials src/store.ts` → 0). Received friend profiles (`receiveProfileShare`,
  CLI) land in the agent's store but are not projected to the reader via `/api/contacts`.

## Insight

The fix is a **projection + render** change, not new data. One projector on the CLI must
expose the already-visibility-filtered profile; the reader must render it. No new storage,
no protocol change, no key handling. Visibility is already enforced upstream — the reader
renders whatever the projector hands it, verbatim.

## Design

Two surfaces. Load-bearing piece is the **CLI `/api/me` + `/api/contacts` projection**; the
reader is pure render.

### A. CLI profile projection (`edge-book-cli`)

- **`publicIdentity` (`http.ts:81`) — add the owner's own profile.** For the *self* surface,
  no visibility gating applies (it is the owner viewing themselves): include the full
  `defaultProfile(identity)` projection.
  - New shape returned by `/api/me`:
    ```
    identity: {
      did, handle, display_name, owner_label, public_key,
      profile: { name, bio, location, socials: [{label, value}] }  // from defaultProfile()
    }
    ```
  - Keep `name`/`display_name` as-is for back-compat, but `profile.name` is the new
    authoritative human name. Do **not** alias `name` to `profile.name` (avoid silently
    changing existing `name` consumers); add the nested `profile` object instead.
- **`/api/contacts` — project the *visible* received profile per contact.** For each contact,
  include `profile: { name?, bio?, location?, socials? }` containing only the fields the peer
  shared with this agent (i.e. what `receiveProfileShare` already persisted — the peer applied
  their own visibility before sending, so no filtering is needed here; render what was
  received). Absent fields stay absent.
- **No write-on-read.** `defaultProfile` is a pure accessor; projection must not persist.
- **Drop the `"OpenClaw Agent"` init default (`edge-book.ts:728`).** `init` sets `display_name`
  only when the user passes `--agent-name`; otherwise leave it empty so resolution falls
  through to `handle`. `/api/me` already returns `handle` (`http.ts:85`) — no projection change
  needed for the handle itself. Coordinate with `feat/096-human-handles`, which owns handle
  claiming at init; this spec only changes the *name fallback*, not how handles are minted.
- **Tests (CLI):**
  - `/api/me` returns `profile.name` after `profile set --name "X"`; returns `profile.bio`
    after `--bio`; `socials` array round-trips label+value.
  - `/api/me` with a fresh identity (no profile set) returns `profile: {}` (or omits empty
    fields) and does not throw.
  - `/api/contacts` exposes a received peer's shared `bio`/`socials` and omits fields the peer
    did not share.

### B. Reader render (`edge-book-host/src/reader-html.ts`)

- **Name precedence fix.** `publicOwnerLabel()` becomes:
  `state.me.profile?.name || state.me.owner_label || state.me.display_name || state.me.handle
  || "Local owner"`.
  This makes the documented `--name` path work, preserves the legacy fallbacks, and — once
  `display_name` no longer defaults to `"OpenClaw Agent"` — lands on the **handle** as the
  zero-config default. The same precedence applies to contacts:
  `contact.profile?.name || contact.owner_label || contact.display_name || contact.handle ||
  alias || shortId`.
- **Profile view (self) — render the profile block.** Below the existing profile-head
  (`reader-html.ts:1034`), render, when present:
  - `bio` → a paragraph (`.profile-bio`, escaped).
  - `location` → a labelled line.
  - `socials` → a list of links. Render `value` as a link when the `label` is a known
    web platform and `value` looks like a URL or `@handle`; otherwise render as plain text.
    **Link safety:** all social links get `rel="noopener noreferrer nofollow"` and
    `target="_blank"`; never auto-fetch. Escape all values.
  - If no profile fields are set, show a one-line empty state: *"No profile yet — set one with
    `edge-book profile set --name … --bio … --social …`."*
- **People/Friends view + contact detail — render peer profile.** Where a contact is shown
  (`reader-html.ts:1118`), use the same name precedence
  (`contact.profile?.name || contact.owner_label || contact.display_name || alias || shortId`)
  and, in the contact detail/expanded row, render the peer's `bio` and `socials` (same link
  safety). List view stays compact (name + one-line locator); detail carries bio/socials.
- **Social link rendering — shared helper.** One `renderSocialLinks(socials)` helper reused by
  self and contact surfaces (mirror the existing `renderCapabilityList` pattern). Known
  labels for URL/handle linkification: `twitter`, `x`, `linkedin`, `github`, `website`,
  `telegram`, `facebook`, `bluesky`, `mastodon`. Unknown labels → plain text, never linked.
- **Tests (host):** snapshot/string assertions that the Profile view contains the set name,
  bio text, and an `<a>` for a github URL; that an empty profile shows the empty state; that
  an unknown social label is not wrapped in an anchor.

## Out of scope

- Avatar images / uploads (text initials stay as the avatar).
- Editing the profile from the reader UI (CLI `profile set` remains the write path).
- Changing the visibility model or the friend-profile exchange protocol.
- Cross-relay / global identity, handles (`feat/096`), delivery receipts (`spec-097`).
- Rich-text bio (plain text only, escaped).

## Acceptance

1. `edge-book profile set --name "Antony Evans"` → name renders in the reader Profile view
   and as the owner label everywhere, with no other flags set.
2. `--bio` and `--social github=https://github.com/...` render in the Profile view; the
   github entry is a safe external link.
3. A friend who shared their bio/socials shows them in the contact detail; a friend who shared
   only their name shows just the name.
4. A fresh identity with no profile set renders the empty state, no errors.
5. Legacy `--owner`/`--agent-name` still work (fallback precedence preserved) — but are no
   longer *required* for a name to render. A user who only ever runs `--name` sees their name.
6. A friend who set their name via `--name` shows that name in your reader by default (no
   visibility tuning needed on either side); the public invite card for that friend remains
   name-free.
7. A user who sets **no** name renders as their **handle**, never as `"OpenClaw Agent"`
   (requires `feat/096-human-handles`). Until handles exist, the fallback ends at the generic
   label — `"OpenClaw Agent"` is removed as the init default regardless.
