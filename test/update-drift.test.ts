// spec-142 dial-out version drift: the long-running dial-out compares its
// in-memory version against the installed package.json (reconnect + 6h timer)
// and exits 75 for supervisor respawn — only under auto_update=auto with a
// supervisor expected.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { readEvents } from "../src/event-log.ts";
import { DRIFT_CHECK_INTERVAL_MS, createUpdateDriftMonitor } from "../src/update-drift.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-update-drift-test-"));
}

async function initHome(): Promise<string> {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  return home;
}

function makeMonitor(store: EdgeBookStore, installed: string | undefined, running = "0.17.0", intervalMs?: number) {
  const exits: number[] = [];
  const checks: number[] = [];
  const monitor = createUpdateDriftMonitor(store, {
    running,
    installed: async () => installed,
    exit: (code) => { exits.push(code); },
    checkLatestImpl: async () => { checks.push(1); },
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  });
  return { monitor, exits, checks };
}

test("drift under default auto + supervisor expected → exit 75, events recorded", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const { monitor, exits } = makeMonitor(store, "0.18.0");
  await monitor.onConnect();
  assert.deepEqual(exits, [75], "EX_TEMPFAIL asks the supervising gateway to respawn");
  const events = await readEvents(store);
  assert.ok(events.some((e) => e.kind === "dialout.version_drift" && e.running === "0.17.0" && e.installed === "0.18.0"), "drift event recorded");
  assert.ok(events.some((e) => e.kind === "dialout.restart_for_update" && e.from === "0.17.0" && e.to === "0.18.0"), "restart event recorded");
});

test("no drift → no exit, no drift events", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const { monitor, exits } = makeMonitor(store, "0.17.0");
  await monitor.onConnect();
  assert.deepEqual(exits, []);
  const events = await readEvents(store);
  assert.ok(!events.some((e) => e.kind.startsWith("dialout.version_drift")), "no drift event when current");
});

test("drift under notify / off → log only, no exit", async () => {
  for (const mode of ["notify", "off"] as const) {
    const store = new EdgeBookStore({ home: await initHome() });
    await store.updateConfig({ auto_update: mode });
    const { monitor, exits } = makeMonitor(store, "0.18.0");
    await monitor.onConnect();
    assert.deepEqual(exits, [], `auto_update=${mode} must never exit the dial-out`);
    const events = await readEvents(store);
    assert.ok(events.some((e) => e.kind === "dialout.version_drift"), "drift is still recorded");
    assert.ok(!events.some((e) => e.kind === "dialout.restart_for_update"), "but no restart");
  }
});

test("dialout_respawn_expected:false → log only, no exit (nothing would respawn us)", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await store.updateConfig({ dialout_respawn_expected: false });
  const { monitor, exits } = makeMonitor(store, "0.18.0");
  await monitor.onConnect();
  assert.deepEqual(exits, []);
  const events = await readEvents(store);
  assert.ok(events.some((e) => e.kind === "dialout.version_drift"));
  assert.ok(!events.some((e) => e.kind === "dialout.restart_for_update"));
});

test("unreadable installed version → silent no-op (drift detection degrades, never breaks)", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const { monitor, exits } = makeMonitor(store, undefined);
  await monitor.onConnect();
  assert.deepEqual(exits, []);
});

test("the 6h timer runs the registry check and the drift check", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await store.updateConfig({ auto_update: "notify" }); // log-only so the test never 'exits'
  const { monitor, checks } = makeMonitor(store, "0.18.0", "0.17.0", 20);
  monitor.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    monitor.stop();
  }
  assert.ok(checks.length >= 1, "timer must run checkLatest");
  const events = await readEvents(store);
  assert.ok(events.some((e) => e.kind === "dialout.version_drift"), "timer must run the drift check too");
});

test("default interval is 6h", () => {
  assert.equal(DRIFT_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test("the dial-out client runs the drift check on every (re)connect and stops the timer on stop", async () => {
  const home = await initHome();
  let connects = 0;
  let started = 0;
  let stopped = 0;
  const monitor = {
    onConnect: async () => { connects += 1; },
    start: () => { started += 1; },
    stop: () => { stopped += 1; },
  };
  const sockets: FakeSocket[] = [];
  const client = new EdgeBookDialoutClient({
    home,
    host: "wss://example.test/agent/ws",
    openLocalApi: false,
    driftMonitor: monitor,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  await client.start();
  await waitFor(() => connects === 1);
  assert.ok(started >= 1, "timer started with the connection");
  await client.stop();
  assert.ok(stopped >= 1, "timer stopped with the client");
});

class FakeSocket {
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;
  send(data: string): void {
    const frame = JSON.parse(data) as { type?: string };
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "test-channel", server_time: new Date().toISOString() }));
  }
  close(): void { this.emit("close"); }
  addEventListener(event: "open" | "message" | "close" | "error", handler: (event?: unknown) => void): void {
    this.listeners[event] ||= [];
    this.listeners[event].push(handler);
  }
  emit(event: string, value?: unknown): void {
    for (const handler of this.listeners[event] || []) handler(value);
  }
  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
