import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-types-cfg-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("notify_types whitelist excludes kinds not in the list", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  await bob.updateConfig({ notify_types: ["privileged_message"] });
  assert.equal(await bob.notificationIntent(env), null, "friend_request excluded by whitelist");
});

test("notify_types whitelist allows kinds in the list", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  await bob.updateConfig({ notify_types: ["friend_request"] });
  assert.ok(await bob.notificationIntent(env), "friend_request included by whitelist");
});
