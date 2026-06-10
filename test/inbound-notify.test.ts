import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";
import type { MessageEnvelope } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-inbound-notify-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

// Minimal inbound envelope fixture for testing the pure renderer (notificationIntent
// is called post-apply and does not verify signatures).
function envelopeOf(type: MessageEnvelope["type"], from: string, to: string, body: Record<string, unknown>, id = "msg_test"): MessageEnvelope {
  return {
    message_id: id, type, from_agent_id: from, to_agent_id: to,
    relationship_id: "", capability_id: "", ref: "", transport: "local",
    created_at: new Date().toISOString(), expires_at: "", body, signature: "",
  };
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

test("notify_on_friend_request:false makes friend_request silent (null intent)", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  await bob.updateConfig({ notify_on_friend_request: false });

  assert.equal(await bob.notificationIntent(env), null);
});

test("notificationIntent renders a privileged_message (gated message) generically", async () => {
  // Proves the system is NOT friend-request-only: an inbound message-to-human notifies too.
  const { alice, bob } = await pair();
  const aliceId = (await alice.identity()).agent_id;
  const bobId = (await bob.identity()).agent_id;
  const bobCard = await bob.writeCard();
  // Seed Bob's contact for Alice (so the renderer can resolve her display_name).
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));

  const msg = envelopeOf("privileged_message", aliceId, bobId, { text: "ping from alice" }, "msg_pm_1");
  const intent = await bob.notificationIntent(msg);

  assert.ok(intent, "gated message should notify");
  assert.equal(intent!.kind, "privileged_message");
  assert.equal(intent!.from_id, aliceId);
  assert.match(intent!.message, /ping from alice/, "message preview included");
  assert.match(intent!.message, /Alice Agent/, "sender name resolved from contacts");
  assert.equal(intent!.dedup_key, msg.message_id);
});

test("unregistered/silent type (profile_share) yields a null intent", async () => {
  const { alice, bob } = await pair();
  const aliceId = (await alice.identity()).agent_id;
  const bobId = (await bob.identity()).agent_id;
  const env = envelopeOf("profile_share", aliceId, bobId, {}, "msg_ps_1");
  assert.equal(await bob.notificationIntent(env), null);
});
