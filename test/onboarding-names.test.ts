import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

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
