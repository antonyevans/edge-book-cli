/**
 * Task A1–A4: mailbox post delivery — TDD
 * Run: node --test test/mailbox-post-delivery.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { startEdgeBookServer } from "../src/http.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

async function tmp(name = "me"): Promise<EdgeBookStore> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: name + ".openclaw.local", displayName: name });
  return s;
}

async function friend(a: EdgeBookStore, b: EdgeBookStore): Promise<void> {
  await a.upsertContactFromCard(await b.buildCard(), "friend");
  await b.upsertContactFromCard(await a.buildCard(), "friend");
}

// ─── A1: verifyEndorsement ───────────────────────────────────────────────────

test("verifyEndorsement validates an endorsement's signature", async () => {
  const s = await tmp();
  const e = await s.createEndorsement({
    subject_agent_id: "p",
    parent: { uri: "u", hash: "h" },
    evidence_task_id: "t",
    statement: "good",
  });
  assert.equal(await s.verifyEndorsement(e), true);
});

test("verifyEndorsement returns false for a tampered endorsement", async () => {
  const s = await tmp();
  const e = await s.createEndorsement({
    subject_agent_id: "p",
    parent: { uri: "u", hash: "h" },
    evidence_task_id: "t",
    statement: "good",
  });
  const tampered = { ...e, statement: "tampered" };
  assert.equal(await s.verifyEndorsement(tampered as any), false);
});

// ─── A2: receivePostPublish ──────────────────────────────────────────────────

test("receivePostPublish: friend's signed post is verified + stored; non-friend rejected; forged rejected", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);

  // Happy path: alice sends bob a signal
  const sig = await alice.createSignal({ body: "hi from alice" });
  const env = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: sig,
  });
  await bob.receivePostPublish(env);
  const recv = await bob.receivedByCategory();
  assert.equal(Object.keys(recv.signals).length, 1);
  assert.equal((Object.values(recv.signals)[0] as any).body, "hi from alice");

  // Non-friend: carol not a friend of bob -> rejected
  const carol = await tmp("carol");
  await bob.upsertContactFromCard(await carol.buildCard(), "none");
  await carol.upsertContactFromCard(await bob.buildCard(), "friend");
  const cs = await carol.createSignal({ body: "spam" });
  const cenv = await carol.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: cs,
  });
  await assert.rejects(() => bob.receivePostPublish(cenv), /friend|not_friend/i);

  // Forged: tamper the post body after signing -> inner-sig check fails
  const sig2 = await alice.createSignal({ body: "real" });
  const env2 = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: { ...sig2, body: "tampered" },
  });
  await assert.rejects(() => bob.receivePostPublish(env2), /signature|invalid/i);
});

test("receivePostPublish stores endorsement from friend", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);

  const endo = await alice.createEndorsement({
    subject_agent_id: (await bob.identity()).agent_id,
    parent: { uri: "edgebook:obj:x", hash: "abc" },
    evidence_task_id: "t1",
    statement: "excellent",
  });
  const env = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: endo,
  });
  await bob.receivePostPublish(env);
  const recv = await bob.receivedByCategory();
  assert.equal(Object.keys(recv.endorsements).length, 1);
});

test("receiveEnvelope dispatcher routes post_publish", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);

  const sig = await alice.createSignal({ body: "via dispatcher" });
  const env = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: sig,
  });
  await bob.receiveEnvelope(env);
  const recv = await bob.receivedByCategory();
  assert.equal(Object.keys(recv.signals).length, 1);
});

// ─── A3: CLI --deliver ──────────────────────────────────────────────────────

test("CLI signal --deliver with no friends is a no-op (no throw)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-cli-"));
  await handleCli(["init", "--home", home, "--name", "A"]);
  const r = await handleCli(["signal", "--home", home, "--body", "hi", "--deliver"]);
  // result should contain post_type signal either at root or nested under .post
  const json = r.json as any;
  const postType = json?.post?.post_type ?? json?.post_type;
  assert.equal(postType, "signal");
});

test("CLI endorse --deliver with no friends is a no-op (no throw)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-cli-"));
  await handleCli(["init", "--home", home, "--name", "B"]);
  const r = await handleCli([
    "endorse", "--home", home,
    "peer-id",
    "--parent-uri", "edgebook:obj:x",
    "--parent-hash", "abc",
    "--evidence-task", "t1",
    "--statement", "great",
    "--deliver",
  ]);
  const json = r.json as any;
  const postType = json?.post?.post_type ?? json?.post_type;
  assert.equal(postType, "endorse");
});

test("CLI query --deliver with no friends is a no-op (no throw)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-cli-"));
  await handleCli(["init", "--home", home, "--name", "C"]);
  const r = await handleCli(["query", "--home", home, "--body", "what?", "--deliver"]);
  const json = r.json as any;
  const postType = json?.post?.post_type ?? json?.post_type;
  assert.equal(postType, "query");
});

// ─── A4: /api/received endpoint ─────────────────────────────────────────────

async function closeServer(server: { close(cb: (e?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve()))
  );
}

test("/api/received returns grouped received posts (authed)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-http-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "owner.openclaw.local", displayName: "owner" });

  const server = await startEdgeBookServer({ home, host: "127.0.0.1", port: 0 });
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  try {
    // Login (dev-bypass)
    const loginRes = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_method: "dev-bypass" }),
    });
    const loginBody = (await loginRes.json()) as any;
    const sessionId = loginBody.session_id as string;
    const csrf = loginBody.csrf_token as string;

    const res = await fetch(`${base}/api/received`, {
      headers: { "x-openclaw-session": sessionId, "x-openclaw-csrf": csrf },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok("signals" in body);
    assert.ok("ephemeral" in body);
    assert.ok("answers" in body);
    assert.ok("endorsements" in body);
  } finally {
    await closeServer(server);
  }
});

test("/api/received rejects unauthenticated", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mbx-http-unauth-"));
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "owner2.openclaw.local", displayName: "owner2" });

  const server = await startEdgeBookServer({ home, host: "127.0.0.1", port: 0 });
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/api/received`);
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});

// ─── Fix 1 regression: relayed post from a non-friend author is rejected ────

test("relayed post from a non-friend author is rejected (author binding)", async () => {
  // Alice and Bob are friends; Carol and Alice are friends; Carol is NOT Bob's friend.
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  const carol = await tmp("carol");

  // Bob <-> Alice: friends
  await alice.upsertContactFromCard(await bob.buildCard(), "friend");
  await bob.upsertContactFromCard(await alice.buildCard(), "friend");

  // Carol <-> Alice: friends (so Alice knows Carol's key for verification)
  await alice.upsertContactFromCard(await carol.buildCard(), "friend");
  await carol.upsertContactFromCard(await alice.buildCard(), "friend");

  // Bob does NOT know Carol (she's not in his contacts as a friend)
  await bob.upsertContactFromCard(await carol.buildCard(), "none");

  // Carol creates a genuine Answer (signed by Carol, answerer_agent_id = carol)
  const carolId = (await carol.identity()).agent_id;
  const aliceId = (await alice.identity()).agent_id;

  const carolAnswer = await carol.createAnswer({
    parent: { uri: "edgebook:query:x", hash: "abc" },
    body: "carol's answer",
  });

  // Alice crafts a post_publish envelope to Bob wrapping Carol's answer,
  // but injects from_agent: aliceId to make it look like Alice authored it.
  // The answerer_agent_id remains carolId (Carol's signature is over carolId).
  const injectedPost = { ...carolAnswer, from_agent: aliceId };
  const env = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: injectedPost as any,
  });

  // Bob must REJECT this: the per-type author (answerer_agent_id = carol) does not
  // match the envelope sender (alice), so the author binding check must fire.
  await assert.rejects(
    () => bob.receivePostPublish(env),
    /author|mismatch/i,
    "should reject when answerer_agent_id does not match envelope sender",
  );
});

// ─── Fix 3: unknown post_type rejected; blocked sender rejected ──────────────

test("unknown post_type in friend envelope is rejected", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await alice.upsertContactFromCard(await bob.buildCard(), "friend");
  await bob.upsertContactFromCard(await alice.buildCard(), "friend");

  // Build a post with an unknown type
  const fakePost = {
    post_id: "post_fake_001",
    post_type: "future_type",
    from_agent: (await alice.identity()).agent_id,
    body: "unknown type payload",
    created_at: new Date().toISOString(),
    signature: "invalidsig",
  };

  const env = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: fakePost as any,
  });

  await assert.rejects(
    () => bob.receivePostPublish(env),
    /signature|invalid|author|mismatch/i,
    "unknown post_type should be rejected (verifyReceivedPost returns false or author mismatch)",
  );
});

test("blocked sender is rejected with /friend/i", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");

  // Bob knows Alice but has blocked her
  await alice.upsertContactFromCard(await bob.buildCard(), "friend");
  await bob.upsertContactFromCard(await alice.buildCard(), "blocked");

  const sig = await alice.createSignal({ body: "from blocked alice" });
  const env = await alice.signPostPublishEnvelope({
    to_agent_id: (await bob.identity()).agent_id,
    post: sig,
  });

  await assert.rejects(
    () => bob.receivePostPublish(env),
    /friend/i,
    "blocked sender should be rejected with a friend-gate error",
  );
});
