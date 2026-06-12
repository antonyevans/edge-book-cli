/**
 * spec-140: received-posts CLI surface — see and answer friends' posts.
 * Run: node --test test/received-posts-surface.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore, contentHash } from "../src/edge-book.ts";
import type { MessageEnvelope } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

async function tmp(name = "me"): Promise<EdgeBookStore> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-recv-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: name + ".openclaw.local", displayName: name });
  return s;
}

async function friend(a: EdgeBookStore, b: EdgeBookStore): Promise<void> {
  await a.upsertContactFromCard(await b.buildCard(), "friend");
  await b.upsertContactFromCard(await a.buildCard(), "friend");
}

// Deliver a signed post from `from` into `to`'s received-posts store.
async function deliverPost(from: EdgeBookStore, to: EdgeBookStore, post: unknown): Promise<void> {
  const env = await from.signPostPublishEnvelope({
    to_agent_id: (await to.identity()).agent_id,
    post: post as never,
  });
  await to.receivePostPublish(env);
}

// Fake mailbox socket: acks hello + mailbox_send so --deliver completes, and
// captures every sent frame so tests can decode the delivered envelopes.
class FakeSocket {
  sent: Record<string, unknown>[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "test-channel" }));
    if (frame.type === "mailbox_send") queueMicrotask(() => this.receive({ type: "mailbox_send_ok", request_id: frame.request_id, id: "m-1", recipient_live: true }));
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (event?: unknown) => void): void {
    (this.listeners[event] ||= []).push(handler);
  }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

function captureMailbox(): { factory: (url: string) => FakeSocket; envelopes: () => MessageEnvelope[] } {
  const sockets: FakeSocket[] = [];
  const factory = (): FakeSocket => {
    const s = new FakeSocket();
    sockets.push(s);
    queueMicrotask(() => s.emit("open"));
    return s;
  };
  const envelopes = (): MessageEnvelope[] =>
    sockets.flatMap((s) => s.sent.filter((f) => f.type === "mailbox_send"))
      .map((f) => JSON.parse(Buffer.from(f.blob_b64 as string, "base64").toString("utf8")) as MessageEnvelope);
  return { factory: factory as never, envelopes };
}

// ─── ephemeral: { mine, received } ──────────────────────────────────────────

test("ephemeral lists a received friend query under received and own posts under mine", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);
  const aliceId = (await alice.identity()).agent_id;

  const q = await alice.createEphemeral("query", { body: "who can scrape?" });
  await deliverPost(alice, bob, q);
  const own = await bob.createEphemeral("share", { body: "my own share" });

  const r = await handleCli(["ephemeral", "--home", bob.home]);
  const json = r.json as { mine: Record<string, any>; received: Record<string, any> };
  assert.ok(json.mine[own.post_id], "own post listed under mine");
  const key = aliceId + ":" + q.post_id;
  assert.ok(json.received[key], "received query listed under received");
  assert.equal(json.received[key].body, "who can scrape?");
});

test("ephemeral received excludes expired and tombstoned posts", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);
  const aliceId = (await alice.identity()).agent_id;

  // Expired: lifecycle still stamped "active" by the sender, but past expires_at.
  const expired = await alice.createEphemeral("query", { body: "stale", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await deliverPost(alice, bob, expired);

  // Tombstoned: sender deleted the query before sending; lifecycle is mutable
  // metadata outside the signature, so the post still verifies.
  const dead = await alice.createEphemeral("query", { body: "deleted" });
  await alice.deleteQuery(dead.post_id);
  await deliverPost(alice, bob, (await alice.ephemeralPosts())[dead.post_id]);

  // Active: must be the only one surfaced.
  const live = await alice.createEphemeral("query", { body: "live" });
  await deliverPost(alice, bob, live);

  const r = await handleCli(["ephemeral", "--home", bob.home]);
  const json = r.json as { received: Record<string, any> };
  assert.deepEqual(Object.keys(json.received), [aliceId + ":" + live.post_id]);
});

// ─── answers: { mine, received } ────────────────────────────────────────────

test("answers lists a received answer under received and own answers under mine", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);
  const bobId = (await bob.identity()).agent_id;

  const q = await alice.createEphemeral("query", { body: "q" });
  const ownAns = await alice.createAnswer({ parent: { uri: "edgebook:query:x", hash: "h" }, body: "self" });
  const bobAns = await bob.createAnswer({
    parent: { uri: "edgebook:query:" + q.post_id, hash: "h" },
    body: "from bob",
  });
  await deliverPost(bob, alice, bobAns);

  const r = await handleCli(["answers", "--home", alice.home]);
  const json = r.json as { mine: Record<string, any>; received: Record<string, any> };
  assert.ok(json.mine[ownAns.answer_id], "own answer listed under mine");
  const key = bobId + ":" + bobAns.answer_id;
  assert.ok(json.received[key], "received answer listed under received");
  assert.equal(json.received[key].body, "from bob");
});

// ─── answer <query-id> resolves received queries ────────────────────────────

test("answer resolves a received query: parent strongRef built from the received post", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);

  const q = await alice.createEphemeral("query", { body: "need a scraper" });
  await deliverPost(alice, bob, q);

  const r = await handleCli(["answer", q.post_id, "--home", bob.home, "--body", "I can do it"]);
  const ans = r.json as any;
  assert.equal(ans.post_type, "answer");
  assert.equal(ans.parent.uri, "edgebook:query:" + q.post_id);
  const stored = (await bob.receivedByCategory()).ephemeral[(await alice.identity()).agent_id + ":" + q.post_id] as any;
  const { signature: _sig, lifecycle: _lc, ...unsigned } = stored;
  assert.equal(ans.parent.hash, contentHash(unsigned), "parent.hash is the content hash of the received query");
});

test("answer prefers a local query over a received one with the same id", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);

  const local = await bob.createEphemeral("query", { body: "local question" });
  // Plant a received post with the SAME post_id (cannot happen via random ids;
  // forged directly into the store to exercise resolution order).
  const foreign = await alice.createEphemeral("query", { body: "foreign question" });
  const recv = await bob.receivedPosts();
  recv[(await alice.identity()).agent_id + ":" + local.post_id] = { ...foreign, post_id: local.post_id } as never;
  await bob.saveReceivedPosts(recv);

  const r = await handleCli(["answer", local.post_id, "--home", bob.home, "--body", "answering"]);
  const ans = r.json as any;
  const { signature: _sig, lifecycle: _lc, ...unsigned } = local as any;
  assert.equal(ans.parent.hash, contentHash(unsigned), "parent must hash the LOCAL query");
});

test("answer errors ambiguous_query when the same post_id was received from multiple senders", async () => {
  const alice = await tmp("alice");
  const carol = await tmp("carol");
  const bob = await tmp("bob");
  await friend(alice, bob);
  await friend(carol, bob);

  const qa = await alice.createEphemeral("query", { body: "from alice" });
  const qc = await carol.createEphemeral("query", { body: "from carol" });
  const recv = await bob.receivedPosts();
  recv[(await alice.identity()).agent_id + ":" + qa.post_id] = qa as never;
  recv[(await carol.identity()).agent_id + ":" + qa.post_id] = { ...qc, post_id: qa.post_id } as never;
  await bob.saveReceivedPosts(recv);

  await assert.rejects(
    () => handleCli(["answer", qa.post_id, "--home", bob.home, "--body", "x"]),
    (e: Error & { code?: string }) => e.code === "ambiguous_query",
  );
});

test("answer still errors not_found for an unknown query id (regression)", async () => {
  const bob = await tmp("bob");
  await assert.rejects(
    () => handleCli(["answer", "eph-nope", "--home", bob.home, "--body", "x"]),
    (e: Error & { code?: string }) => e.code === "not_found",
  );
});

// ─── answer --deliver targets the received query's author ──────────────────

test("answer --deliver to a received query reaches the author even when not in the friend fan-out", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);
  const aliceId = (await alice.identity()).agent_id;

  const q = await alice.createEphemeral("query", { body: "anyone?" });
  await deliverPost(alice, bob, q);
  // Downgrade: alice is no longer bob's friend, so broadcast fan-out skips her.
  await bob.upsertContactFromCard(await alice.buildCard(), "none");

  const mbx = captureMailbox();
  const r = await handleCli(
    ["answer", q.post_id, "--home", bob.home, "--body", "me", "--deliver"],
    { socketFactory: mbx.factory as never },
  );
  assert.equal((r.json as any).delivered, 1);
  const envs = mbx.envelopes();
  assert.equal(envs.length, 1);
  assert.equal(envs[0]!.type, "post_publish");
  assert.equal(envs[0]!.to_agent_id, aliceId, "delivery must target the query's author");
});

test("answer --deliver does not double-send when the author is already a friend", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);
  const aliceId = (await alice.identity()).agent_id;

  const q = await alice.createEphemeral("query", { body: "anyone?" });
  await deliverPost(alice, bob, q);

  const mbx = captureMailbox();
  await handleCli(
    ["answer", q.post_id, "--home", bob.home, "--body", "me", "--deliver"],
    { socketFactory: mbx.factory as never },
  );
  const toAuthor = mbx.envelopes().filter((e) => e.to_agent_id === aliceId);
  assert.equal(toAuthor.length, 1, "author gets exactly one copy via the friend fan-out");
});

// ─── full round trip via CLI ────────────────────────────────────────────────

test("round trip: A query --deliver → B ephemeral sees it → B answer --deliver → A answers sees it", async () => {
  const alice = await tmp("alice");
  const bob = await tmp("bob");
  await friend(alice, bob);
  const aliceId = (await alice.identity()).agent_id;
  const bobId = (await bob.identity()).agent_id;

  // A asks.
  const amx = captureMailbox();
  const qr = await handleCli(
    ["query", "--home", alice.home, "--body", "who has compute?", "--deliver"],
    { socketFactory: amx.factory as never },
  );
  const qid = (qr.json as any).post.post_id as string;
  const qEnv = amx.envelopes().find((e) => e.to_agent_id === bobId);
  assert.ok(qEnv, "query delivered to bob");
  await bob.receiveEnvelope(qEnv!);

  // B sees it.
  const seen = await handleCli(["ephemeral", "--home", bob.home]);
  assert.ok((seen.json as any).received[aliceId + ":" + qid], "B's ephemeral lists A's query");

  // B answers.
  const bmx = captureMailbox();
  const ar = await handleCli(
    ["answer", qid, "--home", bob.home, "--body", "I do", "--deliver"],
    { socketFactory: bmx.factory as never },
  );
  const ansId = (ar.json as any).post.answer_id as string;
  const aEnv = bmx.envelopes().find((e) => e.to_agent_id === aliceId);
  assert.ok(aEnv, "answer delivered to alice");
  await alice.receiveEnvelope(aEnv!);

  // A sees the answer.
  const got = await handleCli(["answers", "--home", alice.home]);
  const received = (got.json as any).received as Record<string, any>;
  assert.ok(received[bobId + ":" + ansId], "A's answers lists B's answer under received");
  assert.equal(received[bobId + ":" + ansId].parent.uri, "edgebook:query:" + qid);
});
