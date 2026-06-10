# Reader Profile Display (spec-098 / ea-claude-110) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented `profile set --name "Antony Evans"` path actually render in the Sanctum reader (name, bio, location, socials — self and friends), and remove the stat "data boxes" from the profile card.

**Architecture:** This is a projection + render fix, no new storage or protocol. (1) CLI: `/api/me`'s `publicIdentity()` starts returning the already-stored `identity.profile` via the pure `defaultProfile()` accessor; the `"OpenClaw Agent"` init default is dropped. `/api/contacts` already passes through `friend_profile` — no CLI change needed there. (2) Host reader: name precedence becomes `profile.name → owner_label → display_name → handle → generic`, a shared `renderSocialLinks()` helper renders safe external links, the Profile view renders bio/location/socials, contact rows use `friend_profile.name`, and the profile-panel `trustStrip` stat boxes are deleted. (3) Rollout: npm publish CLI + upgrade on Hermes; host auto-deploys to Fly on push to main.

**Tech Stack:** TypeScript, Node `node --test` (CLI) / `tsx --test` (host), string-template client JS in the host reader (tests are source-regex assertions per existing pattern).

**Spec:** `edge-book-cli/docs/spec-098-reader-profile-display.md`. Task: `executive-assistant/tasks/ea/ea-claude-110-edge-book-reader-profile-display.md`.

**Repos:** Part A = `~/claude/edge-book-cli` (branch `feat/098-profile-display`). Part B = `~/claude/edge-book-host` (branch `feat/098-profile-render`). Work each part on its own branch in its own repo.

**Out of scope (per spec):** avatar images, editing profile from the reader, visibility-model changes, the CLI's local dashboard (`dashboard-script.ts`) — hosted Sanctum is the surface in use. Linkify only `http(s)` URLs; `@handle` values render as plain text (never guess a platform URL).

---

## Part A — CLI (`~/claude/edge-book-cli`)

### Task 1: `/api/me` exposes the owner profile

**Files:**
- Modify: `src/http.ts` (`publicIdentity`, ~line 91)
- Test: `test/local-api.test.ts` (append; reuses its existing `tempRoot`/`login`/`jsonRequest`/`authHeaders`/`serverBaseUrl`/`closeServer` helpers)

- [ ] **Step 1: Write the failing test** — append to `test/local-api.test.ts`:

```ts
test("/api/me returns the owner profile set via profile set --name/--bio/--social", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "profile-api.openclaw.local" });
  await store.setProfile({
    name: "Antony Evans",
    bio: "Founder COO building agent infrastructure",
    location: "San Francisco",
    socials: [{ label: "github", value: "https://github.com/antonyevans" }]
  });
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const me = await jsonRequest(baseUrl, "/api/me", { headers: authHeaders(auth) });
    assert.equal(me.status, 200);
    const identity = me.body.identity as Record<string, unknown>;
    const profile = identity.profile as Record<string, unknown>;
    assert.equal(profile.name, "Antony Evans");
    assert.equal(profile.bio, "Founder COO building agent infrastructure");
    assert.equal(profile.location, "San Francisco");
    assert.deepEqual(profile.socials, [{ label: "github", value: "https://github.com/antonyevans" }]);
    assertNoPrivateKeyMaterial(me.body);
  } finally {
    await closeServer(server);
  }
});

test("/api/me with a fresh identity returns an empty profile object, no errors", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "fresh-api.openclaw.local" });
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const me = await jsonRequest(baseUrl, "/api/me", { headers: authHeaders(auth) });
    assert.equal(me.status, 200);
    const identity = me.body.identity as Record<string, unknown>;
    assert.deepEqual(identity.profile, {});
  } finally {
    await closeServer(server);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/local-api.test.ts`
Expected: the two new tests FAIL (`profile` is `undefined`); existing tests PASS.

- [ ] **Step 3: Implement** — in `src/http.ts`, add the import and rewrite `publicIdentity`:

```ts
import { defaultProfile } from "./profile.ts";
```

```ts
function publicIdentity(identity: LocalIdentity): Record<string, unknown> {
  // Self surface: the owner viewing themselves — no visibility gating (spec-098).
  const profile = defaultProfile(identity);
  return {
    did: identity.agent_id,
    handle: identity.handle,
    name: identity.display_name,
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    public_key: compactPem(identity.public_key_pem),
    profile: {
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.bio ? { bio: profile.bio } : {}),
      ...(profile.location ? { location: profile.location } : {}),
      ...(profile.socials && profile.socials.length ? { socials: profile.socials } : {})
    }
  };
}
```

Note the return type changes `Record<string, string>` → `Record<string, unknown>`. Keep `name`/`display_name` aliased as-is (back-compat; do NOT alias `name` to `profile.name`).

- [ ] **Step 4: Run tests**

Run: `node --test test/local-api.test.ts` → PASS, then full suite `npm test` → PASS (the dialout/mvp-concurrency tests also touch `/api/me` — confirm nothing asserts the old flat shape).

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/local-api.test.ts
git commit -m "feat(098): /api/me exposes owner profile (name, bio, location, socials)"
```

### Task 2: `/api/contacts` passes through `friend_profile` (pin with a test)

**Files:**
- Test: `test/local-api.test.ts` (append only — `/api/contacts` already returns raw contact records including `friend_profile`; this test pins the contract the reader will rely on)

- [ ] **Step 1: Write the test** — append to `test/local-api.test.ts` (also add `AgentContactRecord` to the `import type` from `../src/types.ts` at the top of the file):

```ts
test("/api/contacts exposes a stored friend_profile verbatim", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "contacts-api.openclaw.local" });
  // Simulate a received, validated friend profile the way storeFriendProfile persists it.
  const contacts = await store.contacts();
  contacts["did:peer:test"] = {
    peer_agent_id: "did:peer:test",
    aliases: ["peer.openclaw.local"],
    display_name: "Peer Agent",
    advertised_capabilities: [],
    card_url: "",
    known_endpoints: [],
    public_keys: [],
    relationship_state: "friend",
    capability_grants: [],
    last_card_hash: "",
    last_card_version: 1,
    last_card_refresh_at: "2026-06-10T00:00:00Z",
    last_successful_delivery_at: "",
    audit_refs: [],
    created_at: "2026-06-10T00:00:00Z",
    updated_at: "2026-06-10T00:00:00Z",
    friend_profile: {
      schema: "openclaw-friend-profile/0.1",
      agent_id: "did:peer:test",
      profile_version: 2,
      name: "Peer Human",
      bio: "Friend bio",
      socials: [{ label: "github", value: "https://github.com/peer" }],
      issued_at: "2026-06-10T00:00:00Z",
      signature: "sig"
    }
  } satisfies AgentContactRecord;
  await store.saveContacts(contacts);
  const server = await startEdgeBookServer({ home: root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = serverBaseUrl(server);
    const auth = await login(baseUrl);
    const res = await jsonRequest(baseUrl, "/api/contacts", { headers: authHeaders(auth) });
    assert.equal(res.status, 200);
    const record = (res.body.contacts as Record<string, Record<string, unknown>>)["did:peer:test"];
    const fp = record.friend_profile as Record<string, unknown>;
    assert.equal(fp.name, "Peer Human");
    assert.equal(fp.bio, "Friend bio");
    assert.deepEqual(fp.socials, [{ label: "github", value: "https://github.com/peer" }]);
  } finally {
    await closeServer(server);
  }
});
```

(If `store.saveContacts` is not public on `EdgeBookStore`, write the contacts file directly with the same shape via `fs.writeFile(path.join(root, "contacts.json"), ...)` — check `src/store-files.ts` `CONTACTS_FILE` for the exact filename.)

- [ ] **Step 2: Run it** — `node --test test/local-api.test.ts`. Expected: PASS immediately (pass-through already exists). If it fails, the projection strips fields — fix the projection, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/local-api.test.ts
git commit -m "test(098): pin /api/contacts friend_profile pass-through"
```

### Task 3: Drop the `"OpenClaw Agent"` init default

**Files:**
- Modify: `src/store-identity.ts:40`
- Test: `test/local-api.test.ts` (append)

- [ ] **Step 1: Write the failing test:**

```ts
test("init without --agent-name leaves display_name empty (no OpenClaw Agent placeholder)", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  const identity = await store.init({ handle: "no-name.openclaw.local" });
  assert.equal(identity.display_name, "");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/local-api.test.ts` → FAIL (`"OpenClaw Agent"` !== `""`).

- [ ] **Step 3: Implement** — in `src/store-identity.ts` change:

```ts
    display_name: input.displayName || "",
```

- [ ] **Step 4: Run the FULL suite** — `npm test`. Other tests (onboarding-names, cards, smoke) may assert the old default; if any do, update those assertions to expect `""` (the spec mandates removing the placeholder regardless: spec-098 acceptance #7). If `validateCard` or card building rejects an empty `display_name`, surface that as a finding before patching — do not silently re-add a placeholder.

- [ ] **Step 5: Commit**

```bash
git add src/store-identity.ts test/local-api.test.ts
git commit -m "feat(098): drop 'OpenClaw Agent' init default; display_name empty unless --agent-name"
```

### Task 4: Release CLI 0.12.4

- [ ] **Step 1:** Bump `package.json` version to `0.12.4`; add CHANGELOG entry if `CHANGELOG.md` exists (check first):

```
## 0.12.4 — 2026-06-10
- /api/me now returns the owner profile (name, bio, location, socials) — spec-098
- init no longer defaults display_name to "OpenClaw Agent"
```

- [ ] **Step 2:** `npm test && npm run build` → all green.
- [ ] **Step 3:** Commit `chore(release): v0.12.4 — reader profile projection (spec-098)`, merge branch to main (PR per repo convention), then `npm publish`.

---

## Part B — Host reader (`~/claude/edge-book-host`)

All reader tests follow the existing source-regex pattern (`test/reader-contact-capabilities.test.ts`): assert against `renderReaderHtml({ csrf_token: "t", agent_online: true })` output. The script-syntax test (`test/reader-script-syntax.test.ts`) already guards JS validity — run it after every edit to the script strings.

### Task 5: Name precedence — `profile.name` first, handle fallback

**Files:**
- Modify: `src/reader-script-helpers.ts` (`publicOwnerLabel` ~line 207, `agentSubLabel` ~210, `agentLabel` ~263, contact-name line ~326)
- Modify: `src/reader-script-app.ts` (contact item rendering, lines ~114 and ~121)
- Create: `test/reader-profile.test.ts`

- [ ] **Step 1: Write failing tests** — create `test/reader-profile.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReaderHtml } from "../src/reader-html.js";
const html = renderReaderHtml({ csrf_token: "t", agent_online: true });

test("owner label prefers profile.name, then legacy fields, then handle", () => {
  assert.match(html, /state\.me\.profile && state\.me\.profile\.name/);
  assert.match(html, /state\.me\.handle/);
});

test("reader has a shared contactLabel helper using friend_profile.name first", () => {
  assert.match(html, /function contactLabel/);
  assert.match(html, /contact\.friend_profile && contact\.friend_profile\.name/);
});
```

- [ ] **Step 2: Run to verify failure** — `cd ~/claude/edge-book-host && npx tsx --test test/reader-profile.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/reader-script-helpers.ts` replace `publicOwnerLabel` and add `contactLabel`:

```js
  // Name precedence (spec-098): profile.name -> owner_label -> display_name -> handle -> generic.
  function publicOwnerLabel() {
    if (!state.me) return "Local owner";
    return (state.me.profile && state.me.profile.name) || state.me.owner_label || state.me.display_name || state.me.handle || "Local owner";
  }
  // Same precedence for peers: shared friend-profile name first, then legacy fields.
  function contactLabel(contact) {
    return (contact.friend_profile && contact.friend_profile.name) || contact.owner_label || contact.display_name || (contact.aliases && contact.aliases[0]) || shortId(contact.peer_agent_id);
  }
```

Then replace every inline contact-name expression with `contactLabel(contact)` / `contactLabel(c)`:
- `reader-script-helpers.ts` `agentLabel` (~263): `return contactLabel(contact);` (keep the `state.me` self-check above it)
- `reader-script-helpers.ts` ~326 ("your people" rail): `var name = contactLabel(c);`
- `reader-script-app.ts` ~114: `item(contactLabel(contact), ...)`
- `reader-script-app.ts` ~121: `initials(contactLabel(contact) ...)` — keep the existing extra fallbacks for initials if present.

Also update `agentSubLabel` (~210) so the subtitle compares against the resolved owner name:

```js
  function agentSubLabel() {
    if (!state.me) return "hosted session";
    var owner = publicOwnerLabel();
    var agent = state.me.display_name;
    return (owner && agent && owner !== agent) ? agent : "hosted session";
  }
```

- [ ] **Step 4: Run tests** — `npx tsx --test test/reader-profile.test.ts test/reader-script-syntax.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add -A src test && git commit -m "feat(098): reader name precedence — profile.name first, handle fallback, shared contactLabel"`

### Task 6: Render bio/location/socials in Profile view (+ empty state, + safe links)

**Files:**
- Modify: `src/reader-script-helpers.ts` (add `renderSocialLinks` + `renderOwnProfileDetails` next to `renderCapabilities`)
- Modify: `src/reader-script-app.ts` (profile view, ~line 31)
- Modify: `src/reader-styles-sections.ts` (profile styles)
- Test: `test/reader-profile.test.ts` (append)

- [ ] **Step 1: Write failing tests** — append to `test/reader-profile.test.ts`:

```ts
test("reader has a renderSocialLinks helper with safe external links", () => {
  assert.match(html, /function renderSocialLinks/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /target="_blank"/);
});

test("profile view renders bio, location, and socials from state.me.profile", () => {
  assert.match(html, /renderOwnProfileDetails\(\)/);
  assert.match(html, /profile-bio/);
});

test("profile view has an empty state when no profile is set", () => {
  assert.match(html, /No profile yet/);
});
```

- [ ] **Step 2: Run to verify failure** — `npx tsx --test test/reader-profile.test.ts` → 3 new FAILs.

- [ ] **Step 3: Implement** — in `src/reader-script-helpers.ts` add (near `renderCapabilities`):

```js
  // spec-098: linkify only http(s) URLs on a known-platform allowlist; everything
  // else renders as escaped plain text. Never auto-fetch.
  var SOCIAL_LINK_LABELS = { twitter: 1, x: 1, linkedin: 1, github: 1, website: 1, telegram: 1, facebook: 1, bluesky: 1, mastodon: 1 };
  function renderSocialLinks(socials) {
    if (!socials || !socials.length) return "";
    return '<div class="profile-socials">' + socials.map(function (s) {
      var value = String(s.value || "");
      var linkable = SOCIAL_LINK_LABELS[String(s.label || "").toLowerCase()] && /^https?:\/\//i.test(value);
      var body = linkable
        ? '<a href="' + escapeHtml(value) + '" target="_blank" rel="noopener noreferrer nofollow">' + escapeHtml(value) + '</a>'
        : escapeHtml(value);
      return '<div class="profile-social"><span class="social-label">' + escapeHtml(s.label) + '</span> ' + body + '</div>';
    }).join("") + '</div>';
  }
  function renderOwnProfileDetails() {
    var p = (state.me && state.me.profile) || {};
    var parts =
      (p.bio ? '<p class="profile-bio">' + escapeHtml(p.bio) + '</p>' : "") +
      (p.location ? '<div class="profile-location">' + escapeHtml(p.location) + '</div>' : "") +
      renderSocialLinks(p.socials);
    if (!parts) return '<div class="view-copy">No profile yet &mdash; set one with <code>edge-book profile set --name &hellip; --bio &hellip; --social &hellip;</code></div>';
    return parts;
  }
```

In `src/reader-script-app.ts` profile view (~line 31), insert `renderOwnProfileDetails() +` immediately after the closing `</div></div>` of `profile-head` (i.e. between the head block and the `trustStrip([...])` call — the strip itself is removed in Task 8).

In `src/reader-styles-sections.ts` add:

```css
.profile-bio { margin: 0; font-size: 14px; line-height: 1.5; }
.profile-location { font-size: 13px; color: var(--muted, #6b6460); }
.profile-socials { display: grid; gap: 4px; }
.profile-social { font-size: 13px; }
.profile-social .social-label { font-weight: 600; margin-right: 6px; text-transform: capitalize; }
```

(Match the existing variable names in that file — check what the muted-text token is actually called and use it.)

- [ ] **Step 4: Run tests** — `npx tsx --test test/reader-profile.test.ts test/reader-script-syntax.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(098): render owner bio/location/socials in Profile view with safe links + empty state"`

### Task 7: Contact detail renders peer `friend_profile` bio/socials

**Files:**
- Modify: `src/reader-script-app.ts` (People view contact item, ~lines 110–125)
- Test: `test/reader-profile.test.ts` (append)

- [ ] **Step 1: Write failing test:**

```ts
test("contact rows render the peer's shared friend_profile bio and socials", () => {
  assert.match(html, /contact\.friend_profile\.bio/);
  assert.match(html, /renderSocialLinks\(contact\.friend_profile\.socials\)/);
});
```

- [ ] **Step 2: Run to verify failure** — `npx tsx --test test/reader-profile.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in the People view's contact `item(...)` construction, extend the body/detail string so that when `contact.friend_profile` exists its `bio` (escaped) and `renderSocialLinks(contact.friend_profile.socials)` are appended to the contact's detail content:

```js
        var fp = contact.friend_profile || {};
        var fpDetail = (fp.bio ? '<p class="profile-bio">' + escapeHtml(contact.friend_profile.bio) + '</p>' : "") +
          (fp.socials ? renderSocialLinks(contact.friend_profile.socials) : "");
```

and concatenate `fpDetail` into the item body (list row stays compact: name + locator; bio/socials go in the expanded/detail portion the existing `item()` payload supports — follow how `advertised_capabilities` detail is attached and attach the same way). Fields the peer didn't share are simply absent — render nothing.

- [ ] **Step 4: Run tests** — profile + syntax tests PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(098): contact detail renders peer friend_profile bio + socials"`

### Task 8: Remove the profile-panel "data boxes" (trustStrip stats)

**Files:**
- Modify: `src/reader-script-app.ts` (~lines 32–37)
- Test: `test/reader-profile.test.ts` (append)

- [ ] **Step 1: Write failing test:**

```ts
test("profile panel no longer renders the session/friends/approvals/events stat boxes", () => {
  assert.doesNotMatch(html, /\["session", "hosted active"\]/);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (the strip is present).

- [ ] **Step 3: Implement** — in `src/reader-script-app.ts` delete the entire `trustStrip([...])` call inside the profile view:

```js
        trustStrip([
          ["session", "hosted active"],
          ["friends", friendContacts().length],
          ["pending approvals", pendingApprovals().length],
          ["activity events", state.audit.length]
        ]) +
```

Keep the `trustStrip` helper itself — it's used by `item()` for per-post trust rows. Keep (or drop, taste call at review) the "Endpoint and key material…" view-copy line.

- [ ] **Step 4: Run FULL host suite** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "fix(098): remove stat data boxes from profile card (calm surface)"`

### Task 9: Merge + deploy + live verification

- [ ] **Step 1:** Open PRs per repo convention (`gh pr create`), merge both branches to main. Host main auto-deploys to Fly (`.github/workflows/deploy.yml`).
- [ ] **Step 2:** Upgrade the agent on Hermes to edge-book@0.12.4 (`npm i -g edge-book@0.12.4` + restart the agent's edge-book serve process). If this machine has no direct Hermes access, send the upgrade request to OpenClaw via `notify_antony.py --use-bot --force --mention openclaw --agent claude --runtime local-wsl` to #agent-ops (per the established Slack handoff).
- [ ] **Step 3:** Verify on Hermes (or via reader): `edge-book profile show` confirms `profile.name = "Antony Evans"` is actually set; if not, run `edge-book profile set --name "Antony Evans" --bio "..." --social github=...` once — it now works end-to-end.
- [ ] **Step 4:** Live check in the hosted Sanctum reader (browse skill or manual): Profile view shows **Antony Evans**, bio, social links (with `rel="noopener noreferrer nofollow"`), **no stat boxes**; People list shows friend names where shared.
- [ ] **Step 5:** Close out `ea-claude-110` (status: done, move to `tasks/archive/`) and check off spec-098 acceptance criteria in the task file.

---

## Acceptance (from spec-098)

1. `profile set --name "Antony Evans"` alone → name renders in Profile view + as owner label everywhere.
2. `--bio` and `--social github=<url>` render; github is a safe external link.
3. Friend's shared bio/socials show in contact detail; name-only friend shows just the name.
4. Fresh identity renders the empty state, no errors.
5. Legacy `--owner`/`--agent-name` still work but are no longer required.
6. Friend's `--name` shows in your reader by default; public invite card stays name-free (untouched — `buildCard` path not modified).
7. No-name user renders as their handle, never `"OpenClaw Agent"`.
8. (This plan, additional) Profile card no longer shows the session/friends/approvals/events data boxes.
