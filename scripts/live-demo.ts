// Live demo against the DEPLOYED host: stands up two real agents (Alice, Bob),
// Alice shares one real object to Bob over the host mailbox, and keeps Bob's
// agent connected so a browser can pair to Bob's hosted reader and SEE it.
// Prints a fresh pairing code on an interval (codes are single-use, 5-min TTL).
//
// Run (background): node scripts/live-demo.ts
//   EDGE_BOOK_REMOTE_BASE=https://edge-book-host.fly.dev (default)

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

const BASE = process.env.EDGE_BOOK_REMOTE_BASE || "https://edge-book-host.fly.dev";
const WS = `${BASE.replace(/^http/, "ws")}/agent/ws`;

function log(m: string): void { console.log(`[demo] ${m}`); }
async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-livedemo-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.local", ownerLabel: "Alice" });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob" });
  const bobId = (await bob.identity()).agent_id;

  // Friend Alice ↔ Bob.
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));

  // Alice creates one object (with an attachment) and shares it to Bob over the
  // deployed host mailbox.
  const object = await alice.createObject({
    title: "Can you review the venue contract?",
    body: "Two liability clauses need a second pair of eyes before Friday. Notes inside the PDF.",
    attachment: { filename: "venue-contract.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 Edge Book live demo attachment\n") }
  });
  const aliceClient = new EdgeBookDialoutClient({ home: alice.home, host: WS, reconnect: false });
  await aliceClient.start();
  const ack = await aliceClient.sendEnvelope(await alice.shareObjectEnvelope(bobId, object.object_id));
  await aliceClient.stop();
  log(`Alice shared object ${object.object_id} to Bob over the mailbox (host id ${ack.id})`);

  // Bob comes online and applies the queued share.
  const bobClient = new EdgeBookDialoutClient({ home: bob.home, host: WS, reconnect: true });
  await bobClient.start();
  for (let i = 0; i < 40 && !(await bob.canReadObject(object.object_id, bobId)); i++) await sleep(250);
  log(`Bob ${(await bob.canReadObject(object.object_id, bobId)) ? "has" : "has NOT"} applied the shared object`);

  console.log("\n========================================================");
  console.log(` READER:    ${BASE}/pair`);
  console.log(` Bob agent: ${bobId}`);
  console.log(` Object:    "${object.request.title}"`);
  console.log("========================================================\n");

  // Keep Bob connected and mint a fresh pairing code periodically.
  for (;;) {
    try {
      const reg = await bobClient.pair(5 * 60 * 1000);
      console.log(`[demo] PAIRING CODE: ${reg.code}   (valid 5 min — enter at ${BASE}/pair)`);
    } catch (e) {
      log(`pair mint failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(120_000);
  }
}

main().catch((err) => { console.error(`[demo] FAIL: ${err?.stack || err}`); process.exit(1); });
