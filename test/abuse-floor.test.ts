import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-abuse-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("inbound friend_request throttle drops a per-peer flood with rate_limited", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  await bob.updateConfig({ inbound_max_per_peer: 2, inbound_window_ms: 3_600_000 });
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)); // 1
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)); // 2
  const req3 = await alice.createFriendRequest(bobCard); // 3 — pre-create
  await assert.rejects(
    () => bob.receiveFriendRequest(req3),
    (e: unknown) => e instanceof EdgeBookError && e.code === "rate_limited",
  );
});
