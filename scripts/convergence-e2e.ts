// ea-claude-062 convergence — REAL two-agent loop through the REAL host.
//
// Spawns edge-book-host (the host I built), runs two real edge-book agents as
// dial-out clients against it, and drives the full spec-0020 acceptance loop:
//   friend → Alice shares one object+grant to Bob over the host mailbox →
//   Bob's hosted reader shows it (grant-gated, through the host proxy) →
//   Alice revokes → Bob denied → non-friend Carol never saw it → all audited.
// Exits nonzero on any failure (acceptance criterion).
//
// Run: node scripts/convergence-e2e.ts
// Host path override: EDGE_BOOK_HOST_DIR=/path/to/edge-book-host

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

const HOST_DIR = process.env.EDGE_BOOK_HOST_DIR || path.join(os.homedir(), "claude", "edge-book-host");
// Remote mode: point at an already-running host (e.g. the deployed fly app)
// instead of spawning one. Set EDGE_BOOK_REMOTE_BASE=https://edge-book-host.fly.dev.
const REMOTE_BASE = process.env.EDGE_BOOK_REMOTE_BASE;
const PORT = 20000 + crypto.randomInt(20000);
const BASE = REMOTE_BASE || `http://127.0.0.1:${PORT}`;
const WS = REMOTE_BASE
  ? `${REMOTE_BASE.replace(/^http/, "ws")}/agent/ws`
  : `ws://127.0.0.1:${PORT}/agent/ws`;

function log(msg: string): void { console.log(`[e2e] ${msg}`); }
async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
async function waitFor(pred: () => boolean | Promise<boolean>, label: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
}

// Minimal cookie jar for the reader (browser) side.
function jar() {
  const cookies = new Map<string, string>();
  return {
    absorb(res: Response) {
      const h = res.headers as unknown as { getSetCookie?: () => string[] };
      const list = h.getSetCookie ? h.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
      for (const c of list) {
        const [first] = c.split(";");
        const eq = first.indexOf("=");
        if (eq < 0) continue;
        const k = first.slice(0, eq).trim();
        const v = first.slice(eq + 1).trim();
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
    },
    header() { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "); },
    get(k: string) { return cookies.get(k); }
  };
}

async function startHost(dataDir: string): Promise<ChildProcess> {
  const entry = path.join(HOST_DIR, "dist", "server.js");
  await fs.access(entry).catch(() => { throw new Error(`host build not found at ${entry} — run \`npm run build\` in ${HOST_DIR}`); });
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, COOKIE_INSECURE: "1", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`  host| ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`  host! ${d}`));
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; }
  }, "host healthz");
  return child;
}

// Pair a browser session to a dial-out client's channel and return a cookie jar.
async function pairReader(client: EdgeBookDialoutClient): Promise<ReturnType<typeof jar>> {
  const cookies = jar();
  const get = await fetch(`${BASE}/pair`);
  cookies.absorb(get); await get.text();
  const csrf = cookies.get("ebh_pair_csrf")!;
  const reg = await client.pair(60_000);             // agent registers the code on the host
  await sleep(150);                                   // let pair_register round-trip
  const form = new URLSearchParams({ csrf, code: reg.code });
  const post = await fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies.header() },
    body: form.toString(),
    redirect: "manual"
  });
  cookies.absorb(post);
  assert.equal(post.status, 303, "reader pairing established a session");
  return cookies;
}

async function readerGet(cookies: ReturnType<typeof jar>, pathName: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${pathName}`, { headers: { cookie: cookies.header() } });
  const text = await res.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-e2e-"));
  const hostData = path.join(root, "host-data");
  await fs.mkdir(hostData, { recursive: true });
  let host: ChildProcess | undefined;
  const clients: EdgeBookDialoutClient[] = [];
  try {
    if (REMOTE_BASE) {
      log(`using REMOTE host ${REMOTE_BASE} (no local host spawned)`);
      await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, "remote host healthz");
    } else {
      log(`starting host on :${PORT}`);
      host = await startHost(hostData);
    }

    // Three real agents.
    const alice = new EdgeBookStore({ home: path.join(root, "alice") });
    const bob = new EdgeBookStore({ home: path.join(root, "bob") });
    const carol = new EdgeBookStore({ home: path.join(root, "carol") });
    await alice.init({ handle: "alice.local", ownerLabel: "Alice" });
    await bob.init({ handle: "bob.local", ownerLabel: "Bob" });
    await carol.init({ handle: "carol.local", ownerLabel: "Carol" });
    const bobId = (await bob.identity()).agent_id;
    const carolId = (await carol.identity()).agent_id;

    // Friend Alice ↔ Bob (bootstrap done locally; the share is what rides the mailbox).
    const aliceCard = await alice.writeCard();
    const bobCard = await bob.writeCard();
    await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
    await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
    log("Alice ↔ Bob friended");

    // Dial-out clients for Alice (sharer) and Bob (recipient + reader).
    const aliceClient = new EdgeBookDialoutClient({ home: alice.home, host: WS, reconnect: false });
    const bobClient = new EdgeBookDialoutClient({ home: bob.home, host: WS, reconnect: false });
    clients.push(aliceClient, bobClient);
    await aliceClient.start();
    await bobClient.start();
    log("both agents dialed in to the host");

    // Pair Bob's hosted reader session.
    const bobReader = await pairReader(bobClient);
    log("Bob's hosted reader paired");

    // Before any share, Bob's reader shows nothing.
    let shared = await readerGet(bobReader, "/api/shared-objects");
    assert.equal(shared.status, 200);
    assert.equal(shared.body.objects.length, 0, "nothing shared by default");

    // Alice creates ONE object (request + one attachment) and shares it to Bob
    // over the REAL host mailbox.
    const object = await alice.createObject({
      title: "Review the venue contract",
      body: "Two liability clauses need a second pair of eyes before Friday.",
      attachment: { filename: "contract.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 e2e bytes") }
    });
    const shareEnv = await alice.shareObjectEnvelope(bobId, object.object_id);
    const ack = await aliceClient.sendEnvelope(shareEnv);
    log(`Alice shared object ${object.object_id} → host mailbox id ${ack.id}`);

    // Bob receives + applies over the mailbox.
    await waitFor(() => bob.canReadObject(object.object_id, bobId), "Bob applies the shared object");

    // Bob's HOSTED READER shows the object (grant-gated, through the host proxy).
    await waitFor(async () => (await readerGet(bobReader, "/api/shared-objects")).body.objects.length === 1, "reader shows the object");
    shared = await readerGet(bobReader, "/api/shared-objects");
    assert.equal(shared.body.objects[0].object_id, object.object_id);
    assert.equal(shared.body.objects[0].request.title, object.request.title);
    assert.equal(shared.body.objects[0].grant_scope, "object.read");
    for (const banned of ["status", "state", "verified", "paid"]) assert.ok(!(banned in shared.body.objects[0]), `R4: no '${banned}' field`);
    log("✓ Bob's hosted reader shows the shared object");

    // The attachment is fetchable through the reader.
    const att = await fetch(`${BASE}/api/shared-objects/${encodeURIComponent(object.object_id)}/attachment`, { headers: { cookie: bobReader.header() } });
    assert.equal(att.status, 200);
    assert.equal(Buffer.from(await att.arrayBuffer()).toString("utf8"), "%PDF-1.4 e2e bytes");
    log("✓ attachment served through the reader");

    // Non-friend Carol never received it and cannot read it.
    assert.equal(await carol.canReadObject(object.object_id, carolId), false);
    assert.equal((await carol.objects())[object.object_id], undefined);
    log("✓ non-friend Carol never saw it");

    // Alice revokes and forwards the revoke to Bob over the mailbox.
    const revokeEnv = await alice.revokeObjectEnvelope(bobId, object.object_id);
    await aliceClient.sendEnvelope(revokeEnv);
    await waitFor(async () => !(await bob.canReadObject(object.object_id, bobId)), "Bob denied after revoke");
    const afterRevoke = await readerGet(bobReader, "/api/shared-objects");
    assert.equal(afterRevoke.body.objects.length, 0, "reader hides the object after revoke");
    log("✓ after revoke, Bob is denied (forward-looking) and the reader hides it");

    // Audit chains on both sides.
    const aliceActions = (await alice.auditEvents()).map((e) => e.action);
    for (const a of ["object.create", "grant.issue", "grant.revoke"]) assert.ok(aliceActions.includes(a), `alice audit missing ${a}`);
    const bobActions = (await bob.auditEvents()).map((e) => e.action);
    for (const a of ["object.receive", "object.access"]) assert.ok(bobActions.includes(a), `bob audit missing ${a}`);
    log("✓ full audit chain present on both sides");

    log("CONVERGENCE PASS — pair → share over mailbox → reader shows for B only → revoke → denied → non-friend never saw it → audited");
  } finally {
    for (const c of clients) await c.stop().catch(() => undefined);
    host?.kill("SIGTERM");
    await sleep(200);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(() => { log("OK"); process.exit(0); }).catch((err) => { console.error(`[e2e] FAIL: ${err?.stack || err}`); process.exit(1); });
