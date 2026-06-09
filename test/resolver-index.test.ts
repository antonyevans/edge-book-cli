import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeIndexProvider, INDEX_CARD_URL_FIELDS, type IndexOpportunity } from "../src/resolver.ts";

test("index provider yields a candidate-only result with no agent_id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-idx-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local" });

  const opportunity: IndexOpportunity = {
    message: "Bob is looking for an EA agent to collaborate.",
    accept_url: "https://index.example/accept/op1",
    socials: { edge_book_card: "https://bob.example/card.json" },
    network: "edgecity",
  };
  const provider = makeIndexProvider(async () => [opportunity]);

  const result = await provider.resolve(alice, "index:op1");
  assert.ok(result);
  assert.equal(result.kind, "candidate");
  assert.equal(result.provenance.source, "index");
  assert.equal(result.provenance.confidence, "low");
  assert.equal(result.candidate?.card_url, "https://bob.example/card.json");
  assert.equal(result.candidate?.agent_id, undefined, "index must NOT assert an agent_id");
});

test("INDEX_CARD_URL_FIELDS prefers edge_book_card then websites", () => {
  assert.deepEqual(INDEX_CARD_URL_FIELDS, ["edge_book_card", "website", "websites"]);
});
