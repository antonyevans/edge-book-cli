import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";
import { writeCandidate, listCandidates, dropCandidate } from "../src/resolver.ts";

async function store() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-cand-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "Agent A" });
  return s;
}

// HTTP test helpers (copied from test/api-escalation.test.ts)
function baseUrlOf(server: { address(): unknown }): string {
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: { close(cb: (e?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
async function login(baseUrl: string): Promise<Record<string, string>> {
  const r = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth_method: "dev-bypass" }),
  });
  const b = (await r.json()) as { session_id: string; csrf_token: string };
  return { "x-openclaw-session": b.session_id, "x-openclaw-csrf": b.csrf_token };
}
async function getApi(s: EdgeBookStore, urlPath: string) {
  const server = await startEdgeBookServer({ home: s.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const r = await fetch(`${baseUrl}${urlPath}`, { headers });
    const json = await r.json();
    return { status: r.status, json };
  } finally {
    await closeServer(server);
  }
}
async function postApi(s: EdgeBookStore, urlPath: string, body: unknown) {
  const server = await startEdgeBookServer({ home: s.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const r = await fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    return { status: r.status, json };
  } finally {
    await closeServer(server);
  }
}

test("dropCandidate removes the candidate", async () => {
  const s = await store();
  const c = await writeCandidate(s, {
    source: "index",
    confidence: "low",
    display_name: "Stranger",
    reason: "match",
    card_url: "https://example/card.json",
  });
  assert.equal((await listCandidates(s)).length, 1);
  await dropCandidate(s, c.candidate_id);
  assert.equal((await listCandidates(s)).length, 0);
});

test("GET /api/candidates lists; POST promote returns a friend_request response_envelope + marks approved", async () => {
  const s = await store();
  // A candidate must have a card_url promote can load. Use a second real agent's card file.
  const peerHome = await fs.mkdtemp(path.join(os.tmpdir(), "eb-peer-"));
  const peer = new EdgeBookStore({ home: peerHome });
  await peer.init({ handle: "peer.openclaw.local", displayName: "Peer" });
  await peer.writeCard(); // writes the card file
  const peerCardPath = path.join(peerHome, "openclaw-agent.json");
  const c = await writeCandidate(s, {
    source: "card_file",
    confidence: "high",
    display_name: "Peer",
    reason: "card",
    card_url: `file://${peerCardPath}`,
  });

  const list = await getApi(s, "/api/candidates");
  assert.ok((list.json.candidates as Array<{ candidate_id: string }>).some((x) => x.candidate_id === c.candidate_id));

  const promote = await postApi(s, `/api/candidates/${c.candidate_id}/promote`, {});
  assert.equal(promote.json.response_envelope.type, "friend_request");
  // candidate is now approved
  const after = (await listCandidates(s)).find((x) => x.candidate_id === c.candidate_id);
  assert.equal(after?.approved, true);
});

test("POST /api/candidates/:id/reject drops it", async () => {
  const s = await store();
  const c = await writeCandidate(s, {
    source: "index",
    confidence: "low",
    display_name: "X",
    reason: "m",
    card_url: "https://e/c.json",
  });
  const res = await postApi(s, `/api/candidates/${c.candidate_id}/reject`, {});
  assert.equal(res.json.dropped, true);
  assert.equal((await listCandidates(s)).length, 0);
});
