import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCli } from "../src/cli.ts";
import { buildDoctorReport, renderDoctorText } from "../src/doctor.ts";
import type { DoctorReport } from "../src/doctor.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import type { HermesRunner } from "../src/host-cron.ts";

// A relay base derived from this never resolves — exercises offline grace fast.
const DEAD_HOST = "ws://127.0.0.1:9/agent/ws";

const SECRET_BODY = "SECRET-BODY-MARKER-must-never-leak-9f2c";

const okFetch = (async () => ({ status: 200 })) as unknown as typeof fetch;
const noHermes: HermesRunner = { hermesBin: null, list: () => "", create: () => undefined };

// Seed a store the way a real agent ends up: one confirmed friend who sent a
// privileged message with a known body, one pending friend request, one post.
async function seededStore(): Promise<{ bob: EdgeBookStore; bobId: string; carolId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-doctor-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const carol = new EdgeBookStore({ home: path.join(root, "carol") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  const bobIdentity = await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  const carolIdentity = await carol.init({ handle: "carol.openclaw.local", displayName: "Carol Agent" });
  const bobCard = await bob.writeCard();

  // Alice ↔ Bob become friends; Alice sends a privileged message with a known body.
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const response = await bob.acceptFriend((await alice.identity()).agent_id);
  await alice.applyFriendResponse(response);
  const message = await alice.sendPrivilegedMessage(bobIdentity.agent_id, { text: SECRET_BODY });
  await bob.receivePrivilegedMessage(message);

  // Carol's request stays pending on Bob.
  await bob.receiveFriendRequest(await carol.createFriendRequest(bobCard));

  // Bob drafts a post with the same marker body.
  await bob.createPost({ title: "draft", body: SECRET_BODY });

  return { bob, bobId: bobIdentity.agent_id, carolId: carolIdentity.agent_id };
}

test("doctor report covers version, identity, relay, friends, stores, and events", async () => {
  const { bob, bobId, carolId } = await seededStore();
  const report = await buildDoctorReport(bob, { host: DEAD_HOST, fetchImpl: okFetch, hermesRunner: noHermes });

  const pkg = JSON.parse(await fs.readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.equal(report.version, pkg.version);
  assert.equal(report.pass, true, "legacy store check still passes");
  assert.equal(report.card_valid, true);

  assert.equal(report.identity?.fingerprint, bobId);
  assert.equal(report.identity?.handle, "bob.openclaw.local");

  assert.equal(report.relay.reachable, true);
  assert.equal(report.relay.status, 200);
  assert.equal(typeof report.relay.latency_ms, "number");

  assert.equal(report.friends.pending_requests, 1);
  assert.equal(report.friends.pending[0].from, carolId);
  assert.equal(report.friends.pending[0].display_name, "Carol Agent");

  assert.equal(report.stores.friends, 1);
  assert.equal(report.stores.contacts, 2);
  assert.equal(report.stores.posts, 1);
  assert.equal(report.notify.notify_cmd_configured, false);
  assert.equal(report.notify.notifier_cron, "host_unsupported");
  assert.equal(report.dialout.key_present, false);

  // The friend flows above were recorded by the flight recorder.
  const kinds = report.events.map((e) => e.kind);
  assert.ok(kinds.includes("friend.request_received"), `events missing friend.request_received: ${kinds.join(",")}`);
  assert.ok(kinds.includes("friend.accepted"), `events missing friend.accepted: ${kinds.join(",")}`);
  assert.ok(kinds.includes("friend.state_changed"));
  assert.ok(report.audit.some((e) => e.kind === "message.receive"), "audit tail includes sanitized audit records");
});

test("doctor bundle is safe to paste publicly: no private keys, no message/post bodies", async () => {
  const { bob } = await seededStore();
  const report = await buildDoctorReport(bob, { host: DEAD_HOST, fetchImpl: okFetch, hermesRunner: noHermes });
  const identity = await bob.identity();

  for (const blob of [JSON.stringify(report), renderDoctorText(report)]) {
    assert.ok(!blob.includes(SECRET_BODY), "message/post body leaked into doctor output");
    assert.ok(!blob.includes("PRIVATE KEY"), "PEM private key header leaked into doctor output");
    // Every base64 line of the private key PEM must be absent too.
    for (const line of identity.private_key_pem.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("-----")) continue;
      assert.ok(!blob.includes(trimmed), "private key material leaked into doctor output");
    }
  }
});

test("doctor degrades gracefully when the relay is unreachable", async () => {
  const { bob } = await seededStore();
  const report = await buildDoctorReport(bob, { host: DEAD_HOST, timeoutMs: 1500, hermesRunner: noHermes });
  assert.equal(report.relay.reachable, false);
  assert.ok(report.relay.error, "offline check reports an error string");
  assert.equal(report.relay.url, "http://127.0.0.1:9");
  // The rest of the report still renders.
  assert.equal(report.identity?.handle, "bob.openclaw.local");
  assert.ok(renderDoctorText(report).includes("reachable: NO"));
});

test("doctor handles an uninitialized home without throwing", async () => {
  const empty = new EdgeBookStore({ home: await fs.mkdtemp(path.join(os.tmpdir(), "eb-doctor-empty-")) });
  const report = await buildDoctorReport(empty, { host: DEAD_HOST, fetchImpl: okFetch, hermesRunner: noHermes });
  assert.equal(report.initialized, false);
  assert.equal(report.identity, null);
  assert.equal(report.pass, false);
  assert.ok(renderDoctorText(report).includes("not initialized"));
});

test("CLI doctor: human text by default, full JSON with --json", async () => {
  const { bob } = await seededStore();

  const text = await handleCli(["doctor", "--home", bob.home, "--host", DEAD_HOST]);
  assert.ok(text.text.startsWith("Edge Book doctor — v"), "default output is human-readable");
  assert.ok(text.text.includes("Friend requests"));
  assert.ok(text.text.includes("Event log"));
  assert.ok(text.text.includes("Audit log"));
  assert.ok(!text.text.includes(SECRET_BODY));

  const asJson = await handleCli(["doctor", "--home", bob.home, "--host", DEAD_HOST, "--json"]);
  const parsed = JSON.parse(asJson.text) as DoctorReport;
  assert.equal(parsed.identity?.handle, "bob.openclaw.local");
  assert.equal(parsed.friends.pending_requests, 1);
  assert.ok(Array.isArray(parsed.events));
  assert.ok(parsed.events.length <= 50);
  assert.ok(Array.isArray(parsed.audit));
  assert.ok(parsed.audit.length <= 20);
});
