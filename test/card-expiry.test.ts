import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, validateCard, type AgentCard } from "../src/edge-book.ts";

async function freshStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-exp-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "X" });
  return s;
}

test("validateCard rejects an expired card (before signature check)", async () => {
  const s = await freshStore();
  const card = await s.writeCard();
  const expired: AgentCard = { ...card, expires_at: new Date(Date.now() - 1000).toISOString() };
  assert.throws(
    () => validateCard(expired),
    (e: Error) => (e as { code?: string }).code === "card_expired"
  );
});

test("validateCard accepts a current card", async () => {
  const s = await freshStore();
  const card = await s.writeCard(); // expires_at ~7 days out, properly signed
  assert.doesNotThrow(() => validateCard(card));
});
