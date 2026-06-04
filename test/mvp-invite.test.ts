import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore, loadCard } from "../src/edge-book.ts";

async function tempHome(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `edge-book-invite-${name}-`));
}

test("edgebook:invite link round-trips through loadCard and `card invite`", async () => {
  const aliceHome = await tempHome("alice");
  const alice = new EdgeBookStore({ home: aliceHome });
  const aliceId = (await alice.init({ handle: "alice.local" })).agent_id;

  // `card invite` emits an edgebook:invite: token.
  const invite = await handleCli(["card", "invite", "--home", aliceHome]);
  const inviteUrl = (invite.json as { invite_url: string }).invite_url;
  assert.match(inviteUrl, /^edgebook:invite:/);

  // loadCard decodes it back to Alice's signed card.
  const card = await loadCard(inviteUrl);
  assert.equal(card.agent_id, aliceId);
  assert.ok(card.signature, "decoded card keeps its signature");
});

test("`friend request <invite>` imports the contact and produces a friend_request envelope", async () => {
  const aliceHome = await tempHome("alice");
  const bobHome = await tempHome("bob");
  const alice = new EdgeBookStore({ home: aliceHome });
  const bob = new EdgeBookStore({ home: bobHome });
  const aliceId = (await alice.init({ handle: "alice.local" })).agent_id;
  await bob.init({ handle: "bob.local" });

  const inviteUrl = (await handleCli(["card", "invite", "--home", aliceHome])).json as { invite_url: string };
  const req = await handleCli(["friend", "request", "--home", bobHome, inviteUrl.invite_url]);
  const env = req.json as { type: string; to_agent_id: string };
  assert.equal(env.type, "friend_request");
  assert.equal(env.to_agent_id, aliceId);

  // Bob now has Alice as a request_sent contact.
  const contact = (await bob.contacts())[aliceId];
  assert.equal(contact.relationship_state, "request_sent");
});
