import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";
import type { MessageEnvelope } from "../src/edge-book.ts";
import { notifyInbound } from "../src/notify.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-inbound-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob, root };
}

function envelopeOf(type: MessageEnvelope["type"], from: string, to: string, body: Record<string, unknown>, id = "msg_test"): MessageEnvelope {
  return {
    message_id: id, type, from_agent_id: from, to_agent_id: to,
    relationship_id: "", capability_id: "", ref: "", transport: "local",
    created_at: new Date().toISOString(), expires_at: "", body, signature: "",
  };
}

test("notifyInbound delivers a friend_request, stamps notified_at, audits delivered", async () => {
  const { alice, bob, root } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  const out = path.join(root, "out.txt");
  const cmd = `cat >> ${JSON.stringify(out)}; printf "\\n---\\n" >> ${JSON.stringify(out)}`;

  const r = await notifyInbound(bob, env, { cmd });

  assert.equal(r.notified, true);
  assert.equal((await bob.unnotifiedFriendRequests()).length, 0, "notified_at stamped → cron skips it");
  assert.equal((await bob.pendingFriendRequests()).length, 1, "spec-139: still pending until the human acts");
  assert.match(await fs.readFile(out, "utf8"), /wants to connect/);
  assert.ok((await bob.auditEvents()).some((e) => e.action === "notify.delivered"));
});

test("notifyInbound is idempotent per message (ledger dedup)", async () => {
  const { alice, bob, root } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  const out = path.join(root, "out.txt");
  const cmd = `printf "X" >> ${JSON.stringify(out)}`;

  await notifyInbound(bob, env, { cmd });
  const second = await notifyInbound(bob, env, { cmd });

  assert.equal(second.notified, false);
  assert.equal(second.reason, "already_notified");
  assert.equal((await fs.readFile(out, "utf8")).length, 1, "command ran exactly once");
});

test("failed delivery leaves the request pending and audits failure", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);

  const r = await notifyInbound(bob, env, { cmd: "exit 1" });

  assert.equal(r.notified, false);
  assert.equal((await bob.unnotifiedFriendRequests()).length, 1, "still un-notified after a failed notify");
  assert.ok((await bob.auditEvents()).some((e) => e.action === "notify.failed"));
});

test("silent type yields no delivery", async () => {
  const { alice, bob } = await pair();
  const aliceId = (await alice.identity()).agent_id;
  const bobId = (await bob.identity()).agent_id;
  // ack is a protocol-level frame with no notify policy — stays silent.
  const env = envelopeOf("ack", aliceId, bobId, {}, "ack1");
  const r = await notifyInbound(bob, env, { cmd: "cat" });
  assert.equal(r.notified, false);
  assert.equal(r.reason, "silent");
});

test("no notify_cmd configured → no_notify_cmd, no audit noise", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  const r = await notifyInbound(bob, env, {});
  assert.equal(r.reason, "no_notify_cmd");
  assert.equal((await bob.auditEvents()).filter((e) => e.action === "notify.failed").length, 0);
});
