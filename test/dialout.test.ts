import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EdgeBookDialoutClient,
  createPairRegistration,
  createSessionsRevokeFrame,
  loadOrCreateDialoutKey
} from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-dialout-test-"));
}

class FakeSocket {
  sent: unknown[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;

  send(data: string): void {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "test-channel", server_time: new Date().toISOString() }));
    if (frame.type === "sessions_revoke") queueMicrotask(() => this.receive({ type: "sessions_revoke_ok", request_id: frame.request_id, channel_id: "test-channel" }));
  }

  close(): void {
    this.emit("close");
  }

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

function makeSocketFactory(): { sockets: FakeSocket[]; factory: () => FakeSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("open"));
      return socket;
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("dial-out key is generated once and persisted with stable channel identity", async () => {
  const store = new EdgeBookStore({ home: await tempRoot() });
  const first = await loadOrCreateDialoutKey(store);
  const second = await loadOrCreateDialoutKey(store);

  assert.equal(second.key_id, first.key_id);
  assert.equal(second.agent_key, first.agent_key);
  assert.equal(second.private_key_pem, first.private_key_pem);
  assert.match(second.agent_key, /^ed25519:/);
  assert.match(second.public_key_pem, /BEGIN PUBLIC KEY/);
  assert.match(second.private_key_pem, /BEGIN PRIVATE KEY/);
  assert.match(first.key_id, /^agent_/);

  if (process.platform !== "win32") {
    const stat = await fs.stat(store.file("host-dialout-key.json"));
    assert.equal(stat.mode & 0o077, 0);
  }
});

test("pair and sessions revoke frames preserve host seam metadata", async () => {
  const store = new EdgeBookStore({ home: await tempRoot() });
  const pair = await createPairRegistration(store, 60_000);
  const revoke = await createSessionsRevokeFrame(store);

  assert.match(pair.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(pair.frame.type, "pair_register");
  assert.equal(pair.frame.ttl_ms, 60_000);
  assert.ok(pair.frame.request_id);
  assert.equal(revoke.type, "sessions_revoke");
  assert.ok(revoke.request_id);
});

test("dial-out client answers proxied API requests through existing local handlers", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  const identity = await store.init({ handle: "dialout-api.openclaw.local" });
  const post = await store.createPost({ title: "Host proxied", body: "existing handler", status: "published" });
  const sockets = makeSocketFactory();
  const client = new EdgeBookDialoutClient({ home: root, host: "ws://host.test/agent", socketFactory: sockets.factory, heartbeatMs: 10_000 });

  await client.start();
  try {
    const [me, posts] = await Promise.all([
      client.handleApiRequest({ type: "api_request", request_id: "req-me", method: "GET", path: "/api/me" }),
      client.handleApiRequest({ type: "api_request", request_id: "req-posts", method: "GET", path: "/api/posts" })
    ]);

    assert.equal(me.id, "req-me");
    assert.equal(me.request_id, "req-me");
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(Buffer.from(me.body_b64, "base64").toString("utf8")).identity.did, identity.agent_id);
    assert.equal(posts.id, "req-posts");
    assert.equal(posts.status, 200);
    assert.ok(JSON.parse(Buffer.from(posts.body_b64, "base64").toString("utf8")).posts[post.post_id]);
  } finally {
    await client.stop();
  }
});

test("websocket-only dial-out client does not serve local API requests", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "dialout-ws-only.openclaw.local" });
  const sockets = makeSocketFactory();
  const client = new EdgeBookDialoutClient({
    home: root,
    host: "ws://host.test/agent",
    socketFactory: sockets.factory,
    openLocalApi: false
  });

  await client.start();
  try {
    const response = await client.handleApiRequest({ type: "api_request", request_id: "req-me", method: "GET", path: "/api/me" });
    assert.equal(response.status, 400);
    assert.equal((response.body as { code: string }).code, "local_api_disabled");
  } finally {
    await client.stop();
  }
});

test("dial-out websocket preserves request-id correlation for concurrent host frames", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "dialout-correlate.openclaw.local" });
  await store.createPost({ title: "Correlate", body: "ids", status: "published" });
  const sockets = makeSocketFactory();
  const client = new EdgeBookDialoutClient({ home: root, host: "ws://host.test/agent", socketFactory: sockets.factory, heartbeatMs: 10_000 });

  await client.start();
  try {
    const socket = sockets.sockets[0];
    socket.receive({ type: "api_request", request_id: "a", method: "GET", path: "/api/posts" });
    socket.receive({ type: "api_request", request_id: "b", method: "GET", path: "/api/me" });

    await waitFor(() => socket.sent.filter((frame) => (frame as { type?: string }).type === "api_response").length === 2);
    const responses = socket.sent.filter((frame) => (frame as { type?: string }).type === "api_response") as Array<{ request_id: string; status: number }>;
    assert.deepEqual(new Set(responses.map((response) => response.request_id)), new Set(["a", "b"]));
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  } finally {
    await client.stop();
  }
});

test("CLI pair and sessions revoke send command frames", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  await store.init({ handle: "dialout-cli.openclaw.local" });
  const sockets = makeSocketFactory();
  const ctx = { home: root, socketFactory: sockets.factory, textOnly: true } as never;

  const pair = await handleCli(["pair", "--host", "ws://host.test/agent", "--ttl-ms", "60000"], ctx);
  assert.match(pair.text, /Pairing code:/);
  assert.ok(sockets.sockets[0].sent.some((frame) => (frame as { type?: string }).type === "pair_register"));

  const revoke = await handleCli(["sessions", "revoke", "--host", "ws://host.test/agent"], ctx);
  assert.match(revoke.text, /test-channel/);
  assert.ok(sockets.sockets[1].sent.some((frame) => (frame as { type?: string }).type === "sessions_revoke"));
});
