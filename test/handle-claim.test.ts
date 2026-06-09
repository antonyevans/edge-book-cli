import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, slugifyHandle, isValidHandle, validateCard } from "../src/edge-book.ts";

async function store() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-handle-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "X" }); // default handle, replaced below
  return s;
}

test("slugifyHandle + isValidHandle", () => {
  assert.equal(slugifyHandle("Antony Evans"), "antony-evans");
  assert.equal(isValidHandle("antony-evans"), true);
  assert.equal(isValidHandle("ab"), false);
  assert.equal(isValidHandle("metrics"), false);
});

test("setHandle updates identity + re-signs the card", async () => {
  const s = await store();
  await s.setHandle("antony-evans");
  const id = await s.identity();
  assert.equal(id.handle, "antony-evans");
  const card = await s.writeCard();
  assert.equal(card.handle, "antony-evans");
  assert.doesNotThrow(() => validateCard(card)); // signature still valid after re-sign
});

test("setHandle rejects a bad slug", async () => {
  const s = await store();
  await assert.rejects(() => s.setHandle("Bad Handle!"), /invalid_handle/);
});
