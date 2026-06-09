import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { resolveTarget, defaultProviders, makeIndexProvider, listCandidates, type IndexOpportunity } from "../src/resolver.ts";

async function ctx() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolve-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  return { alice, bobCard, invite, root };
}

test("resolveTarget returns resolved+verified card for an invite", async () => {
  const { alice, bobCard, invite } = await ctx();
  const result = await resolveTarget(alice, invite, { providers: defaultProviders() });
  assert.equal(result.status, "resolved");
  assert.equal(result.card?.agent_id, bobCard.agent_id);
});

test("resolveTarget returns approval_required + persists a candidate for index", async () => {
  const { alice } = await ctx();
  const opp: IndexOpportunity = { message: "Bob wants to collaborate", accept_url: "https://i/accept", socials: { edge_book_card: "https://bob/card.json" } };
  const providers = [...defaultProviders(), makeIndexProvider(async () => [opp])];
  const result = await resolveTarget(alice, "index:op1", { providers });
  assert.equal(result.status, "approval_required");
  assert.equal(result.candidates?.[0].card_url, "https://bob/card.json");
  assert.equal(result.candidates?.[0].agent_id, undefined);
  assert.equal((await listCandidates(alice)).length, 1, "candidate persisted");
});

test("resolveTarget returns not_found when nothing matches", async () => {
  const { alice } = await ctx();
  const result = await resolveTarget(alice, "registry:ghost", { providers: defaultProviders() });
  assert.equal(result.status, "not_found");
});
