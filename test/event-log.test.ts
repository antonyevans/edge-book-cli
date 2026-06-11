import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore } from "../src/edge-book.ts";
import { COMPACT_KEEP_LINES, MAX_EVENT_LINES, lastEvent, logEvent, readEvents } from "../src/event-log.ts";
import { EVENTS_FILE } from "../src/store-files.ts";

async function tempStore(): Promise<EdgeBookStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-event-log-"));
  return new EdgeBookStore({ home: root });
}

test("logEvent appends NDJSON records readable in order with ts/kind/fields", async () => {
  const store = await tempStore();
  await logEvent(store, "envelope.sent", { envelope_kind: "friend_request", to: "agent_x", dedup_key: "msg_1" });
  await logEvent(store, "dialout.connected", { host: "wss://example/agent/ws" });

  const events = await readEvents(store);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "envelope.sent");
  assert.equal(events[0].envelope_kind, "friend_request");
  assert.equal(events[0].dedup_key, "msg_1");
  assert.match(String(events[0].ts), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(events[1].kind, "dialout.connected");

  // readEvents honours the tail limit (newest kept).
  const tail = await readEvents(store, 1);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].kind, "dialout.connected");
});

test("ring buffer cap: exceeding maxLines rewrites keeping the newest keepLines", async () => {
  const store = await tempStore();
  const caps = { maxLines: 20, keepLines: 10 };
  for (let i = 0; i < 25; i++) {
    await logEvent(store, "tick", { seq: i }, caps);
  }
  const text = await fs.readFile(store.file(EVENTS_FILE), "utf8");
  const lines = text.split("\n").filter(Boolean);
  // Compaction fires when the file EXCEEDS maxLines (at 21 lines → keep 10),
  // then grows by appends until the next overflow. Never above maxLines + 1
  // transiently, and the newest event is always last.
  assert.ok(lines.length <= caps.maxLines, `expected <= ${caps.maxLines} lines, got ${lines.length}`);
  const events = await readEvents(store);
  assert.equal(events[events.length - 1].seq, 24, "newest event survives compaction");
  // The oldest events are gone.
  assert.ok((events[0].seq as number) > 0, "oldest events evicted");
});

test("default caps are the documented constants", () => {
  assert.equal(MAX_EVENT_LINES, 2000);
  assert.equal(COMPACT_KEEP_LINES, 1000);
});

test("readEvents tolerates corrupt and partial lines", async () => {
  const store = await tempStore();
  await logEvent(store, "good.one", {});
  await fs.appendFile(store.file(EVENTS_FILE), "{not json at all\n", "utf8");
  await fs.appendFile(store.file(EVENTS_FILE), '"a bare string"\n', "utf8");
  await logEvent(store, "good.two", {});
  // Partial trailing line (concurrent-append simulation).
  await fs.appendFile(store.file(EVENTS_FILE), '{"ts":"2026-06-10T00:00:00Z","ki', "utf8");

  const events = await readEvents(store);
  assert.deepEqual(events.map((e) => e.kind), ["good.one", "good.two"]);
});

test("lastEvent returns the newest matching kind (exact and prefix)", async () => {
  const store = await tempStore();
  await logEvent(store, "dialout.connected", { host: "a" });
  await logEvent(store, "dialout.disconnected", {});
  await logEvent(store, "dialout.connected", { host: "b" });

  assert.equal((await lastEvent(store, "dialout.connected"))?.host, "b");
  assert.equal((await lastEvent(store, "dialout."))?.kind, "dialout.connected");
  assert.equal(await lastEvent(store, "missing.kind"), undefined);
});

test("logEvent never throws, even when the events path is unwritable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-event-log-bad-"));
  // Make <home> a FILE so mkdir/appendFile inside it must fail.
  const bogusHome = path.join(root, "not-a-dir");
  await fs.writeFile(bogusHome, "i am a file", "utf8");
  const store = new EdgeBookStore({ home: bogusHome });
  await assert.doesNotReject(logEvent(store, "anything", { a: 1 }));
  assert.deepEqual(await readEvents(store), []);
});

test("events.ndjson lives in the agent home alongside the other stores", async () => {
  const store = await tempStore();
  await logEvent(store, "x", {});
  const stat = await fs.stat(path.join(store.home, "events.ndjson"));
  assert.ok(stat.isFile());
});
