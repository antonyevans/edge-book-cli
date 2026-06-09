import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { writeCandidate, listCandidates, getCandidate } from "../src/resolver.ts";

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cand-"));
  const s = new EdgeBookStore({ home: path.join(root, "a") });
  await s.init({ handle: "a.openclaw.local" });
  return s;
}

test("writeCandidate persists and assigns an id; listCandidates reads it back", async () => {
  const s = await store();
  const cand = await writeCandidate(s, {
    source: "index", confidence: "low", display_name: "Maybe Bob", reason: "op1", card_url: "https://bob/card.json",
  });
  assert.match(cand.candidate_id, /^cand_/);
  assert.equal(cand.approved, false);
  const all = await listCandidates(s);
  assert.equal(all.length, 1);
  assert.equal((await getCandidate(s, cand.candidate_id))?.display_name, "Maybe Bob");
});

test("writeCandidate dedupes by source+card_url, keeping one entry", async () => {
  const s = await store();
  const base = { source: "index" as const, confidence: "low" as const, display_name: "Bob", reason: "op1", card_url: "https://bob/card.json" };
  await writeCandidate(s, base);
  await writeCandidate(s, base);
  assert.equal((await listCandidates(s)).length, 1);
});
