// Shared CLI plumbing (split from cli.ts): flag parsing, envelope file IO,
// and delivery helpers used by every per-feature command module. cli.ts
// re-exports CliContext/CliResult so the package's frozen public surface is
// unchanged.
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DIALOUT_HOST, deliverEnvelopeViaMailbox } from "./dialout.ts";
import type { DialoutSocket } from "./dialout.ts";
import { EdgeBookError, EdgeBookStore, type MessageEnvelope } from "./edge-book.ts";
import type { HermesRunner } from "./host-cron.ts";
import { postEnvelope, postRelayEnvelope } from "./http-relay.ts";
import type { SelfUpdateDeps } from "./self-update.ts";
import { recordOutboxEntry } from "./store-outbox.ts";

export interface CliContext {
  home?: string;
  defaultHost?: string;
  textOnly?: boolean;
  socketFactory?: (url: string) => DialoutSocket;
  // spec-141: injectable host scheduler runner (tests only); cli.ts falls
  // back to defaultHermesRunner(). Additive — frozen surface unchanged.
  hermesRunner?: HermesRunner;
  // spec-142: injectable self-update deps (tests only — mocked registry +
  // npm install). Additive — frozen surface unchanged.
  selfUpdateDeps?: SelfUpdateDeps;
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

// Deliver over the host mailbox, record the outbox ledger entry, and render
// honest state wording (spec-097 §C.2): "Sent" when the recipient's agent is
// live, "Queued" when not, and the caller's legacy wording when the host
// predates receipts (recipient_live absent from the ack). Every mailbox
// --deliver path routes through here so all of them record without copies.
export async function deliverViaMailboxRecorded(
  envelope: MessageEnvelope,
  opts: { home?: string; host: string; socketFactory?: CliContext["socketFactory"] },
  legacyText: (id: string) => string,
): Promise<{ id: string; recipient_live?: boolean; text: string }> {
  const ack = await deliverEnvelopeViaMailbox({ home: opts.home, host: opts.host, socketFactory: opts.socketFactory, envelope });
  await recordOutboxEntry(opts.home, {
    id: ack.id,
    to_agent_id: envelope.to_agent_id,
    envelope_type: envelope.type,
    ...(typeof ack.recipient_live === "boolean" ? { recipient_live: ack.recipient_live } : {})
  });
  if (ack.recipient_live === true) {
    return { ...ack, text: `Sent ${envelope.type} to ${envelope.to_agent_id} — recipient's agent is connected (host id ${ack.id}).` };
  }
  if (ack.recipient_live === false) {
    return { ...ack, text: `Queued ${envelope.type} to ${envelope.to_agent_id} — recipient's agent is NOT connected; it will arrive when they reconnect. Check later: edge-book outbox (host id ${ack.id}).` };
  }
  return { ...ack, text: legacyText(ack.id) };
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
    await deliverViaMailboxRecorded(envelope, { home: store.home, host, socketFactory },
      (id) => `Delivered post_publish (host id ${id})`);
    count++;
  }
  return count;
}
