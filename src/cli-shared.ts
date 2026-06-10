// Shared CLI plumbing (split from cli.ts): flag parsing, envelope file IO,
// and delivery helpers used by every per-feature command module. cli.ts
// re-exports CliContext/CliResult so the package's frozen public surface is
// unchanged.
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DIALOUT_HOST, deliverEnvelopeViaMailbox } from "./dialout.ts";
import type { DialoutSocket } from "./dialout.ts";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import { postEnvelope, postRelayEnvelope } from "./http.ts";

export interface CliContext {
  home?: string;
  defaultHost?: string;
  textOnly?: boolean;
  socketFactory?: (url: string) => DialoutSocket;
}

export interface CliResult {
  text: string;
  json?: unknown;
}

export function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

export function parseHome(args: string[], ctx: CliContext): string | undefined {
  return takeFlag(args, "--home") || ctx.home;
}

export function parseHost(args: string[], ctx: CliContext): string {
  return takeFlag(args, "--host") || ctx.defaultHost || process.env.EDGE_BOOK_HOST || DEFAULT_DIALOUT_HOST;
}

// Derive the relay's https origin from the dial-out host (wss://host/agent/ws -> https://host).
export function relayBaseFromHost(host: string): string {
  return host.replace(/\/agent\/ws\/?$/, "").replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

export function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new EdgeBookError("missing_arg", `Missing ${label}`);
  return value;
}

export function takeBoolFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

// Collect every `--social label=value` occurrence (repeatable), removing them.
export function takeRepeatedKV(args: string[], flag: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  let idx: number;
  while ((idx = args.indexOf(flag)) !== -1) {
    const raw = args[idx + 1] ?? "";
    args.splice(idx, 2);
    const eq = raw.indexOf("=");
    if (eq === -1) throw new EdgeBookError("bad_social", `--social expects label=value, got "${raw}"`);
    out.push({ label: raw.slice(0, eq), value: raw.slice(eq + 1) });
  }
  return out;
}

// Collect every `--flag value` occurrence (repeatable plain string), removing them.
export function takeRepeated(args: string[], flag: string): string[] {
  const out: string[] = [];
  let idx: number;
  while ((idx = args.indexOf(flag)) !== -1) {
    out.push(args[idx + 1] ?? "");
    args.splice(idx, 2);
  }
  return out;
}

export async function readEnvelope(filePath: string) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

export async function deliverToEndpoint(envelope: Awaited<ReturnType<EdgeBookStore["signEnvelope"]>>, endpoint: string): Promise<string> {
  await postEnvelope(endpoint, envelope);
  return `Delivered ${envelope.type} to ${endpoint}`;
}

export async function deliverToPeer(store: EdgeBookStore, envelope: Awaited<ReturnType<EdgeBookStore["signEnvelope"]>>, peerAgentId: string): Promise<string> {
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  const direct = contact?.known_endpoints.find((entry) => entry.mode === "direct")?.endpoint;
  if (direct) return deliverToEndpoint(envelope, direct);
  const relay = contact?.known_endpoints.find((entry) => entry.mode === "relay")?.endpoint;
  if (relay) {
    await postRelayEnvelope(relay, peerAgentId, envelope);
    return `Queued ${envelope.type} via relay ${relay}`;
  }
  throw new EdgeBookError("no_route", `No direct or relay endpoint for ${peerAgentId}`);
}

/** Broadcast a signed post to all friends via the mailbox. Returns the number of deliveries attempted. */
export async function broadcastPost(
  store: EdgeBookStore,
  host: string,
  socketFactory: CliContext["socketFactory"],
  post: Parameters<EdgeBookStore["signPostPublishEnvelope"]>[0]["post"],
): Promise<number> {
  const contacts = await store.contacts();
  const friends = Object.values(contacts).filter((c) => c.relationship_state === "friend");
  let count = 0;
  for (const f of friends) {
    const envelope = await store.signPostPublishEnvelope({ to_agent_id: f.peer_agent_id, post });
    await deliverEnvelopeViaMailbox({ home: store.home, host, socketFactory, envelope });
    count++;
  }
  return count;
}
