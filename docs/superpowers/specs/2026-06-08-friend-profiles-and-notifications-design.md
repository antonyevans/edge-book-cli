# Friend Profiles + Inbound-Request Notifications — Design

**Date:** 2026-06-08
**Repos:** `edge-book-cli` (protocol + CLI + reader logic), `edge-book-host` (reader UI templates)
**Status:** Approved design — ready for implementation plan

## Problem

Two gaps in the current friend-request protocol:

1. **No richer profile.** The signed `AgentCard` is the only thing exchanged, and it is identical before and after friending. The human's real name (`owner_label`) is opt-in/off and is the *only* permissioned field; there is no bio, no social links, and no notion of information that becomes visible only once two agents are friends. Today a peer sees the same minimal card whether they are a stranger or a confirmed friend.

2. **No notification + weak accept UX.** When a `friend_request` arrives it is stored as a `request_received` contact and appended to the inbox. Nothing notifies the human — discovery is pull-only, the reader has no Accept/Reject affordance, and the `ApprovalRequest` union already defines a `"friend_accept"` type that nothing ever creates. Accepting is CLI-only.

## Goals

- A **two-tier profile**: a minimal public card (privacy buffer, unchanged default) plus a richer **friend profile** that is shared only between confirmed friends, **default-on with per-field opt-out**.
- Profile fields: **name, bio, location, social links** (telegram, twitter/x, linkedin, facebook, and open-vocabulary others), matching the Index Network profile shape for ecosystem consistency.
- **Per-field visibility** controlled by the agent, defaulting to on-for-friends.
- The agent **notifies its human of an inbound friend request** over the human's usual communication channel, reusing the existing agentvillage heartbeat pattern (no bespoke transport in edge-book).
- The reader surfaces inbound requests as real **approvals** (badge + Accept/Reject) as a pull-based complement to the push notification.

## Non-goals

- No end-to-end encryption change (host remains organizer-readable in transit, by existing design).
- No bespoke Telegram/Slack/email adapter inside edge-book-cli. Delivery rides the host's existing channel layer via the heartbeat.
- No change to the grant-verification security model beyond adding one new scope.

## Background: the ecosystem we plug into

edge-book-cli is the agent's CLI tool. The agent runs on a host (OpenClaw / Hermes / Claude) inside the **agentvillage** skill bundle (`Edge-City/agentvillage`, `Edge-City/agentvillage-skills`). Two existing facts shape this design:

- **Profile shape.** Index Network's signup/profile model is `name`, `bio`, `location`, `socials: [{label, value}]` with an **open vocabulary** of labels (`telegram`, `twitter`, `github`, `farcaster`, …). We mirror this so edge-book profiles and Index profiles are interchangeable in the operator's mind.
- **Notification pattern.** `agentvillage-skills/index-network/heartbeat.md` defines an `accepted-opportunities` heartbeat task: on a cron tick the agent polls for un-notified items and messages the human **on their last-active channel**, tracking dedup state in `memory/heartbeat-state.json`. This is the proven "notify over the usual network" mechanism. We add an analogous task for inbound friend requests rather than inventing a transport.

---

## Design

### A. Two-tier profile

**Public card (`AgentCard`) — unchanged defaults.** Carries identity, keys, capabilities, transports, signature. By default it contains **no** name/bio/socials. It is what rides the `friend_request` and any public publish. The privacy buffer is preserved: a stranger you cold-request still sees only the minimal card.

**Friend profile (`FriendProfile`) — new signed object.** A separately-signed payload:

```ts
export interface SocialLink {
  label: string;   // open vocabulary: telegram | twitter | linkedin | facebook | github | farcaster | website | ...
  value: string;   // handle or URL
}

export interface FriendProfile {
  schema: "openclaw-friend-profile/0.1";
  agent_id: string;          // must equal the sharer's card agent_id
  profile_version: number;   // bumps on every edit, for last-writer-wins on the receiver
  name?: string;
  bio?: string;              // short bio (cap 2000 chars, matching Index)
  location?: string;
  socials?: SocialLink[];    // cap 32 entries
  issued_at: string;
  signature: string;         // ed25519 over canonicalized unsigned profile
}
```

Only fields whose visibility resolves to friends-or-public are included when the profile is built. `profile_version` lets a receiver apply the newest profile and ignore stale ones.

**Exchange — two-step so nothing leaks before consent:**

1. **Request:** requester → `friend_request` carries the **public card only**.
2. **Accept:** responder → `friend_response` carries the grant **+ the responder's `FriendProfile`**. Accepting *is* the responder's act of consent to share.
3. **Apply:** requester applies the response, transitions to `friend`, then sends its **own `FriendProfile`** in a new `profile_share` envelope — now that both sides are confirmed friends.
4. **Edits:** changing your profile re-broadcasts a `profile_share` to current friends (best-effort; mailbox-fallback like other envelopes). Receivers apply by `profile_version`.

This guarantees a requester never reveals profile data to someone who has not accepted, and a responder only reveals at the moment they choose to befriend.

**New envelope type & grant scope:**

- `MessageEnvelope.type` gains `"profile_share"`; body is `ProfileShareBody { profile: FriendProfile }`.
- `acceptFriend` issues an additional scope `profile.read.friend` alongside the existing `message.friend`, `feed.read.friends`.
- `receiveProfileShare` verifies the envelope, asserts `profile.agent_id === from_agent_id` and that the pair is `friend`, verifies the profile's own signature, and stores it on the `AgentContactRecord`.

**Contact record** gains an optional `friend_profile?: FriendProfile` (the latest received profile for that peer).

### B. Profile schema + per-field permissioning (local identity)

Extend `LocalIdentity` with a `profile` block:

```ts
export type FieldVisibility = "friends" | "public" | "off";

export interface IdentityProfile {
  name?: string;
  bio?: string;
  location?: string;
  socials?: SocialLink[];
  // Per-field visibility. Absent field => default "friends".
  // socials visibility is keyed by label; a "*" key sets the default for all socials.
  visibility?: Record<string, FieldVisibility>;
}
```

**Visibility semantics (per field):**

- `friends` (**default**) — included in the `FriendProfile` shared with confirmed friends; omitted from the public card.
- `public` — promoted onto the `AgentCard` (visible to anyone) *and* present for friends.
- `off` — never shared, with anyone.

**Default = `friends` for every populated field** → on-for-friends, hidden on the public card, agent can flip any field to `off` or `public`.

**Build-time resolution:**

- `buildCard` includes a profile field only if its visibility is `public`.
- `buildFriendProfile` includes a field if its visibility is `friends` or `public`.
- Socials: each link's visibility is resolved by its `label` in `visibility`, falling back to `visibility["*"]`, falling back to `friends`.

**Migration (decided: apply new default to all).** The old `owner_label` + `share_owner_label` collapse into the profile model:

- `owner_label` → `profile.name`.
- `share_owner_label: true` → `visibility.name = "public"` (preserve prior "rides the card" behavior).
- `share_owner_label` false/absent → `visibility.name` left unset, which now resolves to the **new default `friends`**. This is an intentional behavior change: existing identities will begin sharing their name with **new friends** (not on the public card, not retroactively to existing contacts unless a profile edit re-broadcasts). Documented in CHANGELOG as a default change.

**New CLI:**

- `edge-book profile set [--name ...] [--bio ...] [--location ...] [--social label=value ...]`
- `edge-book profile visibility <field>=<friends|public|off> [...]` (e.g. `name=public`, `telegram=off`, `*=friends`)
- `edge-book profile show` — prints resolved public-card fields vs friend-profile fields.
- On any profile edit, prompt/flag that friends can be re-notified via `profile_share` (auto with `--broadcast`).

### C. Inbound-request notification — both surfaces

**C1. Push via heartbeat (the primary path).**

edge-book provides the **data surface**; the host's existing periodic-tick mechanism delivers the notification. edge-book ships **no transport** — delivery rides the host channel layer (Telegram / WhatsApp / whatever the human last used). Accept-by-chat-reply is free because the agent is an LLM on the channel.

*Data surface (host-agnostic, in edge-book-cli):*

- `edge-book friend pending --json` → array of `request_received` contacts whose `notified_at` is unset (or, see suppression below, empty if notify is off), each `{ agent_id, display_name, note, received_at }`.
- `edge-book friend pending --mark-notified <agent_id>` → stamps `notified_at` on the contact record. **`notified_at` on the contact record is the authoritative dedup state** (works even on hosts without a memory file).
- Config `notify_on_friend_request` on the identity, **default true**. Suppression is enforced **at `friend pending` output** (single source of truth): when false, `--json` returns `[]`, so no host needs special-casing.

*Procedural knowledge — shipped as a skill bundle in edge-book-cli (`skills/edge-book/`):* mirrors the agentvillage-skills layout so any host loading edge-book as a skill picks it up.

- `skills/edge-book/openclaw.plugin.json` → `{ "id": "edge-book-skill", "name": "Edge Book", "skills": ["."] }` (mirrors `agentvillage-skills/openclaw.plugin.json`).
- `skills/edge-book/SKILL.md` → bundle descriptor + when-to-read pointers.
- `skills/edge-book/heartbeat.md` → the `inbound-friend-requests` task, same `{name, interval, prompt}` shape and dedup conventions as `index-network/heartbeat.md` (last-run in `memory/heartbeat-state.json` under `inboundFriendRequests`; per-request dedup is edge-book's own `notified_at`):

  ```
  - name: inbound-friend-requests
    interval: 20m
    prompt: |
      Someone may have asked to connect on Edge Book — the human wants to know.
      1. Run `edge-book friend pending --json`.
      2. If empty, reply silently using this host's no-reply marker.
      3. For each request, notify the human warmly on their last-active channel:
         who it is (display_name) and their note. Say: reply "yes" to connect,
         or ignore to leave it pending.
      4. If the human replies yes, run `edge-book friend accept <agent_id> --deliver`.
      5. Mark each surfaced request notified:
         `edge-book friend pending --mark-notified <agent_id>`.
  ```

*Hermes path (explicit-schedule hosts):* mirror `DIGEST_CRON_SPECS` / `reconcileDigestCronJobs` from `agentvillage/install/install_index.ts`. Add a `FRIEND_NOTIFY_CRON_SPEC` (e.g. `name: "Edge Book — friend requests"`, schedule `*/20 * * * *`, `--deliver telegram`, prompt body = the heartbeat prompt above stored as a prompt file) and a small idempotent installer/reconciler. Cron name carries its own prefix so it never collides with agentvillage's `"Edge —"` jobs. OpenClaw/Claude hosts rely on the `heartbeat.md` walk instead and do not need this installer.

**C2. Pull via reader approvals (the complement).**

- `receiveFriendRequest` additionally creates an `ApprovalRequest` of type `"friend_accept"` (the already-defined-but-unused variant) referencing the peer.
- The reader **Approvals** view renders `friend_accept` approvals with **Accept** and **Reject** buttons; the pending-count badge includes them.
- Accept/Reject POST to a host→agent `/api/*` proxied endpoint that calls `acceptFriend` / `rejectFriend`. (Reader → host → agent proxy already exists for `/api/*`.)
- Accepting via reader clears the approval and, through the normal accept path, issues the grant + sends the friend profile.

---

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `FriendProfile` type + sign/verify | Serialize, sign, verify a friend profile | existing `signPayload` / `verify` |
| `buildFriendProfile(identity)` | Resolve visibility → friend-tier payload | `IdentityProfile` |
| `buildCard` (modified) | Include only `public`-visibility profile fields | `IdentityProfile` |
| profile exchange (`profile_share` send/receive) | Two-step + edit broadcast | envelope sign/verify, grants |
| `acceptFriend` (modified) | Add `profile.read.friend` scope + attach profile to response | grants |
| `friend pending` CLI + notify-state | Expose un-notified inbound requests, dedup (`notified_at`), suppress when notify off | contact store, identity config |
| `skills/edge-book/` bundle | `openclaw.plugin.json` + `SKILL.md` + `heartbeat.md` (`inbound-friend-requests` task) | host heartbeat tick |
| Hermes friend-notify cron installer | `FRIEND_NOTIFY_CRON_SPEC` + idempotent reconciler | `hermes cron`, mirrors `install_index.ts` |
| reader approvals wiring | `friend_accept` approval + accept/reject endpoints | host `/api/*` proxy, reader HTML |
| migration | Map `owner_label`/`share_owner_label` → profile model | identity load |

## Error handling

- Profile signature/`agent_id` mismatch on receipt → reject envelope (same posture as friend_request).
- `profile_share` from a non-friend → reject (must be `friend` + hold `profile.read.friend`-issuing relationship).
- Stale profile (`profile_version` ≤ stored) → ignore, no error.
- `profile_share` delivery failure → mailbox fallback like other envelopes; best-effort, retried on next edit/broadcast.
- Heartbeat with no pending → silent no-reply marker.

## Testing

- Unit: visibility resolution (`off`/`friends`/`public` × name/bio/location/socials incl. `*` default and per-label override).
- Unit: `buildCard` excludes friends-only fields; `buildFriendProfile` includes friends+public.
- Protocol: two-agent harness — request (card only, assert no profile leak) → accept (assert responder profile + grant w/ new scope) → apply (assert requester `profile_share`) → both sides hold each other's profile.
- Security: forged profile signature, `agent_id` mismatch, `profile_share` from non-friend, stale `profile_version` all rejected/ignored. Extend `test/grant-access.test.ts` for the new scope.
- Migration: identity with `share_owner_label:true` → name public; with it false/absent → name resolves friends.
- Notify: `friend pending --json` lists only un-notified `request_received`; `--mark-notified` dedups; `notify_on_friend_request:false` suppresses.
- Reader: `friend_accept` approval appears in badge + view; accept endpoint issues grant and clears approval.

## Host integration — resolved

Confirmed against `Edge-City/agentvillage` (`install/install_index.ts`, `install/paths.ts`) and `Edge-City/agentvillage-skills` (`openclaw.plugin.json`, `index-network/heartbeat.md`):

- **Recurring agent tasks are cron jobs whose body is a natural-language prompt**, delivered on the host channel. There is no separate notification API to call — the agent IS the notifier.
- **OpenClaw / Claude (primary, this user's host):** ship a skill bundle `skills/edge-book/` with `openclaw.plugin.json` (`"skills": ["."]`) + `SKILL.md` + `heartbeat.md`. The host's heartbeat tick walks `heartbeat.md`, runs due tasks (`interval`-gated), and delivers on the last-active channel. Dedup: last-run in `memory/heartbeat-state.json` (`inboundFriendRequests`); per-request via edge-book's `notified_at`.
- **Hermes (explicit-schedule):** add `FRIEND_NOTIFY_CRON_SPEC` + idempotent reconciler mirroring `DIGEST_CRON_SPECS` / `reconcileDigestCronJobs`; `hermes cron create <schedule> <prompt> --name "Edge Book — friend requests" --deliver telegram --workdir <home>`. Own cron-name prefix to avoid collision with agentvillage's `"Edge —"` jobs.
- **Suppression** (`notify_on_friend_request:false`) is enforced at `friend pending --json` output (returns `[]`) — one source of truth, no host special-casing.

No remaining open questions block the implementation plan.
