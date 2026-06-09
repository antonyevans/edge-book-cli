import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-appr-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("rejectFriend sets rejected and returns a signed accepted:false response", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const envelope = await bob.rejectFriend(aliceCard.agent_id, "no thanks");
  const body = envelope.body as unknown as FriendResponseBody;
  assert.equal(body.accepted, false);
  assert.equal(envelope.type, "friend_response");
  assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "rejected");
  // Requester applies it and ends rejected, no follow-up.
  const followUp = await alice.applyFriendResponse(envelope);
  assert.equal(followUp, null);
  assert.equal((await alice.contacts())[(await bob.writeCard()).agent_id].relationship_state, "rejected");
});
