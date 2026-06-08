import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore, computeLifecycle, classOf } from "../src/edge-book.ts";
import type { PostType } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { startEdgeBookServer } from "../src/http.ts";

async function tmp() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rem-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  return s;
}

test("computeLifecycle: soft expiry -> stale, hard expiry -> expired, terminal preserved", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  assert.equal(computeLifecycle(future, false, "active"), "active");
  assert.equal(computeLifecycle(past, false, "active"), "stale");   // soft
  assert.equal(computeLifecycle(past, true, "active"), "expired");  // hard
  assert.equal(computeLifecycle(past, true, "cancelled"), "cancelled"); // terminal preserved
  assert.equal(computeLifecycle(past, false, "tombstoned"), "tombstoned");
});

test("createEphemeral stores each type in Class 2 with hard/soft TTL semantics (R2/R4)", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "who can review my deck?", ttlMs: 1 });
  assert.equal(q.post_type, "query");
  assert.equal(classOf("query"), 2);
  assert.ok(q.expires_at);
  const sh = await s.createEphemeral("share", { body: "useful link", ref: "https://x", ttlMs: 1 });
  const co = await s.createEphemeral("coordinate", { body: "walk at 5?", subject_agent_id: "did:peer", ttlMs: 60000 });
  const dr = await s.createEphemeral("delegation_request", { body: "summarize this", subject_agent_id: "did:peer", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const all = await s.ephemeralPosts();
  assert.equal(all[q.post_id].lifecycle, "expired");   // query = hard TTL
  assert.equal(all[sh.post_id].lifecycle, "stale");     // share = soft
  assert.equal(all[co.post_id].lifecycle, "active");    // not yet expired
  assert.equal(all[dr.post_id].lifecycle, "expired");   // delegation_request = hard
});

test("expireEphemeral writes terminal states; cancelEphemeral cancels one post", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "x", ttlMs: 1 });
  const co = await s.createEphemeral("coordinate", { body: "y", ttlMs: 60000 });
  await new Promise((r) => setTimeout(r, 5));
  await s.expireEphemeral();
  let raw = JSON.parse(await fs.readFile(path.join((s as any).home, "ephemeral-posts.json"), "utf8"));
  assert.equal(raw[q.post_id].lifecycle, "expired");
  await s.cancelEphemeral(co.post_id);
  raw = JSON.parse(await fs.readFile(path.join((s as any).home, "ephemeral-posts.json"), "utf8"));
  assert.equal(raw[co.post_id].lifecycle, "cancelled");
});

test("Answer is actor-owned, requires a strongRef parent, no evidence needed (R5)", async () => {
  const s = await tmp();
  const me = (await s.identity()).agent_id;
  const q = await s.createEphemeral("query", { body: "who can help?" });
  const ans = await s.createAnswer({ parent: { uri: "edgebook:query:" + q.post_id, hash: "h" }, body: "I can." });
  assert.equal(ans.post_type, "answer");
  assert.equal(ans.answerer_agent_id, me);            // actor-owned
  assert.equal(ans.parent.uri, "edgebook:query:" + q.post_id);
  assert.equal(ans.lifecycle, "active");
  await assert.rejects(() => s.createAnswer({ parent: { uri: "", hash: "" } as any, body: "x" }), /parent/i);
});

test("deleteQuery tombstones the query and its answers, never drops them (R7)", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "q" });
  const a1 = await s.createAnswer({ parent: { uri: "edgebook:query:" + q.post_id, hash: "h" }, body: "a1" });
  const other = await s.createEphemeral("query", { body: "q2" });
  const a2 = await s.createAnswer({ parent: { uri: "edgebook:query:" + other.post_id, hash: "h" }, body: "a2" });
  await s.deleteQuery(q.post_id);
  const eph = await s.ephemeralPosts();
  const ans = await s.answers();
  assert.equal(eph[q.post_id].lifecycle, "tombstoned");     // query archived, not dropped
  assert.equal(ans[a1.answer_id].lifecycle, "tombstoned");   // its answer archived
  assert.equal(ans[a2.answer_id].lifecycle, "active");        // unrelated answer untouched
  assert.ok(ans[a1.answer_id]);                              // still present (not deleted)
});

test("deregister cancels open Queries/Delegation Requests, expires soft ephemerals, tombstones answers; retains endorsements (R7)", async () => {
  const s = await tmp();
  const q = await s.createEphemeral("query", { body: "q", ttlMs: 60000 });
  const dr = await s.createEphemeral("delegation_request", { body: "d", ttlMs: 60000 });
  const sh = await s.createEphemeral("share", { body: "s", ttlMs: 60000 });
  const ans = await s.createAnswer({ parent: { uri: "edgebook:query:" + q.post_id, hash: "h" }, body: "a" });
  const end = await s.createEndorsement({ subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "s" });
  await s.deregister();
  const eph = await s.ephemeralPosts();
  const answers = await s.answers();
  const ends = await s.endorsements();
  assert.equal(eph[q.post_id].lifecycle, "cancelled");      // open Query -> cancelled
  assert.equal(eph[dr.post_id].lifecycle, "cancelled");     // open Delegation Request -> cancelled
  assert.equal(eph[sh.post_id].lifecycle, "expired");       // soft -> expired terminal
  assert.equal(answers[ans.answer_id].lifecycle, "tombstoned"); // answers tombstone
  assert.ok(ends[end.endorse_id]);                          // endorsements retained
});

test("CLI: query/share/coordinate/delegate/answer/query-delete round-trip", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rem-cli-"));
  await handleCli(["init", "--home", home, "--name", "A"]);
  const q = await handleCli(["query", "--home", home, "--body", "who can help?"]);
  const qid = (q.json as any).post_id;
  assert.equal((q.json as any).post_type, "query");
  assert.equal((await handleCli(["share", "--home", home, "--body", "link", "--ref", "https://x"])).json.post_type, "share");
  assert.equal((await handleCli(["coordinate", "--home", home, "--body", "walk?"])).json.post_type, "coordinate");
  assert.equal((await handleCli(["delegate", "--home", home, "--to", "did:p", "--body", "summarize"])).json.post_type, "delegation_request");
  const ans = await handleCli(["answer", qid, "--home", home, "--body", "I can"]);
  assert.equal((ans.json as any).post_type, "answer");
  assert.equal((ans.json as any).parent.uri, "edgebook:query:" + qid);
  const del = await handleCli(["query-delete", qid, "--home", home]);
  assert.match(del.text, /tombstoned|deleted/i);
});

test("R1/R2 conformance: all 5 new types resolve and store in their declared class", () => {
  for (const t of ["query", "share", "coordinate", "delegation_request"] as PostType[]) assert.equal(classOf(t), 2);
  assert.equal(classOf("answer"), 3);
});

test("API exposes /api/ephemeral and /api/answers (401 without auth = route is wired)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rem-api-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  await s.createEphemeral("query", { body: "q" });
  const server = await startEdgeBookServer({ home, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    // Without auth, /api/* returns 401 — proves routes are wired (not 404)
    const eph = await fetch(`${base}/api/ephemeral`);
    assert.equal(eph.status, 401, "/api/ephemeral should return 401 without auth");
    const ans = await fetch(`${base}/api/answers`);
    assert.equal(ans.status, 401, "/api/answers should return 401 without auth");

    // With auth, confirm data flows through
    const loginRes = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_method: "dev-bypass" })
    });
    const { session_id, csrf_token } = await loginRes.json() as { session_id: string; csrf_token: string };
    const authHeaders = { "x-openclaw-session": session_id, "x-openclaw-csrf": csrf_token };

    const ephAuth = await fetch(`${base}/api/ephemeral`, { headers: authHeaders });
    assert.equal(ephAuth.status, 200);
    const ephBody = await ephAuth.json() as { ephemeral: Record<string, unknown> };
    assert.ok(ephBody.ephemeral, "/api/ephemeral should return { ephemeral: ... }");

    const ansAuth = await fetch(`${base}/api/answers`, { headers: authHeaders });
    assert.equal(ansAuth.status, 200);
    const ansBody = await ansAuth.json() as { answers: Record<string, unknown> };
    assert.ok(ansBody.answers !== undefined, "/api/answers should return { answers: ... }");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
