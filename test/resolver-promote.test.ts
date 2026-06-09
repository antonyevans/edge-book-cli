import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";
import { writeCandidate, promoteCandidate } from "../src/resolver.ts";

async function ctx() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-promote-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  return { alice, bobCard, invite };
}

test("promoteCandidate verifies the card and creates a friend request envelope", async () => {
  const { alice, bobCard, invite } = await ctx();
  const cand = await writeCandidate(alice, { source: "index", confidence: "low", display_name: "Bob", reason: "op1", card_url: invite });
  const envelope = await promoteCandidate(alice, cand.candidate_id);
  assert.equal(envelope.type, "friend_request");
  const contacts = await alice.contacts();
  assert.ok(contacts[bobCard.agent_id], "contact created after verified promotion");
});

test("promoteCandidate fails closed when the candidate has no card_url", async () => {
  const { alice } = await ctx();
  const cand = await writeCandidate(alice, { source: "index", confidence: "low", display_name: "Bob", reason: "op1" });
  await assert.rejects(
    () => promoteCandidate(alice, cand.candidate_id),
    (e) => e instanceof EdgeBookError && e.code === "candidate_not_resolvable"
  );
});
