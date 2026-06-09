import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  EdgeBookStore,
  EdgeBookError,
  type Escalation,
  type MessageEnvelope,
} from "../src/edge-book.ts";

// Two agents that have completed a friendship handshake, so the remote-escalation
// path (friend-state + escalation.raise grant) is satisfied. Mirrors the helper
// used in profile-exchange.test.ts.
async function twoFriends() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-esc-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent", ownerLabel: "Alice Human" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent", ownerLabel: "Bob Human" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  // alice befriends bob; bob accepts (issues alice the friend grants, incl. escalation.raise)
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  return { alice, bob, aliceId: aliceCard.agent_id, bobId: bobCard.agent_id };
}

async function soloAgent() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-esc-solo-"));
  const agent = new EdgeBookStore({ home: path.join(root, "a") });
  await agent.init({ handle: "a.openclaw.local", displayName: "A", ownerLabel: "Owner A" });
  return agent;
}

// ── Local escalation: an agent asks its own human ──────────────────────────

test("raiseEscalation (local) creates a pending escalation addressed to the owner", async () => {
  const agent = await soloAgent();
  const { escalation, envelope } = await agent.raiseEscalation({
    kind: "question",
    subject: "Need the Q3 revenue number",
    body: "What was Q3 revenue? Blocked on the deck.",
  });
  assert.equal(envelope, undefined, "local escalation must not produce an envelope");
  assert.equal(escalation.status, "pending");
  assert.equal(escalation.kind, "question");
  assert.equal(escalation.answer_text, "");
  const stored = (await agent.escalations())[escalation.escalation_id];
  assert.ok(stored, "escalation persisted to escalations.json");
  assert.equal(stored.subject, "Need the Q3 revenue number");
});

test("answerEscalation records the human's answer and resolves the status", async () => {
  const agent = await soloAgent();
  const { escalation } = await agent.raiseEscalation({ kind: "question", subject: "s", body: "b" });
  const answered = await agent.answerEscalation(escalation.escalation_id, { text: "Q3 was $1.2M" });
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer_text, "Q3 was $1.2M");
  assert.equal(answered.answered_by, "local-owner");
  assert.ok(answered.answered_at);
  assert.ok(answered.audit_refs.length >= 1, "answer writes an audit event");
});

test("answering a non-pending escalation is rejected", async () => {
  const agent = await soloAgent();
  const { escalation } = await agent.raiseEscalation({ kind: "question", subject: "s", body: "b" });
  await agent.answerEscalation(escalation.escalation_id, { text: "first" });
  await assert.rejects(
    () => agent.answerEscalation(escalation.escalation_id, { text: "second" }),
    (e: unknown) => e instanceof EdgeBookError && /already/i.test((e as Error).message),
  );
});

test("decision escalation requires the answer to be one of the offered options", async () => {
  const agent = await soloAgent();
  const { escalation } = await agent.raiseEscalation({
    kind: "decision",
    subject: "Ship today?",
    body: "Go or no-go on the 4pm deploy.",
    options: ["go", "hold"],
  });
  await assert.rejects(
    () => agent.answerEscalation(escalation.escalation_id, { choice: "maybe" }),
    (e: unknown) => e instanceof EdgeBookError && /option/i.test((e as Error).message),
  );
  const ok = await agent.answerEscalation(escalation.escalation_id, { choice: "go" });
  assert.equal(ok.status, "answered");
  assert.equal(ok.answer_choice, "go");
});

// ── Remote escalation: a collaborating agent asks another agent's human ─────

test("raiseEscalation (remote) returns a signed escalation envelope the receiver materialises", async () => {
  const { alice, bob, bobId } = await twoFriends();
  const { escalation, envelope } = await alice.raiseEscalation({
    kind: "input",
    subject: "Need the contract counterparty name",
    body: "We're drafting the NDA and need the legal entity name.",
    to: bobId,
  });
  assert.ok(envelope, "remote escalation must produce an envelope to deliver");
  assert.equal(envelope!.type, "escalation");
  assert.equal(envelope!.to_agent_id, bobId);

  const received = await bob.receiveEscalation(envelope!);
  assert.equal(received.escalation_id, escalation.escalation_id, "id is stable across the wire");
  assert.equal(received.status, "pending");
  assert.equal(received.raised_by_agent_id, escalation.raised_by_agent_id);
  const stored = (await bob.escalations())[escalation.escalation_id];
  assert.ok(stored, "receiver persisted the escalation for its human");
});

test("answering a remote escalation routes the answer back to the requesting agent", async () => {
  const { alice, bob, bobId } = await twoFriends();
  const { escalation, envelope } = await alice.raiseEscalation({
    kind: "question", subject: "s", body: "b", to: bobId,
  });
  await bob.receiveEscalation(envelope!);
  const response = await bob.answerEscalation(escalation.escalation_id, { text: "Acme LLC" });
  assert.ok(response.envelope, "answering a remote escalation produces a response envelope");
  assert.equal(response.envelope!.type, "escalation_response");

  // Requesting agent applies it to its own copy.
  await alice.applyEscalationResponse(response.envelope!);
  const mine = (await alice.escalations())[escalation.escalation_id];
  assert.equal(mine.status, "answered");
  assert.equal(mine.answer_text, "Acme LLC");
});

test("a non-friend cannot escalate to another agent's human (fail closed)", async () => {
  const stranger = await soloAgent();
  const target = await soloAgent();
  const targetCard = await target.writeCard();
  await assert.rejects(
    () => stranger.raiseEscalation({ kind: "question", subject: "s", body: "b", to: targetCard.agent_id }),
    (e: unknown) => e instanceof EdgeBookError,
  );
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test("expireEscalations marks past-expiry pending escalations expired", async () => {
  const agent = await soloAgent();
  const { escalation } = await agent.raiseEscalation({
    kind: "question", subject: "s", body: "b", ttlMs: -1, // already expired
  });
  await agent.expireEscalations();
  const stored = (await agent.escalations())[escalation.escalation_id];
  assert.equal(stored.status, "expired");
});
