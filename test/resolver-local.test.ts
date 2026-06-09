import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { localContactProvider } from "../src/resolver.ts";

async function befriended() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  return { alice, bobCard };
}

test("local provider resolves a known contact by agent_id", async () => {
  const { alice, bobCard } = await befriended();
  const result = await localContactProvider.resolve(alice, bobCard.agent_id);
  assert.ok(result);
  assert.equal(result.kind, "card");
  assert.equal(result.provenance.source, "local");
  assert.equal(result.agent_id, bobCard.agent_id);
});

test("local provider returns null for an unknown target", async () => {
  const { alice } = await befriended();
  assert.equal(await localContactProvider.resolve(alice, "nobody.openclaw.local"), null);
});
