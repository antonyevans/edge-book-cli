import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { inviteProvider, cardFileProvider } from "../src/resolver.ts";

async function bobInviteAndCardFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-card-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  const cardPath = path.join(root, "bob-card.json");
  await fs.writeFile(cardPath, JSON.stringify(bobCard), "utf8");
  return { alice, bobCard, invite, cardPath };
}

test("invite provider resolves and verifies an invite link", async () => {
  const { alice, bobCard, invite } = await bobInviteAndCardFile();
  const result = await inviteProvider.resolve(alice, invite);
  assert.ok(result);
  assert.equal(result.kind, "card");
  assert.equal(result.card?.agent_id, bobCard.agent_id);
  assert.equal(result.provenance.source, "invite");
});

test("invite provider returns null for a non-invite target", async () => {
  const { alice } = await bobInviteAndCardFile();
  assert.equal(await inviteProvider.resolve(alice, "https://x/card"), null);
});

test("card-file provider resolves a card file path", async () => {
  const { alice, bobCard, cardPath } = await bobInviteAndCardFile();
  const result = await cardFileProvider.resolve(alice, cardPath);
  assert.equal(result?.card?.agent_id, bobCard.agent_id);
  assert.equal(result?.provenance.source, "card_file");
});

test("card-file provider rejects a forged card", async () => {
  const { alice, cardPath, bobCard } = await bobInviteAndCardFile();
  const forged = { ...bobCard, handle: "tampered.local" };
  await fs.writeFile(cardPath, JSON.stringify(forged), "utf8");
  await assert.rejects(() => cardFileProvider.resolve(alice, cardPath));
});
