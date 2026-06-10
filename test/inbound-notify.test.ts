import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-inbound-notify-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("notificationIntent renders a friend_request into a notifiable intent", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const aliceId = (await alice.identity()).agent_id;
  const env = await alice.createFriendRequest(bobCard, "lets connect");
  await bob.receiveFriendRequest(env);

  const intent = await bob.notificationIntent(env);

  assert.ok(intent, "friend_request should produce a notification intent");
  assert.equal(intent!.kind, "friend_request");
  assert.equal(intent!.from_id, aliceId);
  assert.match(intent!.message, /Alice Agent/, "message names the requester");
  assert.equal(intent!.dedup_key, env.message_id, "dedup key defaults to message_id");
});
