// Host-mailbox transport for the two-agent smoke framework (ea-openclaw-031).
// Delivers envelopes over the REAL edge-book-host mailbox instead of applying
// them in-process: each agent dials in as a dial-out client, the sender posts
// the envelope to the host, and the recipient's client auto-applies it.
// Reuses the same machinery as scripts/journey-e2e.ts.
//
//   Local host:  spawns ${hostDir}/dist/server.js on a random port.
//   Remote host: pass remoteBase (e.g. https://edge-book-host.fly.dev).
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { EdgeBookDialoutClient } from "../../src/dialout.ts";
import type { TransportFactory, AgentRuntime } from "./two-agent-smoke.ts";

export interface HostTransportOptions {
  hostDir?: string;     // local host repo (default ~/claude/edge-book-host)
  remoteBase?: string;  // e.g. https://edge-book-host.fly.dev — skips spawning
  dataDir?: string;     // host DATA_DIR when spawning
}

async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function spawnHost(hostDir: string, port: number, base: string, dataDir: string): Promise<ChildProcess> {
  const entry = path.join(hostDir, "dist", "server.js");
  await fs.access(entry).catch(() => {
    throw new Error(`host build not found at ${entry} — run \`npm run build\` in ${hostDir}`);
  });
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, COOKIE_INSECURE: "1", NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, "host healthz");
  return child;
}

export function makeHostTransport(opts: HostTransportOptions = {}): TransportFactory {
  return async (agents: { alice: AgentRuntime; bob: AgentRuntime }) => {
    const remoteBase = opts.remoteBase || process.env.EDGE_BOOK_REMOTE_BASE;
    const hostDir = opts.hostDir || process.env.EDGE_BOOK_HOST_DIR || path.join(os.homedir(), "claude", "edge-book-host");
    const port = 20000 + crypto.randomInt(20000);
    const base = remoteBase || `http://127.0.0.1:${port}`;
    const ws = remoteBase ? `${remoteBase.replace(/^http/, "ws")}/agent/ws` : `ws://127.0.0.1:${port}/agent/ws`;

    let host: ChildProcess | undefined;
    if (remoteBase) {
      await waitFor(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, "remote healthz");
    } else {
      host = await spawnHost(hostDir, port, base, opts.dataDir || path.join(agents.alice.home, "..", "host-data"));
    }

    const clients = new Map<string, EdgeBookDialoutClient>();
    for (const agent of [agents.alice, agents.bob]) {
      const client = new EdgeBookDialoutClient({ home: agent.home, host: ws, reconnect: false });
      await client.start();
      clients.set(agent.home, client);
    }

    return {
      name: remoteBase ? `host(${remoteBase})` : "host(local)",
      async deliver(from, to, envelope, applied) {
        const client = clients.get(from.home);
        if (!client) throw new Error(`no dial-out client for ${from.home}`);
        await client.sendEnvelope(envelope);
        await waitFor(applied, `${to.home} applies ${envelope.type} over the mailbox`);
      },
      async fetchAs(agent, apiPath) {
        const client = clients.get(agent.home);
        if (!client) throw new Error(`no dial-out client for ${agent.home}`);
        const cookies = new Map<string, string>();
        const add = (res: Response) => {
          const headers = res.headers as unknown as { getSetCookie?: () => string[] };
          for (const part of headers.getSetCookie?.() ?? []) {
            const [first] = part.split(";");
            const eq = first!.indexOf("=");
            if (eq !== -1) cookies.set(first!.slice(0, eq).trim(), first!.slice(eq + 1).trim());
          }
        };
        const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

        // 1) GET /pair to pick up the pair CSRF cookie.
        // (Canonical pairing flow: edge-book-host/test/integration.test.ts)
        const getRes = await fetch(`${base}/pair`, { signal: AbortSignal.timeout(15_000) });
        add(getRes);
        await getRes.text();
        const csrf = cookies.get("ebh_pair_csrf");
        if (!csrf) throw new Error("no pair CSRF cookie from host");

        // 2) The REAL agent mints a pairing code over its dial-out socket.
        // client.pair() sends the pair_register WS frame and returns immediately —
        // pair_register_ok is fire-and-forget in EdgeBookDialoutClient. Guard against
        // the HTTP POST racing the WS frame by retrying up to 3 times with 100 ms
        // backoff on non-303 responses (least-invasive fix; avoids touching src/).
        const registration = await client.pair();

        // 3) Submit the code as the browser, with retry for the pairing race.
        const form = new URLSearchParams({ csrf, code: registration.code, remember: "1" });
        let postRes!: Response;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await sleep(100 * attempt);
          postRes = await fetch(`${base}/pair`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
            body: form.toString(),
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
          add(postRes);
          if (postRes.status === 303) break;
        }
        if (postRes.status !== 303) throw new Error(`pair submit failed after 3 attempts: ${postRes.status}`);

        // 4) Authenticated GET proxied through the host to the real agent store.
        const r = await fetch(`${base}${apiPath}`, {
          headers: { cookie: cookieHeader() },
          signal: AbortSignal.timeout(15_000),
        });
        const text = await r.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`fetchAs: non-JSON response (status ${r.status}): ${text.slice(0, 200)}`);
        }
        return { status: r.status, body };
      },
      async close() {
        for (const c of clients.values()) await c.stop().catch(() => undefined);
        host?.kill("SIGTERM");
        await sleep(200);
      },
    };
  };
}
