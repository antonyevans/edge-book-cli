// spec-141: notifier prompt migration nudge — recurring (6h-throttled,
// uncapped) reminder on the heartbeat-read commands while the scheduler still
// runs a prompt older than NOTIFIER_PROMPT_VERSION, retiring only on ack.
// Where the hermes shell CLI is detected, the mechanical spec-139 path owns
// migration and the nudge stays silent.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { NOTIFIER_PROMPT_VERSION, buildFriendRequestsPrompt } from "../src/host-cron.ts";
import {
  NOTIFIER_NUDGE_THROTTLE_MS,
  maybeAppendNotifierNudge,
} from "../src/notifier-nudge.ts";

const NUDGE_MARKER = "outdated prompt";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-notifier-nudge-test-"));
}

async function initHome(): Promise<string> {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  return home;
}

test("friend pending carries the migration nudge when un-acked and no hermes CLI", async () => {
  const home = await initHome();
  // Test machines have no /opt/hermes — default detection reports no CLI.
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes(NUDGE_MARKER), "heartbeat read must carry the migration nudge");
  assert.ok(result.text.includes(`ensure-notifier --print-prompt --home ${home}`), "nudge must point at --print-prompt");
  assert.ok(result.text.includes(`ensure-notifier --ack --home ${home}`), "nudge must point at --ack");
  assert.ok(result.text.includes("*/20 * * * *"), "nudge must carry the create-if-missing schedule");
  const config = await new EdgeBookStore({ home }).config();
  assert.ok(typeof config.notifier_nudge_at === "number", "emit timestamp must be recorded");
});

test("ephemeral carries the migration nudge too", async () => {
  const home = await initHome();
  const result = await handleCli(["ephemeral", "--home", home]);
  assert.ok(result.text.includes(NUDGE_MARKER), "ephemeral must carry the migration nudge");
});

test("nudge is throttled to one emit per 6h and has no emit cap", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  const base = Date.now();
  const result = { text: "No pending friend requests." };
  const noCli = () => false;

  const first = await maybeAppendNotifierNudge(store, "friend", result, base, noCli);
  assert.ok(first.text.includes(NUDGE_MARKER), "first read must nudge");
  const inside = await maybeAppendNotifierNudge(store, "friend", result, base + NOTIFIER_NUDGE_THROTTLE_MS - 1, noCli);
  assert.ok(!inside.text.includes(NUDGE_MARKER), "inside the throttle window must stay silent");

  // No cap (unlike spec-137): well past any 3-emit ceiling it still nudges.
  let emits = 1;
  for (let i = 1; i <= 5; i++) {
    const now = base + i * (NOTIFIER_NUDGE_THROTTLE_MS + 1);
    const wrapped = await maybeAppendNotifierNudge(store, "friend", result, now, noCli);
    if (wrapped.text.includes(NUDGE_MARKER)) emits += 1;
  }
  assert.equal(emits, 6, "nudge must re-emit every window with no cap");
});

test("nudge stays silent when the hermes shell CLI is detected", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  const result = { text: "No pending friend requests." };
  const wrapped = await maybeAppendNotifierNudge(store, "friend", result, Date.now(), () => true);
  assert.ok(!wrapped.text.includes(NUDGE_MARKER), "hermes CLI detected → mechanical path owns migration");
  const config = await store.config();
  assert.equal(config.notifier_nudge_at, undefined, "no emit marker may be written when the CLI owns it");
});

test("nudge stays silent on non-nudge commands", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  const result = { text: "card written" };
  const wrapped = await maybeAppendNotifierNudge(store, "card", result, Date.now(), () => false);
  assert.ok(!wrapped.text.includes(NUDGE_MARKER), "only heartbeat-read commands are nudged");
});

test("nudge path never throws on an uninitialized home", async () => {
  const home = await tempRoot();
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes("No pending friend requests"), "command output must survive");
  assert.ok(!result.text.includes(NUDGE_MARKER), "no identity → no nudge");
});

test("ensure-notifier --ack persists the current prompt version and retires the nudge permanently", async () => {
  const home = await initHome();
  const ack = await handleCli(["ensure-notifier", "--ack", "--home", home]);
  assert.ok(ack.text.includes(String(NOTIFIER_PROMPT_VERSION)), "ack output must name the version");
  const store = new EdgeBookStore({ home });
  assert.equal((await store.config()).notifier_prompt_ack, NOTIFIER_PROMPT_VERSION, "--ack must persist the version");

  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(!result.text.includes(NUDGE_MARKER), "acked → no nudge via handleCli");
  // Directly past every throttle window too: ack retires it for good.
  const later = await maybeAppendNotifierNudge(store, "friend", { text: "x" }, Date.now() + 10 * NOTIFIER_NUDGE_THROTTLE_MS, () => false);
  assert.ok(!later.text.includes(NUDGE_MARKER), "acked → never nudges again");
});

test("ensure-notifier --print-prompt prints exactly the canonical prompt", async () => {
  const home = await initHome();
  const result = await handleCli(["ensure-notifier", "--print-prompt", "--home", home]);
  assert.equal(result.text, buildFriendRequestsPrompt(home), "no decoration — paste-ready for the scheduler tool");
});

test("friend auto-accept stays nudge-exempt (spec-132 machine surface)", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "greeter", "--name", "Greeter Agent", "--no-greeter"]);
  await handleCli(["greeter", "--on", "--home", home]);
  const result = await handleCli(["friend", "auto-accept", "--home", home]);
  assert.doesNotThrow(() => JSON.parse(result.text), "text must parse as pure JSON, no trailing prose");
  assert.ok(!result.text.includes(NUDGE_MARKER), "no migration nudge on machine output");
});

test("nudge composes with the onboarding and handle nudges in one output", async () => {
  const home = await tempRoot();
  // Placeholder handle (no --handle) + empty room → spec-130 + spec-137 fire too.
  await handleCli(["init", "--home", home, "--name", "Scout Agent", "--no-greeter"]);
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes("handle set"), "handle nudge must still fire");
  assert.ok(result.text.includes("Onboarding incomplete"), "onboarding nudge must still fire");
  assert.ok(result.text.includes(NUDGE_MARKER), "migration nudge must fire in the same output");
});

test("spec-142: an ack at v2 re-nudges under prompt v3 (the rollout vehicle)", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  await store.updateConfig({ notifier_prompt_ack: 2 });
  const result = await maybeAppendNotifierNudge(store, "friend", { text: "x" }, Date.now(), () => false);
  assert.ok(result.text.includes(NUDGE_MARKER), "ack below NOTIFIER_PROMPT_VERSION must nudge again");
});
