import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore, validateCard } from "../src/edge-book.ts";

async function tmp() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-cap-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  return s;
}

test("buildCard includes advertised_capabilities (active + deprecated) and stays signed (R3)", async () => {
  const s = await tmp();
  const c1 = await s.advertiseCapability({ name: "code_review", version: "1.2.0", summary: "reviews diffs" });
  const c2 = await s.advertiseCapability({ name: "legacy", version: "0.9.0", summary: "old" });
  await s.deprecateCapability(c2.capability_id);
  const card = await s.buildCard();
  validateCard(card);  // signature still valid with the new field
  const ac = card.advertised_capabilities!;
  assert.equal(ac.length, 2);
  const byName = Object.fromEntries(ac.map((c: any) => [c.name, c]));
  assert.equal(byName.code_review.version, "1.2.0");
  assert.equal(byName.code_review.status, "active");
  assert.equal(byName.legacy.status, "deprecated");
});

test("upsertContactFromCard carries advertised_capabilities into the contact (and drops them if removed)", async () => {
  const issuer = await tmp();
  await issuer.advertiseCapability({ name: "code_review", version: "1.0.0", summary: "x" });
  const card = await issuer.buildCard();
  const me = await tmp();
  const contact = await me.upsertContactFromCard(card, "friend");
  assert.equal(contact.advertised_capabilities?.length, 1);
  assert.equal(contact.advertised_capabilities?.[0].name, "code_review");
});
