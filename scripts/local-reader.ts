// Local reader harness for UI testing: spawns the host on localhost + a real
// agent dialed into it, pairs nothing (prints a code), writes a status file with
// the URL + code, and stays alive. Fast + reliable (no long-haul). Used to
// browser-test reader flows (e.g. ea-claude-051 post-create re-render).
//
// Run: node scripts/local-reader.ts   (EDGE_BOOK_HOST_DIR optional)

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EdgeBookDialoutClient } from "../src/dialout.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

const HOST_DIR = process.env.EDGE_BOOK_HOST_DIR || path.join(os.homedir(), "claude", "edge-book-host");
const PORT = 20000 + crypto.randomInt(20000);
const BASE = `http://127.0.0.1:${PORT}`;
const statusFile = path.join(os.tmpdir(), "edge-book-local-reader.txt");

async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }
async function waitFor(p: () => Promise<boolean>, label: string, ms = 8000) {
  const s = Date.now();
  while (!(await p())) { if (Date.now() - s > ms) throw new Error("timeout: " + label); await sleep(100); }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-reader-"));
  const dataDir = path.join(root, "host-data");
  await fs.mkdir(dataDir, { recursive: true });
  const entry = path.join(HOST_DIR, "dist", "server.js");
  const host: ChildProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, COOKIE_INSECURE: "1", NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"]
  });
  await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, "host");

  const store = new EdgeBookStore({ home: path.join(root, "agent") });
  await store.init({ handle: "owner.local", ownerLabel: "Owner" });
  const client = new EdgeBookDialoutClient({ home: store.home, host: `ws://127.0.0.1:${PORT}/agent/ws`, reconnect: true });
  await client.start();

  const reg = await client.pair(10 * 60 * 1000);
  await fs.writeFile(statusFile, `base: ${BASE}\npair: ${BASE}/pair\ncode: ${reg.code}\n`);
  console.log(`READER ${BASE}/pair  CODE ${reg.code}  (status: ${statusFile})`);

  // keep alive; re-mint a code every 5 min
  for (;;) {
    await sleep(5 * 60 * 1000);
    try { const r = await client.pair(10 * 60 * 1000); await fs.writeFile(statusFile, `base: ${BASE}\npair: ${BASE}/pair\ncode: ${r.code}\n`); } catch { /* */ }
  }
  void host;
}
main().catch((e) => { console.error("local-reader FAIL:", e?.stack || e); process.exit(1); });
