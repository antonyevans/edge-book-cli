// spec-137: durable onboarding nudge — recurring (throttled, capped) reminder
// on the heartbeat-read commands while the room is still empty, retiring the
// moment the first contact or object appears.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import {
  ONBOARDING_NUDGE_MAX_EMITS,
  ONBOARDING_NUDGE_THROTTLE_MS,
  maybeAppendOnboardingNudge,
} from "../src/onboarding-nudge.ts";

const NUDGE_MARKER = "Onboarding incomplete";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-onboarding-nudge-test-"));
}

test("friend pending carries the onboarding nudge while the room is empty, throttled on repeat", async () => {
  const home = await tempRoot();
  // Real handle so the spec-130 handle nudge stays out of the assertions.
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);

  const first = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(first.text.includes(NUDGE_MARKER), "first heartbeat read must carry the onboarding nudge");
  assert.ok(first.text.includes("onboard.md"), "nudge must point at the onboarding script");

  const config = await new EdgeBookStore({ home }).config();
  assert.ok(typeof config.onboarding_nudge_at === "number", "emit timestamp must be recorded");
  assert.equal(config.onboarding_nudge_count, 1, "emit count must be recorded");

  const second = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(!second.text.includes(NUDGE_MARKER), "nudge must be throttled on an immediate repeat");
});

test("nudge re-emits after the throttle window and stops at the cap", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  const store = new EdgeBookStore({ home });
  const base = Date.now();
  const result = { text: "No pending friend requests." };

  let emits = 0;
  for (let i = 0; i < ONBOARDING_NUDGE_MAX_EMITS + 2; i++) {
    const now = base + i * (ONBOARDING_NUDGE_THROTTLE_MS + 1);
    const wrapped = await maybeAppendOnboardingNudge(store, "friend", result, now);
    if (wrapped.text.includes(NUDGE_MARKER)) emits += 1;
  }
  assert.equal(emits, ONBOARDING_NUDGE_MAX_EMITS, "nudge must stop after the emit cap");
});

test("nudge retires once the room is no longer empty", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  const store = new EdgeBookStore({ home });
  await store.createObject({ title: "hello", body: "first share draft" });

  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(!result.text.includes(NUDGE_MARKER), "a non-empty room must not be nudged");
  const config = await store.config();
  assert.equal(config.onboarding_nudge_at, undefined, "no emit marker may be written for a non-empty room");
});

test("ephemeral carries the nudge too", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  const result = await handleCli(["ephemeral", "--home", home]);
  assert.ok(result.text.includes(NUDGE_MARKER), "ephemeral must carry the onboarding nudge");
});

test("nudge path never throws on an uninitialized home", async () => {
  const home = await tempRoot();
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes("No pending friend requests"), "command output must survive");
  assert.ok(!result.text.includes(NUDGE_MARKER), "no identity → no nudge");
});

test("nudge composes with the handle nudge without suppressing it", async () => {
  const home = await tempRoot();
  // Placeholder handle → spec-130 nudge fires once alongside spec-137.
  await handleCli(["init", "--home", home, "--name", "Scout Agent", "--no-greeter"]);
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes("handle set"), "handle nudge must still fire");
  assert.ok(result.text.includes(NUDGE_MARKER), "onboarding nudge must fire in the same output");
});
