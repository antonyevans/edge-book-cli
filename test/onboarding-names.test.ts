import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { recordInviteCandidate } from "../src/onboarding.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-names-"));
}

test("init persists a distinct agent name, human owner, and owner-share opt-in", async () => {
  const store = new EdgeBookStore({ home: await tempRoot() });
  const id = await store.init({ handle: "a.local", displayName: "Scout", ownerLabel: "Antony Evans", shareOwnerLabel: true });
  assert.equal(id.display_name, "Scout");
  assert.equal(id.owner_label, "Antony Evans");
  assert.equal(id.share_owner_label, true);
  const card = await store.writeCard();
  assert.equal(card.display_name, "Scout");
  assert.equal(card.owner_label, "Antony Evans", "shared owner rides the card when opted in");
});

test("owner_label is private by default — absent from the published card unless shared", async () => {
  const store = new EdgeBookStore({ home: await tempRoot() });
  await store.init({ handle: "b.local", ownerLabel: "Antony Evans" }); // no share opt-in
  const card = await store.writeCard();
  assert.equal(card.owner_label, undefined, "owner name stays private by default");
});

test("init output explains the two-tier profile so users understand agent name vs human profile", async () => {
  const root = await tempRoot();
  const result = await handleCli(["init", "--home", root, "--handle", "c.local"]);
  assert.match(result.text, /agent name/i);
  assert.match(result.text, /profile/i);
  assert.match(result.text, /profile set/i);
  // The human name/bio/location is now a separate profile tier, not just "owner"
  assert.match(result.text, /friends/i);
});

test("recordInviteCandidate falls back to handle when inviter display_name is empty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-names-invite-"));
  const inviterHome = path.join(root, "inviter");
  // Inviter inits with empty display_name (new default — no name set).
  // Use a handle that passes the slug validator ([a-z0-9-] only).
  await handleCli(["init", "--home", inviterHome, "--handle", "greeter-no-name", "--name", ""]);
  const inviteResult = await handleCli(["card", "invite", "--home", inviterHome, "--ttl-ms", "60000", "--uses", "1"]);
  const inviteUrl = (inviteResult.json as { invite_url: string }).invite_url;

  const newbieHome = path.join(root, "newbie");
  const newbieStore = new EdgeBookStore({ home: newbieHome });
  await newbieStore.init({ handle: "newbie.openclaw.local", displayName: "Newbie" });

  const result = await recordInviteCandidate(newbieStore, inviteUrl);
  assert.equal(
    result.displayName,
    "greeter-no-name",
    "displayName must fall back to handle when inviter display_name is empty",
  );
});
