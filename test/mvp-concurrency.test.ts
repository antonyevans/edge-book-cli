import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-concurrency-"));
}

// Reproduces the read-during-write race that produced intermittent
// "Unexpected end of JSON input" 500s when the host proxied many /api/* calls
// concurrently. With atomic writes + resilient JSONL reads this must be clean.
test("concurrent reads never observe a half-written store file", async () => {
  const home = await tempHome();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "race.local" });
  // Some data to read back.
  const obj = await store.createObject({ title: "T", body: "B" });
  await store.audit("noise", "x", { i: 0 });

  // Hammer: many rounds of concurrent reads while a write (writeCard) runs.
  let failures = 0;
  for (let round = 0; round < 80; round++) {
    const ops: Promise<unknown>[] = [
      store.writeCard(),            // the writer (atomic now)
      store.contacts(),
      store.grants(),
      store.objects(),
      store.auditEvents(),          // readJsonl — partial trailing line tolerated
      store.sharedObjectsFor(),
      store.identity(),
      store.getObject(obj.object_id)
    ];
    const results = await Promise.allSettled(ops);
    failures += results.filter((r) => r.status === "rejected").length;
  }
  assert.equal(failures, 0, "no read raced a partial write");
});

test("local API serves many concurrent requests without 500s", async () => {
  const home = await tempHome();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "api-race.local" });
  const server = await startEdgeBookServer({ home, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth_method: "dev-bypass" }) });
    const { session_id, csrf_token } = await login.json() as { session_id: string; csrf_token: string };
    const headers = { "x-openclaw-session": session_id, "x-openclaw-csrf": csrf_token };
    const eps = ["/api/me", "/api/contacts", "/api/feed", "/api/shared-objects", "/api/invite", "/api/audit", "/api/posts", "/api/approvals"];
    let bad = 0;
    for (let round = 0; round < 25; round++) {
      const statuses = await Promise.all(eps.map((e) => fetch(`${base}${e}`, { headers }).then((r) => r.status)));
      bad += statuses.filter((s) => s >= 500).length;
    }
    assert.equal(bad, 0, "no 500s under concurrent polling");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});
