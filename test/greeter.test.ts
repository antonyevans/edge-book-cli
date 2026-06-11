// spec-132: greeter agent — toggle, auto-accept pass, welcome share, candidate seeding.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-greeter-test-"));
}

test("greeter --on sets greeter_mode true; greeter --off sets it false", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--name", "Greeter Agent"]);
  const on = await handleCli(["greeter", "--on", "--home", home]);
  assert.equal((on.json as { greeter_mode?: boolean }).greeter_mode, true);
  assert.ok(on.text.includes("greeter_mode = true"));
  assert.equal((await new EdgeBookStore({ home }).config()).greeter_mode, true);
  const off = await handleCli(["greeter", "--off", "--home", home]);
  assert.equal((off.json as { greeter_mode?: boolean }).greeter_mode, false);
  assert.equal((await new EdgeBookStore({ home }).config()).greeter_mode, false);
});

test("greeter with both flags or neither flag errors", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await assert.rejects(
    () => handleCli(["greeter", "--on", "--off", "--home", home]),
    (e: unknown) => e instanceof EdgeBookError && e.code === "bad_flags",
  );
  await assert.rejects(
    () => handleCli(["greeter", "--home", home]),
    (e: unknown) => e instanceof EdgeBookError && e.code === "missing_arg",
  );
});

test("updateConfig persists greeter_welcome_object_id", async () => {
  const home = await tempRoot();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "g.openclaw.local" });
  await store.updateConfig({ greeter_welcome_object_id: "obj-test-123" });
  assert.equal((await store.config()).greeter_welcome_object_id, "obj-test-123");
  // Unrelated updates must not clobber it (explicit field-copy in updateConfig).
  await store.updateConfig({ notify_on_friend_request: true });
  assert.equal((await store.config()).greeter_welcome_object_id, "obj-test-123");
});

import { runGreeterPass, greeterWelcomeKey, GREETER_WELCOME_TITLE, GREETER_WELCOME_BODY } from "../src/store-greeter.ts";

async function makeAgent(root: string, name: string) {
  const home = path.join(root, name);
  const store = new EdgeBookStore({ home });
  await store.init({ handle: `${name}.openclaw.local`, displayName: name });
  const card = await store.writeCard();
  return { home, store, card };
}

// A greeter store with n inbound requests sitting in request_received.
async function greeterWithPending(n: number) {
  const root = await tempRoot();
  const greeter = await makeAgent(root, "greeter");
  const requesters: Awaited<ReturnType<typeof makeAgent>>[] = [];
  for (let i = 0; i < n; i++) {
    const r = await makeAgent(root, `newbie${i}`);
    const env = await r.store.createFriendRequest(greeter.card);
    await greeter.store.receiveFriendRequest(env);
    requesters.push(r);
  }
  return { greeter, requesters };
}

test("runGreeterPass without greeter_mode → greeter_mode_required, nothing accepted", async () => {
  const { greeter, requesters } = await greeterWithPending(1);
  await assert.rejects(
    () => runGreeterPass(greeter.store),
    (e: unknown) => e instanceof EdgeBookError && e.code === "greeter_mode_required",
  );
  const contact = (await greeter.store.contacts())[requesters[0].card.agent_id];
  assert.equal(contact.relationship_state, "request_received", "gate must accept nothing");
});

test("two pending → both friend, one welcome object, two shares of the same object, ledger keys recorded", async () => {
  const { greeter, requesters } = await greeterWithPending(2);
  await greeter.store.updateConfig({ greeter_mode: true });
  const entries = await runGreeterPass(greeter.store);
  assert.equal(entries.length, 2);
  const welcomeId = (await greeter.store.config()).greeter_welcome_object_id;
  assert.ok(welcomeId, "welcome object id persisted to config");
  for (const r of requesters) {
    const entry = entries.find((e) => e.agent_id === r.card.agent_id);
    assert.ok(entry, `entry for ${r.card.agent_id}`);
    assert.equal(entry.accepted, true);
    assert.equal(entry.welcomed, true);
    assert.equal(entry.accept_envelope?.type, "friend_response");
    assert.equal(entry.share_envelope?.type, "object_share");
    assert.equal(entry.share_envelope?.ref, welcomeId, "both shares reference the same object");
    assert.equal((await greeter.store.contacts())[r.card.agent_id].relationship_state, "friend");
    assert.equal(await greeter.store.wasNotified(greeterWelcomeKey(r.card.agent_id)), true);
  }
  assert.equal(Object.keys(await greeter.store.objects()).length, 1, "welcome object exists exactly once");
});

test("partial-failure re-run: ledger has <a> but not <b> → only <b> gets the welcome share", async () => {
  const { greeter, requesters } = await greeterWithPending(2);
  await greeter.store.updateConfig({ greeter_mode: true });
  const [a, b] = requesters;
  await greeter.store.recordNotified(greeterWelcomeKey(a.card.agent_id));
  const entries = await runGreeterPass(greeter.store);
  const entryA = entries.find((e) => e.agent_id === a.card.agent_id)!;
  const entryB = entries.find((e) => e.agent_id === b.card.agent_id)!;
  assert.equal(entryA.accepted, true);
  assert.equal(entryA.welcomed, false, "a is in the ledger — no double-send");
  assert.equal(entryA.share_envelope, undefined);
  assert.equal(entryB.accepted, true);
  assert.equal(entryB.welcomed, true);
  assert.equal(entryB.share_envelope?.type, "object_share");
});

test("crash recovery: an already-accepted friend missing its ledger key is welcomed on the next pass", async () => {
  const { greeter, requesters } = await greeterWithPending(1);
  await greeter.store.updateConfig({ greeter_mode: true });
  // Simulate a crash between accept and welcome on a prior pass: friend, no ledger key.
  await greeter.store.acceptFriend(requesters[0].card.agent_id);
  const entries = await runGreeterPass(greeter.store);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].accepted, false, "no re-accept of an existing friend");
  assert.equal(entries[0].welcomed, true);
  assert.equal(entries[0].share_envelope?.type, "object_share");
});

test("a second pass is a no-op (idempotent)", async () => {
  const { greeter } = await greeterWithPending(1);
  await greeter.store.updateConfig({ greeter_mode: true });
  await runGreeterPass(greeter.store);
  assert.deepEqual(await runGreeterPass(greeter.store), []);
});

test("welcome copy avoids infrastructure vocabulary", () => {
  assert.equal(GREETER_WELCOME_TITLE, "Welcome to Edge Book");
  const text = `${GREETER_WELCOME_TITLE}\n${GREETER_WELCOME_BODY}`;
  for (const banned of ["Hermes", "mailbox", "envelope", "relay", "DID"]) {
    assert.ok(!text.includes(banned), `banned infrastructure word in welcome copy: ${banned}`);
  }
  assert.ok(!/\bgrants?\b/i.test(text), "grant-as-noun is banned in welcome copy");
});

test("CLI: friend auto-accept without greeter_mode → greeter_mode_required", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await assert.rejects(
    () => handleCli(["friend", "auto-accept", "--home", home]),
    (e: unknown) => e instanceof EdgeBookError && e.code === "greeter_mode_required",
  );
});

test("CLI: friend auto-accept returns JSON [{agent_id, accepted, welcomed}] for cron logs", async () => {
  const { greeter, requesters } = await greeterWithPending(1);
  await handleCli(["greeter", "--on", "--home", greeter.home]);
  const result = await handleCli(["friend", "auto-accept", "--home", greeter.home]);
  const json = result.json as Array<{ agent_id: string; accepted: boolean; welcomed: boolean }>;
  assert.equal(json.length, 1);
  assert.deepEqual(json[0], { agent_id: requesters[0].card.agent_id, accepted: true, welcomed: true });
  assert.deepEqual(JSON.parse(result.text), json, "text output is the same JSON (cron-log friendly)");
  // The pass really ran: contact is friend, welcome object pinned.
  assert.equal((await greeter.store.contacts())[requesters[0].card.agent_id].relationship_state, "friend");
  assert.ok((await greeter.store.config()).greeter_welcome_object_id);
});

test("CLI: friend auto-accept output stays pure JSON even when the handle nudge would fire", async () => {
  // Fresh init leaves the placeholder handle, so the spec-130 nudge would
  // normally append prose to `friend` output. auto-accept is exempt
  // (spec-132 ruling): its text output is a machine-readable cron-log
  // contract — the nudge belongs to human conversation surfaces.
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--name", "Greeter Agent"]);
  await handleCli(["greeter", "--on", "--home", home]);
  const result = await handleCli(["friend", "auto-accept", "--home", home]);
  assert.doesNotThrow(() => JSON.parse(result.text), "text must parse as pure JSON, no trailing prose");
  assert.ok(!result.text.includes("handle set"), "no handle nudge on machine output");
  // The exemption must not consume the one-time nudge: a human-surface
  // command afterwards still gets it.
  const pending = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(pending.text.includes("handle set"), "nudge still fires on human surfaces");
});

test("CLI: friend auto-accept with nothing pending returns an empty list", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await handleCli(["greeter", "--on", "--home", home]);
  const result = await handleCli(["friend", "auto-accept", "--home", home]);
  assert.deepEqual(result.json, []);
  assert.equal(result.text.trim(), "[]");
});
