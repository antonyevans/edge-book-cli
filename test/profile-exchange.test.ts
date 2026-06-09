import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody, type MessageEnvelope } from "../src/edge-book.ts";

async function twoAgents() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-x-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  await alice.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.setProfile({ name: "Bob", bio: "Bob bio" });
  return { alice, bob };
}

test("acceptFriend attaches the accepter's friend profile and a profile.read.friend grant", async () => {
  const { alice, bob } = await twoAgents();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const body = accept.body as unknown as FriendResponseBody;
  assert.equal(body.profile?.name, "Bob");
  assert.ok(body.grant?.scopes.includes("profile.read.friend"));
  assert.ok(body.grant?.scopes.includes("message.friend"));
});
