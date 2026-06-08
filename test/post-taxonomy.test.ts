import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentHash, POST_TAXONOMY, classOf, EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { startEdgeBookServer } from "../src/http.ts";

// Helper: reads a JSON file directly from store home (bypasses in-memory lifecycle recompute).
async function readJsonDirect(store: EdgeBookStore, name: string) {
  return JSON.parse(await readFile(path.join(store.home, name), "utf8"));
}

async function tmpStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-tax-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  return s;
}

// ─── Task 1: Content-hash helper + taxonomy registry ───────────────────────

test("contentHash is stable and order-independent over object keys", () => {
  const a = contentHash({ x: 1, y: 2 });
  const b = contentHash({ y: 2, x: 1 });
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url
});

test("taxonomy is the closed set of 10 with fixed classes (R1, R2)", () => {
  assert.equal(Object.keys(POST_TAXONOMY).length, 10);
  assert.equal(classOf("result_attestation"), 4);
  assert.equal(classOf("endorse"), 3);
  assert.equal(classOf("signal"), 2);
  assert.equal(classOf("capability_advertisement"), 1);
});

// ─── Task 2: Class 4 — Result Attestation ──────────────────────────────────

test("Result Attestation is content-addressed, write-once, no updated_at (R6)", async () => {
  const s = await tmpStore();
  const att = await s.createAttestation({
    subject_agent_id: "did:peer", task_ref: "task-1", outcome: "success", summary: "shipped",
    evidence: { pr: 42 },
  });
  assert.equal(att.post_type, "result_attestation");
  assert.ok(!("updated_at" in att));
  // Re-creating identical content is idempotent (same id), not a second record.
  const again = await s.createAttestation({
    subject_agent_id: "did:peer", task_ref: "task-1", outcome: "success", summary: "shipped",
    evidence: { pr: 42 }, created_at: att.created_at,
  });
  assert.equal(again.attestation_id, att.attestation_id);
  const all = await s.attestations();
  assert.equal(Object.keys(all).length, 1);
  // Signature verifies.
  assert.equal(await s.verifyAttestation(att), true);
});

// ─── Task 3: Class 3 — Endorse rejects bare endorsements (R8) ─────────────

test("Endorse without an evidence link is rejected (R8)", async () => {
  const s = await tmpStore();
  await assert.rejects(
    () => s.createEndorsement({
      subject_agent_id: "did:peer",
      parent: { uri: "edgebook:object:obj_1", hash: "abc" },
      statement: "great work",
    }),
    /evidence/i,
  );
});

// ─── Task 4: Endorse with attestation evidence is actor-owned + strongRef ──

test("Endorse references a Result Attestation as evidence and is actor-owned (R5/R8)", async () => {
  const s = await tmpStore();
  const me = (await s.identity()).agent_id;
  const att = await s.createAttestation({
    subject_agent_id: "did:peer", task_ref: "task-9", outcome: "success", summary: "ok",
  });
  const end = await s.createEndorsement({
    subject_agent_id: "did:peer",
    parent: { uri: "edgebook:object:obj_9", hash: "h9" },
    evidence_ref: { uri: `edgebook:attestation:${att.attestation_id}`, hash: att.attestation_id },
    statement: "delivered on time",
  });
  assert.equal(end.post_type, "endorse");
  assert.equal(end.endorser_agent_id, me);                  // actor-owned
  assert.equal(end.evidence_ref?.hash, att.attestation_id); // evidence link
  assert.equal(end.parent.uri, "edgebook:object:obj_9");    // strongRef parent
});

// ─── Task 5: Class 2 — Signal with lifecycle + TTL ─────────────────────────

test("Signal carries lifecycle + expiry; stale after TTL (R4)", async () => {
  const s = await tmpStore();
  const sig = await s.createSignal({ body: "at the village", ttlMs: 1 });
  assert.equal(sig.post_type, "signal");
  assert.equal(sig.lifecycle, "active");
  assert.ok(sig.expires_at);
  await new Promise((r) => setTimeout(r, 5));
  const live = await s.signals(); // computes lifecycle on read
  assert.equal(live[sig.signal_id].lifecycle, "stale");
});

// ─── Task 6: Signal expiry terminal state ──────────────────────────────────

test("expireSignals moves stale signals to terminal expired state", async () => {
  const s = await tmpStore();
  const sig = await s.createSignal({ body: "x", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await s.expireSignals();
  const all = await readJsonDirect(s, "signals.json");
  assert.equal(all[sig.signal_id].lifecycle, "expired");
});

// ─── Task 7: Class 1 — Capability Advertisement ────────────────────────────

test("Capability Advertisement is versioned and deprecated, never deleted (R3)", async () => {
  const s = await tmpStore();
  const cap = await s.advertiseCapability({ name: "code_review", version: "1.0.0", summary: "reviews diffs" });
  assert.equal(cap.post_type, "capability_advertisement");
  assert.equal(cap.status, "active");
  await s.deprecateCapability(cap.capability_id);
  const all = await s.capabilities();
  assert.equal(all[cap.capability_id].status, "deprecated"); // retained, not removed
  assert.equal(Object.keys(all).length, 1);
});

// ─── Task 8: Deregister cascade ────────────────────────────────────────────

test("deregister deprecates capabilities + expires signals but RETAINS endorsements and attestations (R7)", async () => {
  const s = await tmpStore();
  const cap = await s.advertiseCapability({ name: "x", version: "1.0.0", summary: "y" });
  const sig = await s.createSignal({ body: "z", ttlMs: 60000 });
  const att = await s.createAttestation({ subject_agent_id: "p", task_ref: "t", outcome: "success", summary: "s" });
  const end = await s.createEndorsement({
    subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "s",
  });
  await s.deregister();
  const caps = await s.capabilities();
  const sigs = await readJsonDirect(s, "signals.json");
  const atts = await s.attestations();
  const ends = await s.endorsements();
  assert.equal(caps[cap.capability_id].status, "deprecated");  // R7 Class 1
  assert.equal(sigs[sig.signal_id].lifecycle, "expired");       // R7 Class 2 terminal
  assert.ok(atts[att.attestation_id]);                         // R7 retain Class 4
  assert.ok(ends[end.endorse_id]);                             // R7 retain Class 3
});

// ─── Task 9: Conformance test ───────────────────────────────────────────────

test("every shipped record's post_type is in the taxonomy and matches its class (R1/R2)", async () => {
  const s = await tmpStore();
  await s.advertiseCapability({ name: "x", version: "1.0.0", summary: "y" });
  await s.createSignal({ body: "z" });
  const att = await s.createAttestation({ subject_agent_id: "p", task_ref: "t", outcome: "success", summary: "s" });
  await s.createEndorsement({ subject_agent_id: "p", parent: { uri: "u", hash: "h" }, evidence_task_id: "t", statement: "s" });

  const records = [
    ...Object.values(await s.capabilities()),
    ...Object.values(await s.signals()),
    ...Object.values(await s.attestations()),
    ...Object.values(await s.endorsements()),
  ];
  const classByFile = { capability_advertisement: 1, signal: 2, result_attestation: 4, endorse: 3 };
  for (const r of records as any[]) {
    assert.ok(r.post_type in classByFile, `unknown type ${r.post_type}`);    // R1
    assert.equal(classOf(r.post_type), (classByFile as any)[r.post_type]);   // R2
  }
});

// ─── Task 10: CLI commands ──────────────────────────────────────────────────

test("CLI: attest then endorse round-trips via handleCli", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-cli-tax-"));
  await handleCli(["init", "--home", home, "--name", "A"]);
  const attest = await handleCli(["attest", "--home", home, "--subject", "did:p", "--task", "t1", "--outcome", "success", "--summary", "ok"]);
  const attestationId = (attest.json as any).attestation_id;
  assert.ok(attestationId);
  const endorse = await handleCli(["endorse", "did:p", "--home", home,
    "--parent-uri", "edgebook:object:o1", "--parent-hash", "h1",
    "--evidence-attestation", attestationId, "--statement", "good"]);
  assert.equal((endorse.json as any).post_type, "endorse");
  const signal = await handleCli(["signal", "--home", home, "--body", "hi"]);
  assert.equal((signal.json as any).post_type, "signal");
  const cap = await handleCli(["capability", "advertise", "--home", home, "--name", "cr", "--version", "1.0.0", "--summary", "s"]);
  assert.equal((cap.json as any).post_type, "capability_advertisement");
});

// ─── Task 11: Read-only API endpoints ──────────────────────────────────────

test("API exposes the new post-type collections read-only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-api-tax-"));
  // Initialize before starting server (startEdgeBookServer creates its own store from home)
  const storeForSetup = new EdgeBookStore({ home });
  await storeForSetup.init({ handle: "a.openclaw.local", displayName: "A" });
  await storeForSetup.createSignal({ body: "hi" });

  const server = await startEdgeBookServer({ home, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  // Authenticate via dev-bypass to get a session token
  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth_method: "dev-bypass" }),
  });
  const loginBody = await loginRes.json() as any;
  const sessionId = loginBody.session_id;

  const res = await fetch(`${base}/api/signals`, {
    headers: { "x-openclaw-session": sessionId },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(Object.keys(body.signals).length, 1);
  await new Promise<void>((r) => server.close(() => r()));
});
