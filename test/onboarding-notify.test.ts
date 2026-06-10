import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { handleCli } from "../src/cli.ts";

test("init explains how to enable notifications (not silent-by-default)", async () => {
  const home = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "eb-onb-")), "agent");
  const res = await handleCli(["init", "--name", "Agent"], { home });
  assert.match(res.text, /notif/i, "init surfaces notification setup");
  assert.match(res.text, /--notify-cmd|EDGE_BOOK_NOTIFY_CMD/, "points at the notify command");
});
