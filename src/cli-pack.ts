// Starter-pack CLI commands (spec-145): `pack list`, `pack show <slug>`,
// `pack join <slug> [--deliver]`. A pack is curation, not trust — the host
// stores member handle slugs only; join resolves each handle live through the
// spec-138 resolver path and sends a NORMAL friend request per member. No
// auto-accept, no grant, no state beyond request_sent.
//
// Host endpoints (edge-book-host src/packs.ts):
//   GET /packs        — public listing (no member handles)
//   GET /pack/:slug   — authenticated (Bearer dial-out agent_key, known
//                       channel); rate-limited per agent per pack — fetch
//                       failures here surface as domain errors with a next
//                       action, never partial joins.
import { deliverToEndpoint, deliverViaMailboxRecorded, parseHost, relayBaseFromHost, requireArg, takeBoolFlag, takeFlag } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { resolveFriendRequestCard } from "./cli-social.ts";
import { loadOrCreateDialoutKey } from "./dialout-key.ts";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import type { RelationshipState } from "./edge-book.ts";
import { postRelayEnvelope } from "./http-relay.ts";
import { defaultProviders, resolveTarget } from "./resolver.ts";
import { recordOutboxEntry } from "./store-outbox.ts";
import fs from "node:fs/promises";
import path from "node:path";

// Courtesy pacing between sequential pack-join sends (spec-145): the relay
// has no per-sender burst limit, so this keeps a 50-member join from spiking
// the mailbox queue. The VALUE is pinned in test/pack-cli.test.ts.
export const PACK_JOIN_REQUEST_DELAY_MS = 250;

// Benign skip states (spec-145): repeated `pack join` is idempotent via these.
// request_received must skip BEFORE createFriendRequest — sending would
// overwrite the pending inbound state via upsertContactFromCard.
const SKIP_REASONS: Partial<Record<RelationshipState, string>> = {
  friend: "already a friend",
  request_sent: "request already sent",
  blocked: "blocked",
  request_received: "they already asked you — run `friend pending` to accept",
};

interface PackListing {
  slug: string;
  title: string;
  description: string;
  member_count: number;
}

interface PackRecord extends Omit<PackListing, "member_count"> {
  member_handles: string[];
}

interface MemberOutcome {
  handle: string;
  outcome: "requested" | "skipped" | "failed";
  reason?: string;
  // Present only on non---deliver joins: the signed envelope for manual transport.
  envelope?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --relay-base flag > EDGE_BOOK_RELAY_BASE env > derived from the dial-out
// host (spec-145). parseHost also consumes --host so the join's mailbox
// fallback reuses the same host the relay base came from.
function packRelayBase(args: string[], ctx: CliContext, hostUrl: string): string {
  return (takeFlag(args, "--relay-base") || process.env.EDGE_BOOK_RELAY_BASE || relayBaseFromHost(hostUrl)).replace(/\/$/, "");
}

async function fetchPackJson(url: string, agentKey?: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, agentKey ? { headers: { authorization: `Bearer ${agentKey}` } } : undefined);
  } catch (error) {
    throw new EdgeBookError("host_unreachable", `Could not reach the pack registry at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* non-JSON error body */ }
  return { status: response.status, body };
}

// Local cache of fetched packs (per home): the host rate-limits the
// member-list fetch (it gates the join fan-out), so `pack show` followed by
// `pack join` would 429 inside the window. A 429 falls back to the cached
// copy — the host-side gate still bounds real fetches to one per window.
const PACK_CACHE_FILE = "packs-cache.json";
type PackCache = Record<string, { fetched_at: number; pack: PackRecord }>;

async function readPackCache(store: EdgeBookStore): Promise<PackCache> {
  try { return JSON.parse(await fs.readFile(path.join(store.home, PACK_CACHE_FILE), "utf8")) as PackCache; } catch { return {}; }
}

async function cachePack(store: EdgeBookStore, key: string, pack: PackRecord): Promise<void> {
  try {
    const cache = await readPackCache(store);
    cache[key] = { fetched_at: Date.now(), pack };
    await fs.writeFile(path.join(store.home, PACK_CACHE_FILE), JSON.stringify(cache));
  } catch { /* cache is best-effort */ }
}

// Authenticated member-list fetch — the join gate. Maps every host status to
// a domain error with a next action (no raw HTTP surfaces to the human).
async function fetchPack(base: string, slug: string, store: EdgeBookStore): Promise<PackRecord> {
  const key = await loadOrCreateDialoutKey(store);
  const cacheKey = `${base}/${slug}`;
  const { status, body } = await fetchPackJson(`${base}/pack/${encodeURIComponent(slug)}`, key.agent_key);
  if (status === 200) {
    const pack = body as PackRecord;
    await cachePack(store, cacheKey, pack);
    return pack;
  }
  if (status === 404) throw new EdgeBookError("pack_not_found", `No pack '${slug}' — run: pack list`);
  if (status === 429) {
    const cached = (await readPackCache(store))[cacheKey];
    if (cached) return cached.pack;
    const retryMs = (body as { retry_after_ms?: number } | null)?.retry_after_ms ?? 0;
    const mins = Math.max(1, Math.ceil(retryMs / 60_000));
    throw new EdgeBookError("pack_rate_limited", `Pack '${slug}' was fetched recently — try again in ~${mins} min`);
  }
  if (status === 401 || status === 403) {
    throw new EdgeBookError("pack_unauthorized", "The host does not know this agent yet — run `edge-book dialout` once so it can introduce itself, then retry");
  }
  throw new EdgeBookError("pack_fetch_failed", `Pack fetch failed (HTTP ${status})`);
}

async function handlePackList(args: string[], ctx: CliContext): Promise<CliResult> {
  const base = packRelayBase(args, ctx, parseHost(args, ctx));
  const { status, body } = await fetchPackJson(`${base}/packs`);
  if (status !== 200 || !Array.isArray(body)) throw new EdgeBookError("pack_fetch_failed", `Pack listing failed (HTTP ${status})`);
  const packs = body as PackListing[];
  const text = packs.length
    ? packs.map((p) => `${p.slug}  ${p.title}  (${p.member_count} member${p.member_count === 1 ? "" : "s"})${p.description ? `  — ${p.description}` : ""}`).join("\n")
    : "No starter packs published on this host.";
  return { text, json: { packs } };
}

// `pack show` — members with per-handle resolution state. Resolves (reads)
// only; sends NOTHING (spec-145 test bullet).
async function handlePackShow(args: string[], ctx: CliContext, store: EdgeBookStore): Promise<CliResult> {
  const hostUrl = parseHost(args, ctx);
  const base = packRelayBase(args, ctx, hostUrl);
  const slug = requireArg(args.shift(), "pack-slug");
  const pack = await fetchPack(base, slug, store);
  const identity = await store.identity();
  const providers = defaultProviders(base);
  const members: Array<{ handle: string; resolution: string; relationship?: RelationshipState }> = [];
  for (const handle of pack.member_handles) {
    if (handle === identity.handle) { members.push({ handle, resolution: "self" }); continue; }
    try {
      const result = await resolveTarget(store, handle, { providers });
      const relationship = result.agent_id ? (await store.contacts())[result.agent_id]?.relationship_state : undefined;
      members.push({ handle, resolution: result.status, ...(relationship ? { relationship } : {}) });
    } catch {
      members.push({ handle, resolution: "not_found" });
    }
  }
  const lines = members.map((m) => `${m.handle}  ${m.resolution}${m.relationship ? `  [${m.relationship}]` : ""}`);
  const text = `${pack.title} (${pack.member_handles.length} members)${pack.description ? `\n${pack.description}` : ""}\n${lines.join("\n")}`;
  return { text, json: { ...pack, members } };
}

// Deliver one pack-join friend request, mirroring `friend request --deliver`
// transport priority (direct > relay > host mailbox). Outbox records EVERY
// send (spec-145/spec-097): the mailbox path records inside
// deliverViaMailboxRecorded; direct/relay record here under the envelope's
// message_id (no host mailbox id exists on those transports).
async function deliverPackRequest(
  envelope: Awaited<ReturnType<EdgeBookStore["signEnvelope"]>>,
  card: { agent_id: string; transports: Array<{ mode: string; endpoint: string }> },
  opts: { home?: string; host: string; socketFactory?: CliContext["socketFactory"] },
): Promise<void> {
  const direct = card.transports.find((entry) => entry.mode === "direct")?.endpoint;
  if (direct) {
    await deliverToEndpoint(envelope, direct);
    await recordOutboxEntry(opts.home, { id: envelope.message_id, to_agent_id: envelope.to_agent_id, envelope_type: envelope.type });
    return;
  }
  const relay = card.transports.find((entry) => entry.mode === "relay")?.endpoint;
  if (relay) {
    await postRelayEnvelope(relay, card.agent_id, envelope);
    await recordOutboxEntry(opts.home, { id: envelope.message_id, to_agent_id: envelope.to_agent_id, envelope_type: envelope.type });
    return;
  }
  // Dial-out peer (no inbound endpoint): host mailbox, records its own outbox entry.
  await deliverViaMailboxRecorded(envelope, opts, (id) => `Delivered friend_request (host id ${id})`);
}

// Per-member fan-out: one member's failure never aborts the rest (spec-145).
// `paceBefore` applies the courtesy delay strictly BETWEEN sends — skips
// return before it, so a run of skips never sleeps.
async function joinMember(
  handle: string,
  deliver: boolean,
  paceBefore: boolean,
  store: EdgeBookStore,
  providers: ReturnType<typeof defaultProviders>,
  deliverOpts: { home?: string; host: string; socketFactory?: CliContext["socketFactory"] },
): Promise<MemberOutcome> {
  const identity = await store.identity();
  if (handle === identity.handle) return { handle, outcome: "skipped", reason: "self" };
  const card = await resolveFriendRequestCard(store, handle, providers);
  if (card.agent_id === identity.agent_id) return { handle, outcome: "skipped", reason: "self" };
  const state = (await store.contacts())[card.agent_id]?.relationship_state;
  const skipReason = state ? SKIP_REASONS[state] : undefined;
  if (skipReason) return { handle, outcome: "skipped", reason: skipReason };
  if (paceBefore) await sleep(PACK_JOIN_REQUEST_DELAY_MS);
  const envelope = await store.createFriendRequest(card);
  if (deliver) {
    await deliverPackRequest(envelope, card, deliverOpts);
    return { handle, outcome: "requested" };
  }
  // No --deliver: contact state is now request_sent, so the envelope MUST
  // surface for manual transport (same semantics as `friend request` without
  // --deliver) — discarding it would strand the relationship state.
  return { handle, outcome: "requested", envelope };
}

async function handlePackJoin(args: string[], ctx: CliContext, home: string | undefined, store: EdgeBookStore): Promise<CliResult> {
  const deliver = takeBoolFlag(args, "--deliver");
  const hostUrl = parseHost(args, ctx);
  const base = packRelayBase(args, ctx, hostUrl);
  const slug = requireArg(args.shift(), "pack-slug");
  const pack = await fetchPack(base, slug, store);
  const providers = defaultProviders(base);
  const deliverOpts = { home, host: hostUrl, socketFactory: ctx.socketFactory };
  const outcomes: MemberOutcome[] = [];
  let sentAny = false;
  for (const handle of pack.member_handles) {
    try {
      const outcome = await joinMember(handle, deliver, sentAny, store, providers, deliverOpts);
      sentAny = sentAny || outcome.outcome === "requested";
      outcomes.push(outcome);
    } catch (error) {
      outcomes.push({ handle, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const requested = outcomes.filter((o) => o.outcome === "requested").length;
  const skipped = outcomes.filter((o) => o.outcome === "skipped").length;
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  const lines = outcomes.map((o) => `${o.handle}  ${o.outcome}${o.reason ? `  (${o.reason})` : ""}`);
  const summary = `requested ${requested}, skipped ${skipped}, failed ${failed}`
    + (!deliver && requested ? " — envelopes in --json output (no --deliver: nothing was sent; transport them manually or re-run with --deliver)" : "");
  // Exit codes (spec-145): 0 = every member succeeded or was a benign skip;
  // 1 = partial failure (>=1 sent, >=1 failed); 2 = total failure.
  const exitCode = failed === 0 ? 0 : requested > 0 ? 1 : 2;
  return {
    text: `${lines.join("\n")}\n${summary}`,
    json: { slug, requested, skipped, failed, members: outcomes },
    ...(exitCode ? { exitCode } : {}),
  };
}

// Dispatch entry, same contract as the other cli-*.ts handlers: returns null
// when the command is not its own, preserving cli.ts dispatch order.
export async function handlePackCli(command: string, args: string[], ctx: CliContext, home: string | undefined, store: EdgeBookStore): Promise<CliResult | null> {
  if (command !== "pack") return null;
  const action = args.shift();
  if (action === "list") return handlePackList(args, ctx);
  if (action === "show") return handlePackShow(args, ctx, store);
  if (action === "join") return handlePackJoin(args, ctx, home, store);
  throw new EdgeBookError("unknown_action", `Unknown pack action: ${action} (try: pack list | pack show <slug> | pack join <slug> [--deliver])`);
}
