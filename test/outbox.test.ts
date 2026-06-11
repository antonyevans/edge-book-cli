import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OUTBOX_CAP, formatAge, readOutbox, recordOutboxEntry, staleQueueMs } from "../src/store-outbox.ts";

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-outbox-"));
}

// ── spec-097 C.1: outbox ledger ──────────────────────────────────────────────

test("recordOutboxEntry appends in order and readOutbox round-trips, including recipient_live", async () => {
  const home = await tempHome();
  await recordOutboxEntry(home, { id: "m0", to_agent_id: "did:openclaw:peer", envelope_type: "friend_request", recipient_live: false });
  await recordOutboxEntry(home, { id: "m1", to_agent_id: "did:openclaw:peer", envelope_type: "object_share", recipient_live: true });
  await recordOutboxEntry(home, { id: "m2", to_agent_id: "did:openclaw:peer", envelope_type: "object_share" }); // old host: no recipient_live
  const entries = await readOutbox(home);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.id, "m0");
  assert.equal(entries[0]!.recipient_live, false);
  assert.equal(entries[1]!.recipient_live, true);
  assert.ok(!("recipient_live" in entries[2]!), "absent field stays absent (old-host send)");
  assert.ok(entries[2]!.sent_at, "sent_at stamped");
  // outbox.json is a sibling of identity.json in the agent home.
  await fs.access(path.join(home, "outbox.json"));
});

test("outbox cap: the 201st entry evicts the oldest (drop-front)", async () => {
  const home = await tempHome();
  for (let i = 0; i <= OUTBOX_CAP; i++) {
    await recordOutboxEntry(home, { id: `m${i}`, to_agent_id: "did:openclaw:peer", envelope_type: "object_share" });
  }
  const entries = await readOutbox(home);
  assert.equal(entries.length, OUTBOX_CAP);
  assert.equal(entries[0]!.id, "m1", "m0 dropped from the front");
  assert.equal(entries[OUTBOX_CAP - 1]!.id, `m${OUTBOX_CAP}`);
});

test("staleQueueMs defaults to 10 minutes and honors EDGE_BOOK_STALE_QUEUE_MS", () => {
  const prev = process.env.EDGE_BOOK_STALE_QUEUE_MS;
  try {
    delete process.env.EDGE_BOOK_STALE_QUEUE_MS;
    assert.equal(staleQueueMs(), 10 * 60 * 1000);
    process.env.EDGE_BOOK_STALE_QUEUE_MS = "5000";
    assert.equal(staleQueueMs(), 5000);
    process.env.EDGE_BOOK_STALE_QUEUE_MS = "not-a-number";
    assert.equal(staleQueueMs(), 10 * 60 * 1000, "garbage falls back to the default");
  } finally {
    if (prev === undefined) delete process.env.EDGE_BOOK_STALE_QUEUE_MS;
    else process.env.EDGE_BOOK_STALE_QUEUE_MS = prev;
  }
});

test("formatAge renders seconds, minutes, hours, days", () => {
  assert.equal(formatAge(30_000), "30s");
  assert.equal(formatAge(5 * 60_000), "5m");
  assert.equal(formatAge(3 * 3_600_000), "3h");
  assert.equal(formatAge(2 * 86_400_000), "2d");
});
