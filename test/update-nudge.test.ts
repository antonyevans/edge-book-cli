// spec-142 heartbeat update nudge: for cron-less agents, the heartbeat-read
// commands carry a short "update available" notice when a newer version is
// known and config asks for notify (or auto cannot apply: cross-major drift).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { UPDATE_NUDGE_THROTTLE_MS, maybeAppendUpdateNudge } from "../src/update-nudge.ts";

const NUDGE_MARKER = "update available";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-update-nudge-test-"));
}

async function initHome(): Promise<string> {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  // Pre-ack the spec-141 notifier nudge so its text never shadows this one.
  await handleCli(["ensure-notifier", "--ack", "--home", home]);
  return home;
}

test("nudge appears on drift under notify, pointing at self-update", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  await store.updateConfig({ auto_update: "notify", update_latest_known: "99.0.0" });
  const result = await maybeAppendUpdateNudge(store, "friend", { text: "No pending friend requests." }, Date.now(), "0.17.0");
  assert.ok(result.text.includes(NUDGE_MARKER), "drift + notify must nudge");
  assert.ok(result.text.includes(`self-update --home ${home}`), "nudge must carry the exact command");
  assert.ok(typeof (await store.config()).update_nudge_at === "number", "emit timestamp recorded");
});

test("nudge is throttled to one emit per 24h", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await store.updateConfig({ auto_update: "notify", update_latest_known: "99.0.0" });
  const base = Date.now();
  const wrapped = { text: "x" };
  const first = await maybeAppendUpdateNudge(store, "friend", wrapped, base, "0.17.0");
  assert.ok(first.text.includes(NUDGE_MARKER));
  const inside = await maybeAppendUpdateNudge(store, "friend", wrapped, base + UPDATE_NUDGE_THROTTLE_MS - 1, "0.17.0");
  assert.ok(!inside.text.includes(NUDGE_MARKER), "inside the 24h window: silent");
  const outside = await maybeAppendUpdateNudge(store, "friend", wrapped, base + UPDATE_NUDGE_THROTTLE_MS + 1, "0.17.0");
  assert.ok(outside.text.includes(NUDGE_MARKER), "past the window it re-emits");
});

test("nudge retires when current (running >= latest known)", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await store.updateConfig({ auto_update: "notify", update_latest_known: "0.17.0" });
  const same = await maybeAppendUpdateNudge(store, "friend", { text: "x" }, Date.now(), "0.17.0");
  assert.ok(!same.text.includes(NUDGE_MARKER), "current → no nudge");
  const ahead = await maybeAppendUpdateNudge(store, "friend", { text: "x" }, Date.now(), "0.18.0");
  assert.ok(!ahead.text.includes(NUDGE_MARKER), "ahead of latest known → no nudge");
});

test("nudge is absent under off and under auto (same-major drift: the cron path owns it)", async () => {
  for (const mode of ["off", "auto"] as const) {
    const store = new EdgeBookStore({ home: await initHome() });
    await store.updateConfig({ auto_update: mode, update_latest_known: "0.99.0" });
    const result = await maybeAppendUpdateNudge(store, "friend", { text: "x" }, Date.now(), "0.17.0");
    assert.ok(!result.text.includes(NUDGE_MARKER), `auto_update=${mode} must not nudge`);
  }
});

test("cross-major drift under auto downgrades to the nudge (post-1.0 semantics)", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  await store.updateConfig({ auto_update: "auto", update_latest_known: "2.0.0" });
  const result = await maybeAppendUpdateNudge(store, "friend", { text: "x" }, Date.now(), "1.2.0");
  assert.ok(result.text.includes(NUDGE_MARKER), "cross-major under auto → nudge, not silent auto-update");
});

test("default auto_update (unset) behaves as auto: no nudge on same-major drift", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await store.updateConfig({ update_latest_known: "0.99.0" });
  const result = await maybeAppendUpdateNudge(store, "friend", { text: "x" }, Date.now(), "0.17.0");
  assert.ok(!result.text.includes(NUDGE_MARKER));
});

test("only heartbeat-read commands are nudged; uninitialized homes stay silent", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await store.updateConfig({ auto_update: "notify", update_latest_known: "99.0.0" });
  const card = await maybeAppendUpdateNudge(store, "card", { text: "x" }, Date.now(), "0.17.0");
  assert.ok(!card.text.includes(NUDGE_MARKER), "non-nudge command: silent");
  const empty = new EdgeBookStore({ home: await tempRoot() });
  const bare = await maybeAppendUpdateNudge(empty, "friend", { text: "x" }, Date.now(), "0.17.0");
  assert.ok(!bare.text.includes(NUDGE_MARKER), "no identity → no nudge, no throw");
});

test("nudge rides the heartbeat-read commands through handleCli", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  await store.updateConfig({ auto_update: "notify", update_latest_known: "99.0.0" });
  const result = await handleCli(["friend", "pending", "--home", home]);
  assert.ok(result.text.includes(NUDGE_MARKER), "friend pending must carry the update nudge");
});

test("machine surfaces stay exempt: friend auto-accept output is pure JSON (spec-132 ruling)", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "greeter", "--name", "Greeter Agent", "--no-greeter"]);
  await handleCli(["greeter", "--on", "--home", home]);
  const store = new EdgeBookStore({ home });
  await store.updateConfig({ auto_update: "notify", update_latest_known: "99.0.0" });
  const result = await handleCli(["friend", "auto-accept", "--home", home]);
  assert.doesNotThrow(() => JSON.parse(result.text), "text must parse as pure JSON");
  assert.ok(!result.text.includes(NUDGE_MARKER));
});
