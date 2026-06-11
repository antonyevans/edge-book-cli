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

test("`card invite` outputs deeplink_url in json and deeplink as default text", async () => {
  const aliceHome = await tempHome("alice-deeplink");
  await handleCli(["init", "--home", aliceHome, "--handle", "alice.local"]);
  const result = await handleCli(["card", "invite", "--home", aliceHome]);
  const json = result.json as { invite_url: string; deeplink_url: string; agent_id: string };
  // invite_url is still the raw blob (backward compat)
  assert.match(json.invite_url, /^edgebook:invite:/);
  // deeplink_url is the tappable URL
  assert.match(json.deeplink_url, /\/add#i=/);
  // default text output is the deeplink, not the raw blob
  assert.match(result.text, /\/add#i=/);
  assert.doesNotMatch(result.text, /^edgebook:invite:/);
});

test("`card invite --raw` outputs the raw blob as text", async () => {
  const aliceHome = await tempHome("alice-raw");
  await handleCli(["init", "--home", aliceHome, "--handle", "alice.local"]);
  const result = await handleCli(["card", "invite", "--raw", "--home", aliceHome]);
  assert.match(result.text, /^edgebook:invite:/);
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
