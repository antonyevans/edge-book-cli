# Friend Profiles — Core Model + Exchange Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give edge-book agents a two-tier profile — a minimal public card plus a richer, per-field-permissioned `FriendProfile` that confirmed friends exchange automatically, defaulting on with opt-out.

**Architecture:** Profile data lives on `LocalIdentity.profile` with a per-field visibility enum (`friends` default / `public` / `off`). A pure resolver decides which fields ride the public `AgentCard` (`public`) vs the signed `FriendProfile` (`friends`+`public`). Friendship triggers a two-step exchange: the accepter attaches its `FriendProfile` to the `friend_response`; the requester, on applying that response, sends its own `FriendProfile` back in a new signed `profile_share` envelope. Later edits re-broadcast `profile_share` to current friends. Everything is ed25519-signed and verified on receipt, reusing the existing envelope/grant machinery.

**Tech Stack:** TypeScript (ESM, target node20), Node's built-in `node:test` runner (`node --test`), `tsup` build. No new dependencies. Source: `src/edge-book.ts` (store + types), `src/cli.ts` (CLI), `src/dialout.ts` (mailbox auto-apply). Tests: `test/*.test.ts` run via `node --test test/<file>.test.ts`.

**Scope of THIS plan:** Spec sections A (two-tier profile), B (schema + per-field permissioning + migration), and the protocol parts of the design. Out of scope (separate plans): `friend pending` CLI + Hermes notification cron (Plan B), reader `friend_accept` approval wiring (Plan C), OpenClaw skill bundle (Plan D).

**Spec:** `docs/superpowers/specs/2026-06-08-friend-profiles-and-notifications-design.md`

**Conventions already in this codebase (do not reinvent):**
- Sign any payload: `signPayload(withoutSignature(obj), identity.private_key_pem)`; verify: `verifyPayload(withoutSignature(obj), sig, publicKeyPem)`. Both canonicalize (key-sorted JSON) internally.
- IDs: `randomId("prefix")`. Timestamps: `now()` (ISO string).
- Persisted JSON via `writeJson(file, value[, mode])` (atomic) and `readJson(file, fallback)`.
- `EdgeBookError(code, message)` for all throws.
- Tests construct stores in temp dirs: `new EdgeBookStore({ home: path.join(root, "alice") })` then `await store.init({...})`. See `test/edge-book.test.ts` for the pattern.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/edge-book.ts` | Types, `EdgeBookStore`, pure helpers | Add profile types, visibility resolver, `buildFriendProfile`, modify `buildCard`/`setProfile`/`acceptFriend`/`applyFriendResponse`/`upsertContactFromCard`/`receiveEnvelope`/`verifyEnvelope`, add `receiveProfileShare`/`broadcastProfile`/`validateFriendProfile`/`verifyFriendProfileSignature` |
| `src/cli.ts` | CLI command surface | Extend `profile` command (set/show/visibility/broadcast); deliver follow-up `profile_share` in `friend apply-response` |
| `src/dialout.ts` | Mailbox auto-apply | Deliver the follow-up `profile_share` returned by `receiveEnvelope` for a `friend_response` |
| `test/profile-visibility.test.ts` | NEW — pure resolver + build unit tests | create |
| `test/profile-exchange.test.ts` | NEW — two-agent exchange + security tests | create |
| `test/profile-cli.test.ts` | NEW — CLI behavior | create |

---

## PHASE 1 — Profile model, visibility, migration

### Task 1: Profile + visibility types

**Files:**
- Modify: `src/edge-book.ts` (after the `LocalIdentity` interface, lines 26-39)

- [ ] **Step 1: Add the new types**

Insert immediately AFTER the closing `}` of `LocalIdentity` (currently line 39) and BEFORE `export interface AgentCard`:

```typescript
export type FieldVisibility = "friends" | "public" | "off";

export interface SocialLink {
  label: string; // open vocabulary: telegram | twitter | linkedin | facebook | github | website | ...
  value: string; // handle or URL
}

export interface IdentityProfile {
  name?: string;
  bio?: string;
  location?: string;
  socials?: SocialLink[];
  // Per-field visibility. Field keys: "name" | "bio" | "location" and per-social
  // by its label, plus "*" as the socials default. Absent => "friends".
  // Reserved field names (name/bio/location) must not be used as social labels.
  visibility?: Record<string, FieldVisibility>;
  // Bumped on every edit; receivers apply the newest profile (last-writer-wins).
  profile_version?: number;
}

// A friend-only, separately-signed profile payload. Shared only between confirmed
// friends (never on the public card / friend_request).
export interface FriendProfile {
  schema: "openclaw-friend-profile/0.1";
  agent_id: string; // MUST equal the sharer's card agent_id
  profile_version: number;
  name?: string;
  bio?: string;
  location?: string;
  socials?: SocialLink[];
  issued_at: string;
  signature: string; // ed25519 over withoutSignature(profile)
}
```

Then extend `LocalIdentity` — add this field before `public_key_pem` (line 35):

```typescript
  // Two-tier profile. Absent on legacy identities (migrated on read via
  // defaultProfile()). owner_label/share_owner_label remain for migration only.
  profile?: IdentityProfile;
```

- [ ] **Step 2: Extend AgentCard for public profile fields**

In `AgentCard` (lines 41-61), add after the `owner_label?` field (line 48):

```typescript
  // Profile fields the owner promoted to public visibility (rides the card).
  // name is ALSO mirrored to owner_label above for back-compat with older readers.
  public_profile?: { name?: string; bio?: string; location?: string; socials?: SocialLink[] };
```

- [ ] **Step 3: Extend AgentContactRecord to hold a received friend profile**

In `AgentContactRecord` (lines 63-83), add after `owner_label?` (line 68):

```typescript
  // The latest FriendProfile this peer shared with us (only present once friends).
  friend_profile?: FriendProfile;
```

- [ ] **Step 4: Build to typecheck**

Run: `cd /home/antony/claude/edge-book-cli && npx tsc --noEmit`
Expected: PASS (no errors). New optional fields don't break existing code.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts
git commit -m "feat(profile): add FriendProfile + IdentityProfile + visibility types"
```

---

### Task 2: Pure visibility resolver + migration helper

**Files:**
- Modify: `src/edge-book.ts` (add module-level functions near other helpers, after `relationshipId` at line 518)
- Test: `test/profile-visibility.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/profile-visibility.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultProfile,
  resolveFieldVisibility,
  resolveSocialVisibility,
  type LocalIdentity,
} from "../src/edge-book.ts";

function identity(over: Partial<LocalIdentity> = {}): LocalIdentity {
  return {
    agent_id: "did:openclaw:test",
    handle: "a.openclaw.local",
    display_name: "Agent A",
    owner_label: "",
    public_key_pem: "PUB",
    private_key_pem: "PRIV",
    created_at: "t",
    updated_at: "t",
    ...over,
  };
}

test("defaultProfile derives from legacy owner_label with share off => name friends", () => {
  const p = defaultProfile(identity({ owner_label: "Alice", share_owner_label: false }));
  assert.equal(p.name, "Alice");
  assert.equal(resolveFieldVisibility(p, "name"), "friends");
});

test("defaultProfile derives from legacy share_owner_label true => name public", () => {
  const p = defaultProfile(identity({ owner_label: "Alice", share_owner_label: true }));
  assert.equal(resolveFieldVisibility(p, "name"), "public");
});

test("explicit identity.profile wins over legacy fields", () => {
  const p = defaultProfile(identity({
    owner_label: "Legacy",
    profile: { name: "Real", visibility: { name: "off" }, profile_version: 3 },
  }));
  assert.equal(p.name, "Real");
  assert.equal(resolveFieldVisibility(p, "name"), "off");
  assert.equal(p.profile_version, 3);
});

test("unset field visibility defaults to friends", () => {
  const p = defaultProfile(identity());
  assert.equal(resolveFieldVisibility(p, "bio"), "friends");
});

test("social visibility falls back label -> '*' -> friends", () => {
  const p: ReturnType<typeof defaultProfile> = { visibility: { telegram: "off", "*": "public" } };
  assert.equal(resolveSocialVisibility(p, "telegram"), "off");
  assert.equal(resolveSocialVisibility(p, "twitter"), "public");
  const p2 = { visibility: {} };
  assert.equal(resolveSocialVisibility(p2, "twitter"), "friends");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-visibility.test.ts`
Expected: FAIL — `defaultProfile`/`resolveFieldVisibility`/`resolveSocialVisibility` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/edge-book.ts`, after `relationshipId` (ends line 518), add:

```typescript
// Resolve the effective profile for an identity, migrating legacy
// owner_label/share_owner_label when identity.profile is absent. Pure: callers
// persist the result via setProfile when the user next edits (no write-on-read).
export function defaultProfile(identity: LocalIdentity): IdentityProfile {
  if (identity.profile) return identity.profile;
  const visibility: Record<string, FieldVisibility> = {
    // Migration (apply-new-default-to-all): legacy share on => name public;
    // legacy share off/absent => name resolves to the new default "friends".
    name: identity.share_owner_label ? "public" : "friends",
  };
  return {
    name: identity.owner_label || undefined,
    visibility,
    profile_version: 1,
  };
}

export function resolveFieldVisibility(profile: IdentityProfile, field: string): FieldVisibility {
  return profile.visibility?.[field] ?? "friends";
}

export function resolveSocialVisibility(profile: IdentityProfile, label: string): FieldVisibility {
  return profile.visibility?.[label] ?? profile.visibility?.["*"] ?? "friends";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/profile-visibility.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/profile-visibility.test.ts
git commit -m "feat(profile): pure visibility resolver + legacy migration helper"
```

---

### Task 3: buildFriendProfile + validateFriendProfile

**Files:**
- Modify: `src/edge-book.ts` (add method to `EdgeBookStore` after `buildCard`/`writeCard`, ~line 644; add module function near `validateCard` ~line 2202)
- Test: `test/profile-visibility.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/profile-visibility.test.ts`:

Add these imports at the TOP of the file (alongside the existing imports from Task 2), then append the test:

```typescript
import { EdgeBookStore, validateFriendProfile } from "../src/edge-book.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

async function freshStore(): Promise<EdgeBookStore> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-prof-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "a.openclaw.local", displayName: "Agent A" });
  return store;
}

test("buildFriendProfile includes friends+public, excludes off, and verifies", async () => {
  const store = await freshStore();
  await store.setProfile({
    name: "Alice",
    bio: "Builder",
    location: "Healdsburg",
    socials: [{ label: "telegram", value: "@alice" }, { label: "twitter", value: "alice" }],
    visibility: { bio: "off", twitter: "off", location: "public" },
  });
  const fp = await store.buildFriendProfile();
  assert.equal(fp.name, "Alice");            // default friends
  assert.equal(fp.location, "Healdsburg");   // public => also in friend profile
  assert.equal(fp.bio, undefined);           // off
  assert.deepEqual(fp.socials, [{ label: "telegram", value: "@alice" }]); // twitter off
  assert.equal(fp.schema, "openclaw-friend-profile/0.1");
  // Signature verifies against the store's own public key.
  const id = await store.identity();
  assert.doesNotThrow(() => validateFriendProfile(fp, id.public_key_pem));
});
```

(If `os`/`path`/`fs` are already imported at the top from Task 2's edits, don't duplicate them — keep one import each.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-visibility.test.ts`
Expected: FAIL — `store.buildFriendProfile` is not a function / `validateFriendProfile` not exported.

- [ ] **Step 3: Implement buildFriendProfile (store method)**

In `src/edge-book.ts`, inside `EdgeBookStore`, immediately after `writeCard` (ends line 644), add:

```typescript
  // The friend-only profile: every field whose visibility resolves to "friends"
  // or "public". Signed; shared only with confirmed friends.
  async buildFriendProfile(): Promise<FriendProfile> {
    const identity = await this.identity();
    const profile = defaultProfile(identity);
    const include = (field: string): boolean => resolveFieldVisibility(profile, field) !== "off";
    const socials = (profile.socials ?? []).filter(
      (s) => resolveSocialVisibility(profile, s.label) !== "off",
    );
    const unsigned: Omit<FriendProfile, "signature"> = {
      schema: "openclaw-friend-profile/0.1",
      agent_id: identity.agent_id,
      profile_version: profile.profile_version ?? 1,
      ...(profile.name && include("name") ? { name: profile.name } : {}),
      ...(profile.bio && include("bio") ? { bio: profile.bio } : {}),
      ...(profile.location && include("location") ? { location: profile.location } : {}),
      ...(socials.length ? { socials } : {}),
      issued_at: now(),
    };
    return { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  }
```

- [ ] **Step 4: Implement validateFriendProfile + verifyFriendProfileSignature**

Add a module-level function right after `validateCard` (ends line 2202):

```typescript
// Structural + signature validation against a known public key (the peer's card
// key). Throws EdgeBookError on any failure. The agent_id<->sender match is
// checked by the caller (it has the envelope's from_agent_id).
export function validateFriendProfile(profile: FriendProfile, publicKeyPem: string): void {
  if (profile.schema !== "openclaw-friend-profile/0.1") {
    throw new EdgeBookError("invalid_friend_profile", "Unsupported FriendProfile schema");
  }
  if (!profile.agent_id) throw new EdgeBookError("invalid_friend_profile", "FriendProfile missing agent_id");
  if (typeof profile.profile_version !== "number") {
    throw new EdgeBookError("invalid_friend_profile", "FriendProfile missing profile_version");
  }
  if (!verifyPayload(withoutSignature(profile), profile.signature, publicKeyPem)) {
    throw new EdgeBookError("invalid_friend_profile", "FriendProfile signature is invalid");
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/profile-visibility.test.ts`
Expected: PASS (this requires Task 5's `setProfile` extension — if `setProfile` does not yet accept name/bio/etc., do Task 5 first, then return here). NOTE: implement Task 5 before running this test.

- [ ] **Step 6: Commit**

```bash
git add src/edge-book.ts test/profile-visibility.test.ts
git commit -m "feat(profile): buildFriendProfile + validateFriendProfile"
```

---

### Task 4: buildCard emits only public-visibility profile fields

**Files:**
- Modify: `src/edge-book.ts` `buildCard` (lines 611-638)
- Test: `test/profile-visibility.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test("buildCard exposes only public fields; friends-only stay off the card", async () => {
  const store = await freshStore();
  await store.setProfile({
    name: "Alice",
    bio: "Builder",
    location: "Healdsburg",
    socials: [{ label: "telegram", value: "@alice" }],
    visibility: { name: "public", bio: "friends", location: "public", telegram: "friends" },
  });
  const card = await store.buildCard();
  assert.equal(card.owner_label, "Alice");                 // public name mirrors owner_label
  assert.equal(card.public_profile?.name, "Alice");
  assert.equal(card.public_profile?.location, "Healdsburg");
  assert.equal(card.public_profile?.bio, undefined);       // friends-only
  assert.equal(card.public_profile?.socials, undefined);   // telegram friends-only
});

test("default profile keeps name off the public card (friends-only default)", async () => {
  const store = await freshStore();
  await store.setProfile({ name: "Alice" }); // all defaults => friends
  const card = await store.buildCard();
  assert.equal(card.owner_label, undefined);
  assert.equal(card.public_profile, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-visibility.test.ts`
Expected: FAIL — `buildCard` still uses old `owner_label` logic; `public_profile` undefined / `owner_label` wrong.

- [ ] **Step 3: Modify buildCard**

Replace the `unsigned` object construction in `buildCard` (lines 619-634). Specifically replace the single line:

```typescript
      ...(identity.share_owner_label && identity.owner_label ? { owner_label: identity.owner_label } : {}),
```

with a computed public-profile block. Insert BEFORE `const unsigned` (line 619):

```typescript
    const prof = defaultProfile(identity);
    const pubInclude = (field: string) => resolveFieldVisibility(prof, field) === "public";
    const pubSocials = (prof.socials ?? []).filter((s) => resolveSocialVisibility(prof, s.label) === "public");
    const publicProfile: NonNullable<AgentCard["public_profile"]> = {
      ...(prof.name && pubInclude("name") ? { name: prof.name } : {}),
      ...(prof.bio && pubInclude("bio") ? { bio: prof.bio } : {}),
      ...(prof.location && pubInclude("location") ? { location: prof.location } : {}),
      ...(pubSocials.length ? { socials: pubSocials } : {}),
    };
    const publicName = prof.name && pubInclude("name") ? prof.name : undefined;
```

Then in the `unsigned` object, replace the old owner_label spread line with:

```typescript
      ...(publicName ? { owner_label: publicName } : {}),
      ...(Object.keys(publicProfile).length ? { public_profile: publicProfile } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/profile-visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/profile-visibility.test.ts
git commit -m "feat(profile): buildCard emits only public-visibility profile fields"
```

---

### Task 5: setProfile accepts profile fields + visibility + version bump

**Files:**
- Modify: `src/edge-book.ts` `setProfile` (lines 586-596)
- Test: `test/profile-visibility.test.ts` (append)

> Do this task BEFORE running Task 3 Step 5 / Task 4 (they depend on it).

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test("setProfile sets fields, merges visibility, and bumps profile_version", async () => {
  const store = await freshStore();
  const a = await store.setProfile({ name: "Alice", bio: "Builder" });
  assert.equal(a.profile?.name, "Alice");
  assert.equal(a.profile?.bio, "Builder");
  assert.equal(a.profile?.profile_version, 2); // migrated default was 1, bumped to 2
  const b = await store.setProfile({ visibility: { bio: "off" } });
  assert.equal(b.profile?.visibility?.bio, "off");
  assert.equal(b.profile?.name, "Alice"); // preserved
  assert.equal(b.profile?.profile_version, 3);
});

test("setProfile still supports legacy displayName/ownerLabel/shareOwnerLabel", async () => {
  const store = await freshStore();
  const id = await store.setProfile({ displayName: "Agent X", ownerLabel: "Xan", shareOwnerLabel: true });
  assert.equal(id.display_name, "Agent X");
  // owner -> profile.name, share true -> name public
  assert.equal(id.profile?.name, "Xan");
  assert.equal(id.profile?.visibility?.name, "public");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-visibility.test.ts`
Expected: FAIL — `setProfile` does not accept `name/bio/location/socials/visibility`.

- [ ] **Step 3: Rewrite setProfile**

Replace the entire `setProfile` method (lines 586-596) with:

```typescript
  // Update profile fields on an existing identity without rotating keys, so the
  // agent_id survives. display_name is the agent's own name (public, on the card).
  // name/bio/location/socials are the human profile, governed by per-field
  // visibility (default "friends"). Legacy ownerLabel/shareOwnerLabel map onto
  // profile.name + visibility.name for back-compat.
  async setProfile(input: {
    displayName?: string;
    ownerLabel?: string;
    shareOwnerLabel?: boolean;
    name?: string;
    bio?: string;
    location?: string;
    socials?: SocialLink[];
    visibility?: Record<string, FieldVisibility>;
  }): Promise<LocalIdentity> {
    const identity = await this.identity();
    const profile: IdentityProfile = { ...defaultProfile(identity) };
    profile.visibility = { ...(profile.visibility ?? {}) };

    if (input.displayName !== undefined && input.displayName !== "") identity.display_name = input.displayName;

    // Legacy shims: ownerLabel -> profile.name; shareOwnerLabel -> name visibility.
    if (input.ownerLabel !== undefined) {
      identity.owner_label = input.ownerLabel;
      profile.name = input.ownerLabel || undefined;
    }
    if (input.shareOwnerLabel !== undefined) {
      identity.share_owner_label = input.shareOwnerLabel;
      profile.visibility.name = input.shareOwnerLabel ? "public" : "friends";
    }

    if (input.name !== undefined) profile.name = input.name || undefined;
    if (input.bio !== undefined) profile.bio = input.bio || undefined;
    if (input.location !== undefined) profile.location = input.location || undefined;
    if (input.socials !== undefined) profile.socials = input.socials;
    if (input.visibility) profile.visibility = { ...profile.visibility, ...input.visibility };

    profile.profile_version = (profile.profile_version ?? 1) + 1;
    identity.profile = profile;
    identity.updated_at = now();
    await writeJson(this.file(IDENTITY_FILE), identity, 0o600);
    await this.writeCard();
    await this.audit("identity.update", identity.agent_id, { display_name: identity.display_name, profile_version: profile.profile_version });
    return identity;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/profile-visibility.test.ts`
Expected: PASS — all profile-visibility tests (Tasks 2-5) green.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/profile-visibility.test.ts
git commit -m "feat(profile): setProfile accepts profile fields + visibility + version bump"
```

---

### Task 6: CLI — `profile set/show/visibility`

**Files:**
- Modify: `src/cli.ts` `profile` command (lines 186-214)
- Test: `test/profile-cli.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/profile-cli.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { handleCli } from "../src/cli.ts";

async function home(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-cli-"));
}

test("profile set --bio --social and visibility round-trips via show", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h }); // init --name = agent display_name (unchanged)
  await handleCli(["profile", "set", "--name", "Alice", "--bio", "Builder", "--social", "telegram=@alice"], { home: h }); // profile set --name = human name
  await handleCli(["profile", "visibility", "bio=off", "telegram=public"], { home: h });
  const res = await handleCli(["profile", "show"], { home: h });
  const j = res.json as any;
  assert.equal(j.display_name, "Agent A");
  assert.equal(j.name, "Alice");
  assert.equal(j.visibility.bio, "off");
  assert.equal(j.visibility.telegram, "public");
  assert.deepEqual(j.socials, [{ label: "telegram", value: "@alice" }]);
});
```

Flag scheme (locked): the testable CLI entry point is `handleCli(args: string[], ctx: CliContext): Promise<CliResult>` (exported from `src/cli.ts`); `home` is passed as `ctx.home`, result is `{ text, json }`. `init --name` keeps meaning agent `display_name` (unchanged, `src/cli.ts:170`). In `profile set`, `--name` means the **human profile name** (repurposed from its old display_name meaning — Task 7 updates the `onboarding-names` test for this), and `--agent-name` optionally changes `display_name`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-cli.test.ts`
Expected: FAIL — `profile visibility` is an unknown action; `show` json lacks `name`/`socials`/`visibility`.

- [ ] **Step 3: Add a repeatable `--social` flag reader**

First check whether `src/cli.ts` already has a multi-value flag reader. If not, add a small helper near `takeFlag` (around line 86):

```typescript
// Collect every `--social label=value` occurrence (repeatable), removing them.
function takeRepeatedKV(args: string[], flag: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  let idx: number;
  while ((idx = args.indexOf(flag)) !== -1) {
    const raw = args[idx + 1] ?? "";
    args.splice(idx, 2);
    const eq = raw.indexOf("=");
    if (eq === -1) throw new EdgeBookError("bad_social", `--social expects label=value, got "${raw}"`);
    out.push({ label: raw.slice(0, eq), value: raw.slice(eq + 1) });
  }
  return out;
}
```

- [ ] **Step 4: Rewrite the `profile` command block**

Replace the whole `if (command === "profile") { ... }` block (lines 186-214) with:

```typescript
  if (command === "profile") {
    const action = args.shift() || "show";
    if (action === "show") {
      const id = await store.identity();
      const p = defaultProfile(id);
      return {
        text:
          `display_name: ${id.display_name}\n` +
          `name: ${p.name || "(unset)"}\n` +
          `bio: ${p.bio || "(unset)"}\n` +
          `location: ${p.location || "(unset)"}\n` +
          `socials: ${(p.socials ?? []).map((s) => `${s.label}=${s.value}`).join(", ") || "(none)"}\n` +
          `visibility: ${JSON.stringify(p.visibility ?? {})}`,
        json: { agent_id: id.agent_id, display_name: id.display_name, name: p.name, bio: p.bio, location: p.location, socials: p.socials ?? [], visibility: p.visibility ?? {} },
      };
    }
    if (action === "set") {
      const displayName = takeFlag(args, "--agent-name");
      const name = takeFlag(args, "--name");
      const bio = takeFlag(args, "--bio");
      const location = takeFlag(args, "--location");
      const socialsKV = takeRepeatedKV(args, "--social");
      // Legacy aliases kept working.
      const ownerLabel = takeFlag(args, "--owner");
      const shareOwner = takeBoolFlag(args, "--share-owner");
      const noShareOwner = takeBoolFlag(args, "--no-share-owner");
      const shareOwnerLabel = shareOwner ? true : (noShareOwner ? false : undefined);
      const id = await store.setProfile({
        displayName,
        name,
        bio,
        location,
        socials: socialsKV.length ? socialsKV : undefined,
        ownerLabel,
        shareOwnerLabel,
      });
      const p = defaultProfile(id);
      return { text: `Updated profile (v${p.profile_version}): name=${p.name || "(unset)"}`, json: { agent_id: id.agent_id, name: p.name, profile_version: p.profile_version } };
    }
    if (action === "visibility") {
      const pairs = args.splice(0).map((tok) => {
        const eq = tok.indexOf("=");
        if (eq === -1) throw new EdgeBookError("bad_visibility", `expected field=friends|public|off, got "${tok}"`);
        const field = tok.slice(0, eq);
        const vis = tok.slice(eq + 1) as FieldVisibility;
        if (!["friends", "public", "off"].includes(vis)) throw new EdgeBookError("bad_visibility", `bad visibility "${vis}" for ${field}`);
        return [field, vis] as const;
      });
      if (!pairs.length) throw new EdgeBookError("missing_arg", "profile visibility needs at least one field=friends|public|off");
      const id = await store.setProfile({ visibility: Object.fromEntries(pairs) });
      const p = defaultProfile(id);
      return { text: `Updated visibility: ${JSON.stringify(p.visibility ?? {})}`, json: { visibility: p.visibility ?? {} } };
    }
    throw new EdgeBookError("unknown_action", `Unknown profile action: ${action} (use "show", "set", or "visibility")`);
  }
```

Note: in `profile set`, `--name` now means the human profile name and `--agent-name` changes the agent display_name. The `init` command still uses `--name` for display_name (unchanged). This is the locked flag scheme from Task 6 Step 1.

- [ ] **Step 5: Ensure imports**

At the top of `src/cli.ts`, confirm `defaultProfile`, `FieldVisibility`, and `SocialLink` are imported from `./edge-book.ts`. Add them to the existing import list if missing.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/profile-cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/profile-cli.test.ts
git commit -m "feat(profile): CLI profile set/show/visibility with socials"
```

---

### Task 7: Reconcile `init` help + keep legacy `profile show` consumers

**Files:**
- Modify: `src/cli.ts` `init` note (lines 176-183), `usage()` text

- [ ] **Step 1: Update the init note**

In the `init` command, replace the `note` string (lines 176-182) so it documents the new model without lying about flags. Use:

```typescript
    const note =
      `Initialized ${identity.agent_id} at ${store.home}\n\n` +
      `Two-tier profile:\n` +
      `  • agent name (display_name): "${identity.display_name}" — always public on your card.\n` +
      `  • your profile (name, bio, location, socials): default visible to FRIENDS only, hidden on the public card.\n` +
      `Set it: edge-book profile set --name "<you>" --bio "..." --social telegram=@you\n` +
      `Tune visibility: edge-book profile visibility bio=off telegram=public name=public`;
```

- [ ] **Step 2: Update usage() text**

Find `function usage()` in `src/cli.ts` and add lines documenting `profile set`/`profile visibility` (match the existing formatting of other commands). Add under the profile entry:

```
  profile show
  profile set [--name <you>] [--bio <text>] [--location <text>] [--social label=value ...]
  profile visibility <field>=friends|public|off ...
```

- [ ] **Step 3: Build + full test sweep**

Run: `npx tsc --noEmit && node --test test/profile-visibility.test.ts test/profile-cli.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the existing suite to catch regressions (onboarding-names depends on old profile output)**

Run: `node --test test/onboarding-names.test.ts`
Expected: It may FAIL because `profile show`/`profile set` output changed. If so, read `test/onboarding-names.test.ts`, update its assertions to the new `profile show` JSON/text shape (the human name now lives at `json.name` with `visibility.name`, not `json.owner_label`/`json.share_owner_label`). Keep the test's intent (agent-name vs human-name separation) intact. Commit the test update together with this task.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/onboarding-names.test.ts
git commit -m "feat(profile): reconcile init/usage help + onboarding-names test for two-tier profile"
```

---

## PHASE 2 — Exchange protocol

### Task 8: profile_share envelope type + bodies + grant scope constant

**Files:**
- Modify: `src/edge-book.ts` (`MessageEnvelope.type` line 246; add `ProfileShareBody`; extend `FriendResponseBody` line 264-269)

- [ ] **Step 1: Extend the envelope union**

In `MessageEnvelope.type` (line 246), add `"profile_share"`:

```typescript
  type: "friend_request" | "friend_response" | "privileged_message" | "ack" | "error" | "object_share" | "object_revoke" | "post_publish" | "profile_share";
```

- [ ] **Step 2: Add ProfileShareBody and extend FriendResponseBody**

After `FriendResponseBody` (lines 264-269), add:

```typescript
export interface ProfileShareBody {
  profile: FriendProfile;
}
```

And add `profile` to `FriendResponseBody`:

```typescript
export interface FriendResponseBody {
  accepted: boolean;
  card: AgentCard;
  grant?: CapabilityGrant;
  profile?: FriendProfile; // accepter's friend profile (only when accepted)
  reason: string;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/edge-book.ts
git commit -m "feat(profile): profile_share envelope type + ProfileShareBody + FriendResponseBody.profile"
```

---

### Task 9: acceptFriend issues profile.read.friend + attaches FriendProfile

**Files:**
- Modify: `src/edge-book.ts` `acceptFriend` (lines 799-817)
- Test: `test/profile-exchange.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/profile-exchange.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody } from "../src/edge-book.ts";

async function twoAgents() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-x-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  await alice.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.setProfile({ name: "Bob", bio: "Bob bio" });
  return { alice, bob };
}

test("acceptFriend attaches the accepter's friend profile and a profile.read.friend grant", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const body = accept.body as unknown as FriendResponseBody;
  assert.equal(body.profile?.name, "Bob");
  assert.ok(body.grant?.scopes.includes("profile.read.friend"));
  assert.ok(body.grant?.scopes.includes("message.friend"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-exchange.test.ts`
Expected: FAIL — grant lacks `profile.read.friend`; `body.profile` undefined.

- [ ] **Step 3: Modify acceptFriend**

In `acceptFriend` (lines 805-816), change the grant scopes and add the profile to the body. Replace:

```typescript
    const grant = await this.issueGrant(peerAgentId, ["message.friend", "feed.read.friends"]);
    const card = await this.writeCard();
    return this.signEnvelope({
      type: "friend_response",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: grant.grant_id,
      ref: "",
      transport: "local",
      body: { accepted: true, card, grant, reason } satisfies FriendResponseBody
    });
```

with:

```typescript
    const grant = await this.issueGrant(peerAgentId, ["message.friend", "feed.read.friends", "profile.read.friend"]);
    const card = await this.writeCard();
    const profile = await this.buildFriendProfile();
    return this.signEnvelope({
      type: "friend_response",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: grant.grant_id,
      ref: "",
      transport: "local",
      body: { accepted: true, card, grant, profile, reason } satisfies FriendResponseBody
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/profile-exchange.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edge-book.ts test/profile-exchange.test.ts
git commit -m "feat(profile): acceptFriend issues profile.read.friend + ships accepter profile"
```

---

### Task 10: receiveProfileShare + store received profile + carry-over on card refresh

**Files:**
- Modify: `src/edge-book.ts` — add `receiveProfileShare` method; modify `upsertContactFromCard` (carry `friend_profile`); add a private `storeFriendProfile` helper
- Test: `test/profile-exchange.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
import { type MessageEnvelope } from "../src/edge-book.ts";

test("requester stores accepter profile from friend_response", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  await alice.applyFriendResponse(accept);
  const contact = (await alice.contacts())[bobCard.agent_id];
  assert.equal(contact.friend_profile?.name, "Bob");
  assert.equal(contact.friend_profile?.bio, "Bob bio");
});

test("receiveProfileShare stores a newer profile and ignores a stale one", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  // Bob edits his profile and broadcasts a profile_share to Alice.
  await bob.setProfile({ bio: "Bob NEW bio" });
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  await alice.receiveProfileShare(share);
  assert.equal((await alice.contacts())[bobCard.agent_id].friend_profile?.bio, "Bob NEW bio");
  // A replay of an older version must not overwrite (build a stale one by hand is
  // hard; instead re-receive the same share — replay guard rejects it).
  await assert.rejects(() => alice.receiveProfileShare(share), /replay/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-exchange.test.ts`
Expected: FAIL — `applyFriendResponse` doesn't store the profile; `receiveProfileShare`/`buildProfileShareEnvelope` don't exist.

- [ ] **Step 3: Carry friend_profile across card refresh in upsertContactFromCard**

In `upsertContactFromCard` (lines 712-732), add to the `next` record object (after the `owner_label:` line ~718):

```typescript
      // Preserve a previously-received friend profile across card refreshes.
      ...(existing?.friend_profile ? { friend_profile: existing.friend_profile } : {}),
```

- [ ] **Step 4: Add storeFriendProfile + receiveProfileShare + buildProfileShareEnvelope**

After `applyFriendResponse` (ends line 828), add:

```typescript
  // Persist a received FriendProfile onto the peer contact (last-writer-wins by
  // profile_version). Returns true if applied, false if stale.
  private async storeFriendProfile(peerAgentId: string, profile: FriendProfile): Promise<boolean> {
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    const current = contact.friend_profile?.profile_version ?? -1;
    if (profile.profile_version <= current) return false;
    contact.friend_profile = profile;
    contact.updated_at = now();
    contacts[peerAgentId] = contact;
    await this.saveContacts(contacts);
    await this.audit("profile.received", peerAgentId, { profile_version: profile.profile_version });
    return true;
  }

  // Build a signed profile_share envelope carrying our current FriendProfile to a
  // confirmed friend.
  async buildProfileShareEnvelope(peerAgentId: string): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact || contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Not friends with ${peerAgentId}; cannot share profile`);
    }
    const profile = await this.buildFriendProfile();
    return this.signEnvelope({
      type: "profile_share",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: "",
      ref: "",
      transport: "local",
      body: { profile } satisfies ProfileShareBody,
    });
  }

  async receiveProfileShare(envelope: MessageEnvelope): Promise<void> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "profile_share") throw new EdgeBookError("wrong_message_type", "Expected profile_share envelope");
    const contacts = await this.contacts();
    const contact = contacts[envelope.from_agent_id];
    if (!contact || contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", "profile_share from a non-friend");
    }
    const body = envelope.body as unknown as ProfileShareBody;
    if (body.profile.agent_id !== envelope.from_agent_id) {
      throw new EdgeBookError("agent_id_mismatch", "FriendProfile agent_id does not match sender");
    }
    const publicKey = contact.public_keys?.[0]?.public_key_pem;
    if (!publicKey) throw new EdgeBookError("unknown_key", `No key for ${envelope.from_agent_id}`);
    validateFriendProfile(body.profile, publicKey);
    await this.storeFriendProfile(envelope.from_agent_id, body.profile);
  }
```

- [ ] **Step 5: Store the accepter profile in applyFriendResponse**

In `applyFriendResponse` (lines 819-828), after `if (body.grant) await this.storeGrant(body.grant);` (line 827) add:

```typescript
    if (body.accepted && body.profile) {
      const publicKey = body.card.public_keys?.[0]?.public_key_pem;
      if (publicKey && body.profile.agent_id === envelope.from_agent_id) {
        validateFriendProfile(body.profile, publicKey);
        await this.storeFriendProfile(envelope.from_agent_id, body.profile);
      }
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/profile-exchange.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/edge-book.ts test/profile-exchange.test.ts
git commit -m "feat(profile): receiveProfileShare + store accepter profile + version dedup"
```

---

### Task 11: applyFriendResponse returns the requester's follow-up profile_share

**Files:**
- Modify: `src/edge-book.ts` `applyFriendResponse` (signature + return, lines 819-828); `receiveEnvelope` dispatch (lines 1751-1759)
- Test: `test/profile-exchange.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test("applyFriendResponse returns a profile_share the requester must deliver back", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const followUp = await alice.applyFriendResponse(accept);
  assert.ok(followUp, "expected a follow-up envelope");
  assert.equal(followUp!.type, "profile_share");
  assert.equal(followUp!.to_agent_id, bobCard.agent_id);
  // Bob receives Alice's profile.
  await bob.receiveProfileShare(followUp!);
  assert.equal((await bob.contacts())[aliceCard.agent_id].friend_profile?.name, "Alice");
});

test("full loop: both sides hold each other's friend profile; request leaked nothing", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  // The request body is a friend_request with a card ONLY — no friend profile.
  assert.equal((request.body as any).profile, undefined);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const followUp = await alice.applyFriendResponse(accept);
  await bob.receiveProfileShare(followUp!);
  assert.equal((await alice.contacts())[bobCard.agent_id].friend_profile?.name, "Bob");
  assert.equal((await bob.contacts())[aliceCard.agent_id].friend_profile?.name, "Alice");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-exchange.test.ts`
Expected: FAIL — `applyFriendResponse` returns `void`.

- [ ] **Step 3: Change applyFriendResponse to return the follow-up**

Change the method signature (line 819) from `Promise<void>` to `Promise<MessageEnvelope | null>` and add a return at the end. Replace the method body's tail (after the profile-store block from Task 10) so the full method ends:

```typescript
  async applyFriendResponse(envelope: MessageEnvelope): Promise<MessageEnvelope | null> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "friend_response") throw new EdgeBookError("wrong_message_type", "Expected friend_response envelope");
    const body = envelope.body as unknown as FriendResponseBody;
    validateCard(body.card);
    if (body.card.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Friend response card does not match sender");
    await this.upsertContactFromCard(body.card, body.accepted ? "friend" : "rejected");
    await this.setRelationship(envelope.from_agent_id, body.accepted ? "friend" : "rejected", body.accepted ? "Accept" : "Reject", body.reason);
    if (body.grant) await this.storeGrant(body.grant);
    if (body.accepted && body.profile) {
      const publicKey = body.card.public_keys?.[0]?.public_key_pem;
      if (publicKey && body.profile.agent_id === envelope.from_agent_id) {
        validateFriendProfile(body.profile, publicKey);
        await this.storeFriendProfile(envelope.from_agent_id, body.profile);
      }
    }
    // Now that both sides are friends, send our own profile back.
    if (body.accepted) return this.buildProfileShareEnvelope(envelope.from_agent_id);
    return null;
  }
```

- [ ] **Step 4: Add profile_share to receiveEnvelope dispatch (and surface the follow-up)**

In `receiveEnvelope` (lines 1751-1759), update the return type and add the dispatch line. Change the signature line 1751 to:

```typescript
  async receiveEnvelope(envelope: MessageEnvelope): Promise<void | AgentContactRecord | MessageEnvelope | null> {
```

Change the friend_response line (1753) to surface the follow-up:

```typescript
    if (envelope.type === "friend_response") return this.applyFriendResponse(envelope);
```

(That already returns the envelope now.) Add a new line before the final `throw` (line 1758):

```typescript
    if (envelope.type === "profile_share") { await this.receiveProfileShare(envelope); return; }
```

- [ ] **Step 5: Allow profile_share in verifyEnvelope key lookup**

`verifyEnvelope` (lines 1729-1739) already falls back to the contact's stored key for any type. profile_share is only ever from an existing friend (key is in contacts), so no change is needed. Confirm by re-reading lines 1729-1739; if a `profile_share`-specific branch were required it would be here — it is NOT.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/profile-exchange.test.ts`
Expected: PASS.

- [ ] **Step 7: Fix existing callers of applyFriendResponse**

The return-type change may affect callers. Find them:

Run: `grep -rn "applyFriendResponse" src test scripts`
For each caller that used it as `await store.applyFriendResponse(env)` and ignored the result, no change is needed (returning a value is back-compatible). Confirm `src/cli.ts:312` and `runTwoAgentHarness` (line 2245) still typecheck:

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/edge-book.ts test/profile-exchange.test.ts
git commit -m "feat(profile): two-step exchange — applyFriendResponse returns requester profile_share"
```

---

### Task 12: CLI delivers the follow-up profile_share in `friend apply-response`

**Files:**
- Modify: `src/cli.ts` `friend apply-response` (lines 310-314)
- Test: covered by smoke (Task 14); add a focused CLI assertion here

- [ ] **Step 1: Write the failing test**

Append to `test/profile-cli.test.ts`:

```typescript
import { EdgeBookStore } from "../src/edge-book.ts";

test("friend apply-response prints a deliverable profile_share envelope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-ar-"));
  const aliceHome = path.join(root, "alice");
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await handleCli(["init", "--name", "Alice Agent"], { home: aliceHome });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  await handleCli(["profile", "set", "--name", "Alice"], { home: aliceHome });
  await bob.setProfile({ name: "Bob" });

  const alice = new EdgeBookStore({ home: aliceHome });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const acceptPath = path.join(root, "accept.json");
  await fs.writeFile(acceptPath, JSON.stringify(accept), "utf8");

  const res = await handleCli(["friend", "apply-response", acceptPath], { home: aliceHome });
  const j = res.json as any;
  assert.equal(j.type, "profile_share");
  assert.equal(j.to_agent_id, bobCard.agent_id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-cli.test.ts`
Expected: FAIL — `friend apply-response` returns only text, no `json` follow-up envelope.

- [ ] **Step 3: Modify the apply-response handler**

Replace the `if (action === "apply-response")` block (lines 310-314) with:

```typescript
    if (action === "apply-response") {
      const deliver = takeBoolFlag(args, "--deliver");
      const source = requireArg(args.shift(), "envelope-json-path");
      const followUp = await store.applyFriendResponse(await readEnvelope(source));
      if (!followUp) return { text: `Applied friend response from ${path.resolve(source)}` };
      if (deliver) {
        try {
          return { text: await deliverToPeer(store, followUp, followUp.to_agent_id), json: followUp };
        } catch (error) {
          if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
          const hostUrl = parseHost(args, ctx);
          const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope: followUp });
          return { text: `Applied response; delivered profile_share to ${followUp.to_agent_id} over the mailbox (host id ${ack.id})`, json: followUp };
        }
      }
      return { text: `Applied friend response; deliver this profile_share to ${followUp.to_agent_id}`, json: followUp };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/profile-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/profile-cli.test.ts
git commit -m "feat(profile): CLI friend apply-response emits/delivers follow-up profile_share"
```

---

### Task 13: dialout auto-delivers the follow-up profile_share

**Files:**
- Modify: `src/dialout.ts` `handleMailboxDeliver` (the handler that calls `store.receiveEnvelope`)
- Test: `test/profile-exchange.test.ts` (append an integration-style assertion using the dialout handler if it is unit-testable; otherwise assert via Task 16 smoke)

- [ ] **Step 1: Locate the receive path**

Run: `grep -n "receiveEnvelope\|handleMailboxDeliver\|mailbox_deliver\|ack" src/dialout.ts`
Read the handler (≈ lines 409-428 per the design). Identify where it calls `await store.receiveEnvelope(envelope)` and where it acks.

- [ ] **Step 2: Write the failing test**

Append to `test/profile-exchange.test.ts` a test that drives the handler's effect. If `EdgeBookDialoutClient` exposes the handler or a `receiveEnvelope`-plus-deliver seam, use it; otherwise assert the contract at the store level (already covered) and rely on Task 16 smoke for the wire. Concretely add:

```typescript
test("receiveEnvelope surfaces a profile_share follow-up for a friend_response", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const result = await alice.receiveEnvelope(accept);
  assert.ok(result && (result as MessageEnvelope).type === "profile_share");
});
```

- [ ] **Step 3: Run test to verify it fails or passes**

Run: `node --test test/profile-exchange.test.ts`
Expected: PASS already (Task 11 made `receiveEnvelope` return the follow-up for friend_response). This locks the contract dialout relies on.

- [ ] **Step 4: Deliver the follow-up in the dialout handler**

In `src/dialout.ts`, where the handler does `await store.receiveEnvelope(envelope)`, capture the result and deliver it if it is a `profile_share` envelope. Replace:

```typescript
await store.receiveEnvelope(envelope);
```

with (adapt variable names to the actual handler — `this.store`, `this.deliverViaMailbox`, etc.):

```typescript
const followUp = await store.receiveEnvelope(envelope);
if (followUp && typeof followUp === "object" && "type" in followUp && (followUp as MessageEnvelope).type === "profile_share") {
  // Both sides are now friends; send our profile back over the same mailbox.
  await deliverEnvelopeViaMailbox({ home, host, socketFactory, envelope: followUp as MessageEnvelope });
}
```

Use whatever mailbox-delivery primitive `dialout.ts` already uses for outbound sends (search for `mailbox_send` / `deliverEnvelopeViaMailbox` / `sendEnvelope` in that file and reuse the same call). Import `MessageEnvelope` if not already imported.

- [ ] **Step 5: Typecheck + the dialout suite**

Run: `npx tsc --noEmit && node --test test/dialout.test.ts test/profile-exchange.test.ts`
Expected: PASS. If `test/dialout.test.ts` asserts the old void return, update only the assertion that breaks, preserving intent.

- [ ] **Step 6: Commit**

```bash
git add src/dialout.ts test/profile-exchange.test.ts
git commit -m "feat(profile): dialout auto-delivers the requester's profile_share follow-up"
```

---

### Task 14: profile broadcast on edit (CLI + store)

**Files:**
- Modify: `src/edge-book.ts` add `friendsList()` convenience (if absent) + `broadcastProfileEnvelopes`; `src/cli.ts` `profile broadcast` action
- Test: `test/profile-exchange.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test("broadcastProfileEnvelopes targets every current friend", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  await alice.setProfile({ bio: "edited" });
  const envs = await alice.broadcastProfileEnvelopes();
  assert.equal(envs.length, 1);
  assert.equal(envs[0].to_agent_id, bobCard.agent_id);
  assert.equal(envs[0].type, "profile_share");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profile-exchange.test.ts`
Expected: FAIL — `broadcastProfileEnvelopes` does not exist.

- [ ] **Step 3: Implement broadcastProfileEnvelopes**

In `EdgeBookStore`, after `buildProfileShareEnvelope` (added in Task 10), add:

```typescript
  // Build a profile_share for every current friend (caller delivers them).
  async broadcastProfileEnvelopes(): Promise<MessageEnvelope[]> {
    const contacts = await this.contacts();
    const friends = Object.values(contacts).filter((c) => c.relationship_state === "friend");
    const out: MessageEnvelope[] = [];
    for (const friend of friends) {
      out.push(await this.buildProfileShareEnvelope(friend.peer_agent_id));
    }
    return out;
  }
```

- [ ] **Step 4: Add the CLI `profile broadcast` action**

In `src/cli.ts` `profile` command, add before the final `throw new EdgeBookError("unknown_action"...)`:

```typescript
    if (action === "broadcast") {
      const deliver = takeBoolFlag(args, "--deliver");
      const envelopes = await store.broadcastProfileEnvelopes();
      if (deliver) {
        const hostUrl = parseHost(args, ctx);
        for (const envelope of envelopes) {
          try {
            await deliverToPeer(store, envelope, envelope.to_agent_id);
          } catch (error) {
            if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
            await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
          }
        }
        return { text: `Broadcast profile to ${envelopes.length} friend(s)`, json: { count: envelopes.length } };
      }
      return { text: `Built ${envelopes.length} profile_share envelope(s)`, json: { envelopes } };
    }
```

- [ ] **Step 5: Run tests**

Run: `node --test test/profile-exchange.test.ts test/profile-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/edge-book.ts src/cli.ts test/profile-exchange.test.ts
git commit -m "feat(profile): profile broadcast on edit (store + CLI)"
```

---

### Task 15: Security tests — forged/mismatched/non-friend/stale

**Files:**
- Test: `test/profile-exchange.test.ts` (append)

- [ ] **Step 1: Write the security tests**

Append:

```typescript
test("profile_share from a non-friend is rejected", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  // Make Alice know Bob's key (request_sent) but NOT be friends.
  await alice.createFriendRequest(bobCard);
  // Bob (not friends with Alice from Alice's view) crafts a share to Alice.
  await bob.upsertContactFromCard(aliceCard, "friend"); // Bob thinks they're friends
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  await assert.rejects(() => alice.receiveProfileShare(share), /not_friend/);
});

test("profile_share with mismatched agent_id is rejected", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  (share.body as any).profile.agent_id = "did:openclaw:someone-else";
  await assert.rejects(() => alice.receiveProfileShare(share), /agent_id_mismatch|invalid_friend_profile|invalid_signature/);
});

test("tampered friend profile signature is rejected", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.receiveProfileShare((await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id)))!);
  const share = await bob.buildProfileShareEnvelope(aliceCard.agent_id);
  (share.body as any).profile.bio = "INJECTED";
  await assert.rejects(() => alice.receiveProfileShare(share), /invalid_friend_profile|invalid_signature|replay/);
});
```

Note: the tampered-signature test mutates the body after the envelope was signed, so envelope `verifyEnvelope` will catch it as `invalid_signature` (envelope signature covers the body). That is the correct, stronger rejection — the regex allows it.

- [ ] **Step 2: Run tests**

Run: `node --test test/profile-exchange.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/profile-exchange.test.ts
git commit -m "test(profile): forged/mismatched/non-friend/tampered profile_share rejected"
```

---

### Task 16: Update the two-agent harness + smoke to prove exchange end to end

**Files:**
- Modify: `src/edge-book.ts` `runTwoAgentHarness` (lines 2225+)
- Modify: `scripts/lib/two-agent-smoke.ts` (read it first to learn its assertion style)

- [ ] **Step 1: Update runTwoAgentHarness to set profiles and deliver the follow-up**

In `runTwoAgentHarness` (lines 2229-2245), after the `await alice.init(...)` / `await bob.init(...)` lines, add profile setup:

```typescript
  await alice.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.setProfile({ name: "Bob", bio: "Bob bio" });
```

Then change the accept/apply lines (2244-2245) from:

```typescript
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  await alice.applyFriendResponse(accept);
```

to:

```typescript
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const aliceFollowUp = await alice.applyFriendResponse(accept);
  if (aliceFollowUp) await bob.receiveProfileShare(aliceFollowUp);
```

At the end of the function, where it builds the returned result object, add assertions/fields:

```typescript
  const aliceSeesBob = (await alice.contacts())[bobCard.agent_id].friend_profile?.name === "Bob";
  const bobSeesAlice = (await bob.contacts())[aliceCard.agent_id].friend_profile?.name === "Alice";
```

and include `profileExchange: aliceSeesBob && bobSeesAlice` in the returned record (match the existing return shape — read lines 2253-2288 first).

- [ ] **Step 2: Run the harness test**

Run: `node --test test/two-agent-smoke.test.ts`
Expected: PASS. If it asserts a fixed result shape, add the `profileExchange` expectation.

- [ ] **Step 3: Extend the smoke script with a profile step**

Read `scripts/lib/two-agent-smoke.ts` and `scripts/smoke-2agent.ts`. Add a step after the friend-accept step that: sets profiles before pairing, delivers the follow-up profile_share over the transport, and asserts each side has the other's `friend_profile.name`. Follow the file's existing step/assert helper pattern exactly (do not invent a new harness).

- [ ] **Step 4: Run the local smoke**

Run: `npm run smoke`
Expected: PASS (the new profile step included).

- [ ] **Step 5: Full suite**

Run: `npx tsc --noEmit && node --test test/*.test.ts`
Expected: All PASS. Fix any test that asserted the pre-profile envelope/return shapes, preserving each test's intent.

- [ ] **Step 6: Commit**

```bash
git add src/edge-book.ts scripts/lib/two-agent-smoke.ts scripts/smoke-2agent.ts
git commit -m "test(profile): harness + smoke prove bidirectional profile exchange end to end"
```

---

## Self-Review (completed by plan author)

**Spec coverage (sections A + B + protocol):**
- Two-tier profile (public card vs friend profile): Tasks 3, 4, 9, 10, 11 ✓
- FriendProfile fields name/bio/location/socials: Tasks 1, 3, 5 ✓
- Per-field visibility friends/public/off, default friends: Tasks 2, 4, 5, 6 ✓
- Socials open vocabulary + `*` default: Tasks 2, 6 ✓
- Migration owner_label/share_owner_label → profile, new default to all: Task 2 (defaultProfile), Task 5 (legacy shims), Task 7 (test reconcile) ✓
- Two-step exchange, no leak before consent: Tasks 9, 10, 11 (+ no-leak assertion Task 11) ✓
- profile_share envelope + profile.read.friend scope: Tasks 8, 9 ✓
- Edit re-broadcast: Task 14 ✓
- Signature/verify on receipt, version dedup: Tasks 3, 10, 15 ✓
- Mailbox auto-delivery of follow-up: Task 13 ✓

**Out of scope (separate plans, intentionally not here):** `friend pending` CLI + Hermes notify cron, reader `friend_accept` approval, OpenClaw bundle.

**Type consistency:** `FriendProfile`, `IdentityProfile`, `FieldVisibility`, `SocialLink`, `ProfileShareBody` defined in Task 1/8 and used consistently. `buildFriendProfile`, `buildProfileShareEnvelope`, `receiveProfileShare`, `storeFriendProfile`, `broadcastProfileEnvelopes`, `defaultProfile`, `resolveFieldVisibility`, `resolveSocialVisibility`, `validateFriendProfile` named identically across tasks. `applyFriendResponse` return type changed once (Task 11) and all callers reconciled (Task 11 Step 7).

**Known follow-ups for the executor:** Task 6 changes the agent display-name flag in `profile set` from `--name` to `--name-agent` (so `--name` = human name); `init` keeps `--name` = display_name. This asymmetry is intentional and documented in Task 7. Confirm `runCli` option shape against `test/cli-object.test.ts` before writing Task 6's test.
