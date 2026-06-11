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
