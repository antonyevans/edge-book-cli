import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

// Fake host: completes hello, then answers sessions_list / session_revoke_one
// per the wire protocol (ea-claude-057).
class FakeSocket {
  sent: any[] = [];
  listeners: Record<string, Array<(e?: unknown) => void>> = {};
  readyState = 1;
  private devices = [
    { device_id: "dev_phone", label: "Safari on iPhone", created_at: 2, last_seen_at: 5 },
    { device_id: "dev_laptop", label: "Chrome on macOS", created_at: 1, last_seen_at: 4 }
  ];
  send(data: string): void {
    const f = JSON.parse(data);
    this.sent.push(f);
    if (f.type === "hello") queueMicrotask(() => this.recv({ type: "hello_ok", channel_id: "c", server_time: "" }));
    if (f.type === "sessions_list") queueMicrotask(() => this.recv({ type: "sessions_list_ok", request_id: f.request_id, devices: this.devices }));
    if (f.type === "session_revoke_one") queueMicrotask(() => {
      const had = this.devices.some((d) => d.device_id === f.device_id);
      this.devices = this.devices.filter((d) => d.device_id !== f.device_id);
      this.recv({ type: "session_revoke_one_ok", request_id: f.request_id, device_id: f.device_id, revoked: had });
    });
  }
  close(): void { this.emit("close"); }
  addEventListener(e: string, h: (x?: unknown) => void): void { (this.listeners[e] ||= []).push(h); }
  emit(e: string, v?: unknown): void { for (const h of this.listeners[e] || []) h(v); }
  recv(v: unknown): void { this.emit("message", { data: JSON.stringify(v) }); }
}

async function client() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sess-rpc-"));
  await new EdgeBookStore({ home }).init({ handle: "s.local" });
  const factory = (_url: string) => { const s = new FakeSocket(); queueMicrotask(() => s.emit("open")); return s; };
  return new EdgeBookDialoutClient({ home, host: "ws://fake", reconnect: false, openLocalApi: false, socketFactory: factory as never });
}

test("listSessionsAndWait returns the host's device list", async () => {
  const c = await client();
  await c.start();
  const devices = await c.listSessionsAndWait();
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((d) => d.device_id), ["dev_phone", "dev_laptop"]);
  assert.equal(devices[0].label, "Safari on iPhone");
  await c.stop();
});

test("revokeOneSessionAndWait reports revoked true/false", async () => {
  const c = await client();
  await c.start();
  assert.equal(await c.revokeOneSessionAndWait("dev_phone"), true, "known device revoked");
  assert.equal((await c.listSessionsAndWait()).length, 1, "list reflects the revoke");
  assert.equal(await c.revokeOneSessionAndWait("dev_phone"), false, "already-gone device → false");
  await c.stop();
});
