// ea-claude-062 FULL JOURNEY — every step over the REAL host mailbox, from
// onboarding. Unlike convergence-e2e (which friends in-process), this exercises
// the EARLY steps that were previously untested on the real transport:
//   onboard two agents → A makes an "Add me" invite → B imports it →
//   friend-request over the mailbox → A accepts → friend-response over the
//   mailbox → both friends → A shares an object over the mailbox → B reads it.
// Exits nonzero on any failure.
//
// Local:  node scripts/journey-e2e.ts            (spawns the host)
// Remote: EDGE_BOOK_REMOTE_BASE=https://edge-book-host.fly.dev node scripts/journey-e2e.ts

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore, loadCard } from "../src/edge-book.ts";

const HOST_DIR = process.env.EDGE_BOOK_HOST_DIR || path.join(os.homedir(), "claude", "edge-book-host");
const REMOTE_BASE = process.env.EDGE_BOOK_REMOTE_BASE;
const PORT = 20000 + crypto.randomInt(20000);
const BASE = REMOTE_BASE || `http://127.0.0.1:${PORT}`;
const WS = REMOTE_BASE ? `${REMOTE_BASE.replace(/^http/, "ws")}/agent/ws` : `ws://127.0.0.1:${PORT}/agent/ws`;

function log(m: string): void { console.log(`[journey] ${m}`); }
async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
async function waitFor(pred: () => boolean | Promise<boolean>, label: string, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`assertion failed: ${msg}`); }

async function startHost(dataDir: string): Promise<ChildProcess> {
  const entry = path.join(HOST_DIR, "dist", "server.js");
  await fs.access(entry).catch(() => { throw new Error(`host build not found at ${entry} — run \`npm run build\` in ${HOST_DIR}`); });
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, COOKIE_INSECURE: "1", NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"]
  });
  await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, "host healthz");
  return child;
}

async function relationship(store: EdgeBookStore, peerId: string): Promise<string> {
  return (await store.contacts())[peerId]?.relationship_state ?? "none";
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-journey-"));
  let host: ChildProcess | undefined;
  const clients: EdgeBookDialoutClient[] = [];
  try {
    if (REMOTE_BASE) {
      log(`using REMOTE host ${REMOTE_BASE}`);
      await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, "remote healthz");
    } else {
      host = await startHost(path.join(root, "host-data"));
      log(`spawned local host on :${PORT}`);
    }

    // 1. ONBOARD — two fresh agents, no prior relationship.
    const alice = new EdgeBookStore({ home: path.join(root, "alice") });
    const bob = new EdgeBookStore({ home: path.join(root, "bob") });
    const aliceId = (await alice.init({ handle: "alice.local", ownerLabel: "Alice" })).agent_id;
    const bobId = (await bob.init({ handle: "bob.local", ownerLabel: "Bob" })).agent_id;
    log("onboarded Alice + Bob (no relationship yet)");

    // Both come online (auto-apply incoming envelopes).
    const aliceClient = new EdgeBookDialoutClient({ home: alice.home, host: WS, reconnect: false });
    const bobClient = new EdgeBookDialoutClient({ home: bob.home, host: WS, reconnect: false });
    clients.push(aliceClient, bobClient);
    await aliceClient.start();
    await bobClient.start();
    log("both agents dialed in");

    // 2. "ADD ME" — Alice produces an invite link; Bob imports it.
    const aliceCard = await alice.writeCard();
    const inviteUrl = `edgebook:invite:${Buffer.from(JSON.stringify(aliceCard), "utf8").toString("base64url")}`;
    const importedCard = await loadCard(inviteUrl); // exercises the edgebook:invite: decode path
    assert(importedCard.agent_id === aliceId, "imported invite card resolves to Alice");
    log("Bob imported Alice's invite link");

    // 3. FRIEND REQUEST over the mailbox (Bob → Alice).
    const requestEnv = await bob.createFriendRequest(importedCard, "met at Edge");
    await bobClient.sendEnvelope(requestEnv);
    await waitFor(async () => (await relationship(alice, bobId)) === "request_received", "Alice receives the friend request over the mailbox");
    log("✓ friend request delivered over the mailbox; Alice sees request_received");

    // 4. ACCEPT over the mailbox (Alice → Bob).
    const responseEnv = await alice.acceptFriend(bobId, "sure");
    await aliceClient.sendEnvelope(responseEnv);
    await waitFor(async () => (await relationship(bob, aliceId)) === "friend", "Bob applies the accept over the mailbox");
    assert((await relationship(alice, bobId)) === "friend", "Alice shows Bob as friend");
    log("✓ accept delivered over the mailbox; both sides are friends");

    // 5. SHARE an object over the mailbox (the value step, now on a real connection).
    const object = await alice.createObject({ title: "Could you review the contract?", body: "Two clauses need eyes." });
    await aliceClient.sendEnvelope(await alice.shareObjectEnvelope(bobId, object.object_id));
    await waitFor(() => bob.canReadObject(object.object_id, bobId), "Bob receives + can read the shared object");
    const read = await bob.readObject(object.object_id, bobId);
    assert(read.request.title === object.request.title, "Bob reads the shared object");
    log("✓ object shared over the mailbox and readable by Bob");

    // 6. AUDIT — the early steps wrote their events too.
    const aliceActions = (await alice.auditEvents()).map((e) => e.action);
    for (const a of ["relationship.Accept", "grant.issue", "object.create"]) assert(aliceActions.includes(a), `alice audit has ${a}`);
    const bobActions = (await bob.auditEvents()).map((e) => e.action);
    assert(bobActions.includes("object.receive"), "bob audit has object.receive");
    assert(bobActions.includes("object.access"), "bob audit has object.access");

    log("FULL JOURNEY PASS — onboard → invite import → friend over mailbox → accept over mailbox → share → read → audited");
  } finally {
    for (const c of clients) await c.stop().catch(() => undefined);
    host?.kill("SIGTERM");
    await sleep(200);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(() => { log("OK"); process.exit(0); }).catch((err) => { console.error(`[journey] FAIL: ${err?.stack || err}`); process.exit(1); });
