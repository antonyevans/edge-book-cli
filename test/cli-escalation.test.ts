import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore, type Escalation, type MessageEnvelope } from "../src/edge-book.ts";

async function tempHome(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `edge-book-cli-esc-${name}-`));
}

test("escalation CLI: raise (local) → list → answer", async () => {
  const home = await tempHome("solo");
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "a.local", ownerLabel: "Owner" });

  const raised = await handleCli(["escalation", "raise", "--home", home, "--kind", "question", "--subject", "Q3 revenue?", "--body", "Need the number"]);
  const esc = raised.json as Escalation;
  assert.equal(esc.status, "pending");
  assert.match(raised.text, /^Raised escalation esc_/);

  const listed = await handleCli(["escalation", "list", "--home", home]);
  assert.equal((listed.json as Escalation[]).length, 1);

  const answered = await handleCli(["escalation", "answer", "--home", home, esc.escalation_id, "--text", "1.2M"]);
  assert.equal((answered.json as Escalation).status, "answered");
  assert.equal((answered.json as Escalation).answer_text, "1.2M");
});

test("escalation CLI: remote raise produces an escalation envelope; receive + answer + respond round-trips", async () => {
  const aliceHome = await tempHome("alice");
  const bobHome = await tempHome("bob");
  const alice = new EdgeBookStore({ home: aliceHome });
  const bob = new EdgeBookStore({ home: bobHome });
  await alice.init({ handle: "alice.local", ownerLabel: "Alice H" });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob H" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const bobId = (await bob.identity()).agent_id;

  // Alice raises to Bob's human (no --deliver → prints the envelope).
  const raised = await handleCli(["escalation", "raise", "--home", aliceHome, "--kind", "input", "--subject", "Entity name?", "--body", "for the NDA", "--to", bobId]);
  const envelope = raised.json as MessageEnvelope;
  assert.equal(envelope.type, "escalation");

  // Bob receives it from a file.
  const envPath = path.join(bobHome, "in.json");
  await fs.writeFile(envPath, JSON.stringify(envelope), "utf8");
  const received = await handleCli(["escalation", "receive", "--home", bobHome, envPath]);
  const escId = (received.json as Escalation).escalation_id;

  // Bob's human answers → response envelope.
  const answered = await handleCli(["escalation", "answer", "--home", bobHome, escId, "--text", "Acme LLC"]);
  const responseEnv = (answered.json as Escalation & { response_envelope?: MessageEnvelope }).response_envelope;
  assert.ok(responseEnv, "remote answer emits a response envelope");
  assert.equal(responseEnv!.type, "escalation_response");

  // Alice applies the response.
  const respPath = path.join(aliceHome, "resp.json");
  await fs.writeFile(respPath, JSON.stringify(responseEnv), "utf8");
  const applied = await handleCli(["escalation", "respond", "--home", aliceHome, respPath]);
  assert.equal((applied.json as Escalation).status, "answered");
  assert.equal((applied.json as Escalation).answer_text, "Acme LLC");
});
