import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

async function tempHome(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `edge-book-cli-object-${name}-`));
}

test("object CLI: create → list → read, and share produces an object_share envelope", async () => {
  const aliceHome = await tempHome("alice");
  const bobHome = await tempHome("bob");
  const alice = new EdgeBookStore({ home: aliceHome });
  const bob = new EdgeBookStore({ home: bobHome });
  await alice.init({ handle: "alice.local" });
  await bob.init({ handle: "bob.local" });
  // Friend them via the store API (the CLI friend flow is covered elsewhere).
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const bobId = (await bob.identity()).agent_id;

  // create
  const created = await handleCli(["object", "create", "--home", aliceHome, "--title", "Help with X", "--body", "details here"]);
  const objectId = (created.json as { object_id: string }).object_id;
  assert.match(created.text, /^Created object obj_/);

  // share (no --deliver) → object_share envelope addressed to Bob
  const shared = await handleCli(["object", "share", "--home", aliceHome, bobId, objectId]);
  const env = shared.json as { type: string; to_agent_id: string; body: { object: { object_id: string }; grant: { scopes: string[] } } };
  assert.equal(env.type, "object_share");
  assert.equal(env.to_agent_id, bobId);
  assert.equal(env.body.object.object_id, objectId);
  assert.deepEqual(env.body.grant.scopes, ["object.read"]);

  // Bob applies the envelope via CLI receive (write it to a file first).
  const envPath = path.join(bobHome, "share.json");
  await fs.writeFile(envPath, JSON.stringify(env));
  await handleCli(["object", "receive", "--home", bobHome, envPath]);

  // Bob lists shared-with-me and reads it.
  const list = await handleCli(["object", "list", "--home", bobHome]);
  assert.equal((list.json as Array<{ object_id: string }>).length, 1);
  const read = await handleCli(["object", "read", "--home", bobHome, objectId]);
  assert.equal((read.json as { request: { title: string } }).request.title, "Help with X");

  // Owner reading own object works too.
  const ownerRead = await handleCli(["object", "read", "--home", aliceHome, objectId]);
  assert.equal((ownerRead.json as { object_id: string }).object_id, objectId);
});
