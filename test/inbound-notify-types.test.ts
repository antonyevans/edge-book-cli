import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";
import type { MessageEnvelope } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-types-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

function envelopeOf(type: MessageEnvelope["type"], from: string, to: string, body: Record<string, unknown>, id = "m"): MessageEnvelope {
  return {
    message_id: id, type, from_agent_id: from, to_agent_id: to,
    relationship_id: "", capability_id: "", ref: "", transport: "local",
    created_at: new Date().toISOString(), expires_at: "", body, signature: "",
  };
}

// Seed Bob's contact for Alice so renderers can resolve her name.
async function seedContact(alice: EdgeBookStore, bob: EdgeBookStore) {
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
}

test("friend_response (accepted) renders a notification", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const env = envelopeOf("friend_response", aliceCard.agent_id, (await bob.identity()).agent_id, { accepted: true, card: aliceCard, reason: "" }, "fr1");
  const intent = await bob.notificationIntent(env);
  assert.ok(intent);
  assert.equal(intent!.kind, "friend_response");
  assert.match(intent!.message, /Alice Agent/);
  assert.match(intent!.message, /accept/i);
});

test("object_share renders a notification naming the request", async () => {
  const { alice, bob } = await pair();
  await seedContact(alice, bob);
  const aliceId = (await alice.identity()).agent_id;
  const env = envelopeOf("object_share", aliceId, (await bob.identity()).agent_id, {
    object: { object_id: "o1", type: "request", from_agent: aliceId, request: { title: "Review my deck", body: "..." }, created_at: "", signature: "" },
    grant: {},
  }, "os1");
  const intent = await bob.notificationIntent(env);
  assert.ok(intent);
  assert.equal(intent!.kind, "object_share");
  assert.match(intent!.message, /Review my deck/);
  assert.match(intent!.message, /Alice Agent/);
});

test("escalation renders the subject for the human", async () => {
  const { alice, bob } = await pair();
  const aliceId = (await alice.identity()).agent_id;
  const env = envelopeOf("escalation", aliceId, (await bob.identity()).agent_id, {
    escalation: { escalation_id: "e1", raised_by_agent_id: aliceId, collaborators: [], to_human_owner_id: "", kind: "decision", subject: "Approve refund?", body: "Customer wants a refund", options: ["yes", "no"], context_refs: [], status: "open", risk_level: "low", created_at: "", expires_at: "", answer_text: "", answer_choice: "", answered_at: "", answered_by: "" },
  }, "es1");
  const intent = await bob.notificationIntent(env);
  assert.ok(intent);
  assert.equal(intent!.kind, "escalation");
  assert.match(intent!.message, /Approve refund\?/);
  assert.match(intent!.message, /yes/);
});
