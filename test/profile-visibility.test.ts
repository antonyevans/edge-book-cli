import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  defaultProfile,
  resolveFieldVisibility,
  resolveSocialVisibility,
  EdgeBookStore,
  validateFriendProfile,
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
