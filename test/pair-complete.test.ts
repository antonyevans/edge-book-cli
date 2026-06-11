import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PairCompleteWaiter } from "../src/dialout-pair.ts";
import { buildOnboardingNote } from "../src/onboarding.ts";
import { handleCli } from "../src/cli.ts";
import { buildPairCompleteNotifyIntent } from "../src/store-notify.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-pair-complete-"));
}

// ── FakeSocket (same pattern as dialout.test.ts) ─────────────────────────────

class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "hello") {
      queueMicrotask(() =>
        this.receive({ type: "hello_ok", channel_id: "test-channel", server_time: new Date().toISOString() })
      );
    }
    if (frame.type === "pair_register") {
      queueMicrotask(() =>
        this.receive({ type: "pair_register_ok", request_id: frame.request_id })
      );
    }
  }

  close(): void { this.emit("close"); }

  addEventListener(event: string, handler: (event?: unknown) => void): void {
    this.listeners[event] ??= [];
    this.listeners[event]!.push(handler);
  }

  emit(event: string, value?: unknown): void {
    for (const h of this.listeners[event] ?? []) h(value);
  }

  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

function makeSocketFactory(): { sockets: FakeSocket[]; factory: (url: string) => FakeSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url: string) => {
      void url;
      const s = new FakeSocket();
      sockets.push(s);
      queueMicrotask(() => s.emit("open"));
      return s;
    },
  };
}

async function waitFor(predicate: () => boolean, maxMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

// Export helpers for later tasks (re-used by CLI integration tests below).
export { tempHome, makeSocketFactory, waitFor };

// ── PairCompleteWaiter unit tests ─────────────────────────────────────────────

test("PairCompleteWaiter: resolves with device_id + label on onFrame()", async () => {
  const w = new PairCompleteWaiter();
  const promise = w.wait(5000);
  w.onFrame({ device_id: "ch1", label: "Chrome on macOS" });
  const result = await promise;
  assert.deepEqual(result, { device_id: "ch1", label: "Chrome on macOS" });
});

test("PairCompleteWaiter: resolves null after ttlMs (old-host degradation)", async () => {
  const w = new PairCompleteWaiter();
  const start = Date.now();
  const result = await w.wait(100);
  assert.equal(result, null);
  assert.ok(Date.now() - start >= 90, "waited at least 90ms");
});

test("PairCompleteWaiter: onFrame after timeout is a no-op (does not throw)", async () => {
  const w = new PairCompleteWaiter();
  const result = await w.wait(50);
  assert.equal(result, null);
  // Should not throw.
  w.onFrame({ device_id: "ch1", label: "Browser" });
});

// ── onboarding.ts: step 6 check (placeholder — will pass after Task 7) ────────

test("buildOnboardingNote: step 6 mentions ensure-notifier (fails until Task 7)", async () => {
  void tempHome; // suppress unused import warning
  const note = buildOnboardingNote();
  assert.ok(note.includes("ensure-notifier"), "onboarding note must include ensure-notifier step");
});

// ── buildPairCompleteNotifyIntent unit test ───────────────────────────────────

test("buildPairCompleteNotifyIntent: correct kind/message/dedup_key/from_id", () => {
  const intent = buildPairCompleteNotifyIntent("ch-abc", "Firefox on Linux");
  assert.equal(intent.kind, "pair_complete");
  assert.ok(intent.message.includes("Firefox on Linux"), "label in message");
  assert.equal(intent.dedup_key, "ch-abc");
  assert.equal(intent.from_id, "ch-abc");
});

// ── CLI integration: pair command ─────────────────────────────────────────────

test("pair command: pair_complete received → confirmation text + device label in result", async () => {
  const home = await tempHome();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "pair-complete-test-1.openclaw.local" });
  const { sockets, factory } = makeSocketFactory();

  const cliPromise = handleCli(["pair", "--host", "ws://fake", "--ttl-ms", "5000"], {
    home,
    socketFactory: factory as unknown as (url: string) => WebSocket,
    textOnly: false,
  });

  await waitFor(() => (sockets[0]?.sent ?? []).some((f) => f.type === "pair_register"));
  sockets[0]!.receive({ type: "pair_complete", device_id: "test-channel", label: "Chrome on macOS" });

  const result = await cliPromise;
  assert.ok(result?.text?.includes("Pairing complete"), "result text includes Pairing complete");
  assert.ok(result?.text?.includes("Chrome on macOS"), "result text includes device label");
});

test("pair command: old host (no pair_complete) → throws with message about expiry after TTL", async () => {
  const home = await tempHome();
  const storeInit = new EdgeBookStore({ home });
  await storeInit.init({ handle: "pair-complete-test-2.openclaw.local" });
  const { factory } = makeSocketFactory();

  await assert.rejects(
    handleCli(["pair", "--host", "ws://fake", "--ttl-ms", "120"], {
      home,
      socketFactory: factory as unknown as (url: string) => WebSocket,
      textOnly: false,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "throws an Error");
      assert.match((err as Error).message, /expired|timeout|redeemed/i, "message mentions expiry");
      return true;
    }
  );
});

test("pair command: dedup ledger entry exists after pair_complete (when no notify_cmd)", async () => {
  // No notify_cmd configured, so delivery is skipped but the pair flow completes.
  const home = await tempHome();
  const storeSetup = new EdgeBookStore({ home });
  await storeSetup.init({ handle: "pair-complete-test-3.openclaw.local" });
  const { sockets, factory } = makeSocketFactory();

  const cliPromise = handleCli(["pair", "--host", "ws://fake", "--ttl-ms", "5000"], {
    home,
    socketFactory: factory as unknown as (url: string) => WebSocket,
    textOnly: false,
  });

  await waitFor(() => (sockets[0]?.sent ?? []).some((f) => f.type === "pair_register"));
  sockets[0]!.receive({ type: "pair_complete", device_id: "dedup-channel", label: "Safari on iPhone" });
  await cliPromise;

  // With no notify_cmd, wasNotified should return false (not recorded).
  const store = new EdgeBookStore({ home });
  const notified = await store.wasNotified("dedup-channel");
  assert.equal(notified, false, "not recorded without notify_cmd");
});
