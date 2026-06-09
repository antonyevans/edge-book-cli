import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { handleCli } from "../src/cli.ts";

async function home(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-cli-"));
}

test("profile set --bio --social and visibility round-trips via show", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h }); // init --name = agent display_name (unchanged)
  await handleCli(["profile", "set", "--name", "Alice", "--bio", "Builder", "--social", "telegram=@alice"], { home: h }); // profile set --name = human name
  await handleCli(["profile", "visibility", "bio=off", "telegram=public"], { home: h });
  const res = await handleCli(["profile", "show"], { home: h });
  const j = res.json as any;
  assert.equal(j.display_name, "Agent A");
  assert.equal(j.name, "Alice");
  assert.equal(j.visibility.bio, "off");
  assert.equal(j.visibility.telegram, "public");
  assert.deepEqual(j.socials, [{ label: "telegram", value: "@alice" }]);
});
