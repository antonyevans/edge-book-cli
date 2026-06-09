import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { EdgeBookStore, slugifyHandle, isValidHandle, validateCard } from "../src/edge-book.ts";
import { shouldClaimHandle } from "../src/dialout.ts";

function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

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

test("buildHandleClaim produces a relay-verifiable claim", async () => {
  const s = await store(); // helper already defined in this file: inits a fresh store
  await s.setHandle("antony-evans");
  const claim = await s.buildHandleClaim();
  const id = await s.identity();
  assert.equal(claim.handle, "antony-evans");
  assert.equal(claim.agent_did, id.agent_id);
  assert.equal((claim.card as { agent_id: string }).agent_id, id.agent_id);
  const ok = crypto.verify(
    null,
    Buffer.from(canon({ handle: claim.handle, agent_did: claim.agent_did, claimed_at: claim.claimed_at })),
    id.public_key_pem,
    Buffer.from(claim.claim_sig, "base64url"),
  );
  assert.equal(ok, true);
});

test("buildHandleClaim throws if handle is still the default", async () => {
  const s = await store();
  await assert.rejects(() => s.buildHandleClaim(), /invalid_handle/);
});

test("shouldClaimHandle skips default/empty, sends for a real handle", () => {
  assert.equal(shouldClaimHandle("agent.openclaw.local"), false);
  assert.equal(shouldClaimHandle(""), false);
  assert.equal(shouldClaimHandle(undefined), false);
  assert.equal(shouldClaimHandle("antony-evans"), true);
  assert.equal(shouldClaimHandle("Bad Handle"), false);
});
