// spec-130: one-time handle nudge for already-onboarded agents whose identity
// still carries the placeholder handle, plus the onboarding handle-step guard.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { buildOnboardingNote } from "../src/onboarding.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-handle-nudge-test-"));
}

test("friend pending nudges once when the handle is the placeholder, then never again", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--name", "Scout Agent"]);

  const first = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(first.text.includes("handle set"), "first run must carry the handle nudge");
  assert.ok(first.text.includes("scout-agent"), "nudge must suggest the slugified agent name");

  const config = await new EdgeBookStore({ home }).config();
  assert.ok(typeof config.handle_nudge_at === "number", "handle_nudge_at must be recorded on emit");

  const second = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(!second.text.includes("handle set"), "nudge must not repeat after the first emit");
});

test("no nudge when a real handle is already set", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent"]);
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(!result.text.includes("handle set"), "agents with a real handle must not be nudged");
  const config = await new EdgeBookStore({ home }).config();
  assert.equal(config.handle_nudge_at, undefined, "no nudge marker may be written");
});

test("nudge also fires on the feed-review commands (ephemeral)", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--name", "Scout Agent"]);
  const result = await handleCli(["ephemeral", "--home", home]);
  assert.ok(result.text.includes("handle set"), "ephemeral must carry the nudge too");
});

test("nudge path never throws on an uninitialized home", async () => {
  const home = await tempRoot();
  // `friend pending` itself works against an empty store; the nudge hook must
  // swallow the missing-identity error rather than break the command.
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes("No pending friend requests"), "command output must survive");
  assert.ok(!result.text.includes("handle set"), "no identity → no nudge");
});

test("onboarding note and onboard.md both carry the handle step", async () => {
  const note = buildOnboardingNote();
  assert.ok(note.includes("handle set"), "init handoff note must mention the handle step");
  const promptPath = new URL("../skills/edge-book/prompts/onboard.md", import.meta.url);
  const text = await fs.readFile(promptPath, "utf8");
  assert.ok(text.includes("handle set"), "onboard.md must instruct the agent to set a handle");
});
