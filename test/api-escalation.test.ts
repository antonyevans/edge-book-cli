import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-api-esc-"));
}
function baseUrlOf(server: { address(): unknown }): string {
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: { close(cb: (e?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
}
async function login(baseUrl: string): Promise<Record<string, string>> {
  const r = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth_method: "dev-bypass" }) });
  const b = await r.json() as { session_id: string; csrf_token: string };
  return { "x-openclaw-session": b.session_id, "x-openclaw-csrf": b.csrf_token };
}

test("GET /api/escalations lists pending; POST .../answer resolves it", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: path.join(root, "a") });
  await store.init({ handle: "a.local", ownerLabel: "Owner" });
  const { escalation } = await store.raiseEscalation({ kind: "question", subject: "Q3?", body: "the number" });

  const server = await startEdgeBookServer({ home: store.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const listed = await fetch(`${baseUrl}/api/escalations`, { headers }).then((r) => r.json()) as { escalations: Record<string, { status: string }> };
    assert.equal(Object.keys(listed.escalations).length, 1);
    assert.equal(listed.escalations[escalation.escalation_id].status, "pending");

    const answered = await fetch(`${baseUrl}/api/escalations/${encodeURIComponent(escalation.escalation_id)}/answer`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "1.2M" }),
    }).then((r) => r.json()) as { escalation: { status: string; answer_text: string } };
    assert.equal(answered.escalation.status, "answered");
    assert.equal(answered.escalation.answer_text, "1.2M");
  } finally {
    await closeServer(server);
  }
});
