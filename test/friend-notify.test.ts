import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("pendingFriendRequests lists un-notified request_received; mark dedups", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  let pending = await bob.pendingFriendRequests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].peer_agent_id, aliceCard.agent_id);
  assert.equal(pending[0].display_name, "Alice Agent");
  await bob.markFriendRequestNotified(aliceCard.agent_id);
  pending = await bob.pendingFriendRequests();
  assert.equal(pending.length, 0, "marked request is no longer pending");
});

test("notify_on_friend_request:false suppresses the list", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.updateConfig({ notify_on_friend_request: false });
  assert.deepEqual(await bob.pendingFriendRequests(), []);
});

test("accepted/other states never appear as pending", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.acceptFriend(aliceCard.agent_id);
  assert.deepEqual(await bob.pendingFriendRequests(), []);
});

import { handleCli } from "../src/cli.ts";

test("CLI friend pending --json lists, mark-notified dedups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-cli-"));
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await handleCli(["init", "--name", "Bob Agent"], { home: bobHome });
  const bob = new EdgeBookStore({ home: bobHome });
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));

  const list = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  const j = list.json as any[];
  assert.equal(j.length, 1);
  assert.equal(j[0].agent_id, aliceCard.agent_id);

  await handleCli(["friend", "mark-notified", aliceCard.agent_id], { home: bobHome });
  const after = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  assert.equal((after.json as any[]).length, 0);
});
