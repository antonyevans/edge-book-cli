// The dev/file relay (split from http.ts): createRelayServer + startRelayServer
// serve a per-agent JSONL mailbox under /relay/:agentId, and postEnvelope /
// postRelayEnvelope / pullRelayEnvelopes are the matching client helpers used
// by the CLI delivery paths. Route shape and envelope semantics are unchanged.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { EdgeBookError } from "./edge-book.ts";
import type { MessageEnvelope } from "./edge-book.ts";
import { readJsonBody, sendError, sendJson } from "./http.ts";

export interface RelayOptions {
  host?: string;
  port?: number;
  store: string;
}

function relayFile(store: string, agentId: string): string {
  return path.join(store, `${encodeURIComponent(agentId)}.jsonl`);
}

async function appendRelayEnvelope(store: string, agentId: string, envelope: MessageEnvelope): Promise<void> {
  await fs.mkdir(store, { recursive: true });
  await fs.appendFile(relayFile(store, agentId), `${JSON.stringify(envelope)}\n`, "utf8");
}

async function drainRelayEnvelopes(store: string, agentId: string): Promise<MessageEnvelope[]> {
  const file = relayFile(store, agentId);
  try {
    const text = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "", "utf8");
    return text.split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as MessageEnvelope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function createRelayServer(store: string): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const match = /^\/relay\/([^/]+)$/.exec(url.pathname);
      if (!match) {
        sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      const agentId = decodeURIComponent(match[1]!); // capture group is mandatory on a successful exec
      if (req.method === "POST") {
        const envelope = await readJsonBody<MessageEnvelope>(req);
        await appendRelayEnvelope(store, agentId, envelope);
        sendJson(res, 200, { ok: true, queued: 1 });
        return;
      }
      if (req.method === "GET") {
        const envelopes = await drainRelayEnvelopes(store, agentId);
        sendJson(res, 200, { ok: true, envelopes });
        return;
      }
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    } catch (error) {
      sendError(res, error);
    }
  });
}

export async function startRelayServer(options: RelayOptions): Promise<http.Server> {
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 0;
  const server = createRelayServer(options.store);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

export async function postEnvelope(endpoint: string, envelope: MessageEnvelope): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope)
  });
  if (!response.ok) throw new EdgeBookError("delivery_failed", `Delivery failed: ${response.status} ${await response.text()}`);
}

export async function postRelayEnvelope(relayBaseUrl: string, recipientAgentId: string, envelope: MessageEnvelope): Promise<void> {
  await postEnvelope(`${relayBaseUrl.replace(/\/$/, "")}/relay/${encodeURIComponent(recipientAgentId)}`, envelope);
}

export async function pullRelayEnvelopes(relayBaseUrl: string, recipientAgentId: string): Promise<MessageEnvelope[]> {
  const response = await fetch(`${relayBaseUrl.replace(/\/$/, "")}/relay/${encodeURIComponent(recipientAgentId)}`);
  if (!response.ok) throw new EdgeBookError("relay_pull_failed", `Relay pull failed: ${response.status}`);
  const body = await response.json() as { envelopes?: MessageEnvelope[] };
  return body.envelopes || [];
}
