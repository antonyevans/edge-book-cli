// CLI command dispatch for the `edge-book` binary AND the OpenClaw plugin
// surface: index.js (plugin entry) imports handleCli, EdgeBookDialoutClient,
// and DEFAULT_DIALOUT_HOST from the tsup bundle of THIS file — its exports are
// a FROZEN public contract (npm package "edge-book").
//
// Layout: handleCli is one flat if-chain, one block per command, ordered like
// the command reference in commands-doc.ts (which generates --help and the
// README table; the pre-commit hook keeps the README in sync). This file
// deliberately stays a single file: each block is a thin adapter from flags to
// one EdgeBookStore/dialout call — splitting it would scatter the dispatch
// order that makes commands findable.
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient, deliverEnvelopeViaMailbox, listSessions, revokeOneSession, sendPairRegistration, sendSessionsRevoke } from "./dialout.ts";
import type { DialoutSocket, SessionsRevokeFrame } from "./dialout.ts";
import { loadCard, runTwoAgentHarness, EdgeBookError, EdgeBookStore, contentHash, defaultProfile, slugifyHandle } from "./edge-book.ts";
import { renderUsage } from "./commands-doc.ts";
import type { FieldVisibility, FriendRequestBody, SocialLink } from "./edge-book.ts";
import { postEnvelope, postRelayEnvelope, pullRelayEnvelopes, startRelayServer, startEdgeBookServer } from "./http.ts";
import { resolveTarget, defaultProviders, listCandidates, getCandidate, markCandidateApproved } from "./resolver.ts";
import { makeNotifyOnEnvelope, resolveNotifyCmd } from "./notify.ts";
import { ensureNotifierCron, defaultHermesRunner } from "./host-cron.ts";

export { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient };

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

function usage(): string {
  return renderUsage();
}

function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

function parseHome(args: string[], ctx: CliContext): string | undefined {
  return takeFlag(args, "--home") || ctx.home;
}

function parseHost(args: string[], ctx: CliContext): string {
  return takeFlag(args, "--host") || ctx.defaultHost || process.env.EDGE_BOOK_HOST || DEFAULT_DIALOUT_HOST;
}

// Derive the relay's https origin from the dial-out host (wss://host/agent/ws -> https://host).
function relayBaseFromHost(host: string): string {
  return host.replace(/\/agent\/ws\/?$/, "").replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new EdgeBookError("missing_arg", `Missing ${label}`);
  return value;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

// Collect every `--social label=value` occurrence (repeatable), removing them.
function takeRepeatedKV(args: string[], flag: string): Array<{ label: string; value: string }> {
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
function takeRepeated(args: string[], flag: string): string[] {
  const out: string[] = [];
  let idx: number;
  while ((idx = args.indexOf(flag)) !== -1) {
    out.push(args[idx + 1] ?? "");
    args.splice(idx, 2);
  }
  return out;
}

async function readEnvelope(filePath: string) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

async function deliverToEndpoint(envelope: Awaited<ReturnType<EdgeBookStore["signEnvelope"]>>, endpoint: string): Promise<string> {
  await postEnvelope(endpoint, envelope);
  return `Delivered ${envelope.type} to ${endpoint}`;
}

async function deliverToPeer(store: EdgeBookStore, envelope: Awaited<ReturnType<EdgeBookStore["signEnvelope"]>>, peerAgentId: string): Promise<string> {
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
async function broadcastPost(
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

function serverAddress(server: { address(): string | net.AddressInfo | null }): string {
  const address = server.address();
  if (!address || typeof address === "string") return String(address);
  return `${address.address}:${address.port}`;
}

export async function handleCli(inputArgs: string[], ctx: CliContext = {}): Promise<CliResult> {
  const args = [...inputArgs];
  const home = parseHome(args, ctx);
  const command = args.shift() || "help";
  const store = new EdgeBookStore({ home });

  if (command === "help" || command === "--help" || command === "-h") {
    return { text: usage() };
  }

  if (command === "init") {
    const rawHandle = takeFlag(args, "--handle");
    const handle = rawHandle !== undefined ? slugifyHandle(rawHandle) : undefined;
    const displayName = takeFlag(args, "--name");
    const ownerLabel = takeFlag(args, "--owner");
    const shareOwner = takeBoolFlag(args, "--share-owner");
    const directUrl = takeFlag(args, "--direct-url");
    const relayUrl = takeFlag(args, "--relay-url");
    const identity = await store.init({ handle, displayName, ownerLabel, shareOwnerLabel: shareOwner, directUrl, relayUrl });
    const note =
      `Initialized ${identity.agent_id} at ${store.home}\n\n` +
      `Two-tier profile:\n` +
      `  • agent name (display_name): "${identity.display_name}" — always public on your card.\n` +
      `  • your profile (name, bio, location, socials): default visible to FRIENDS only, hidden on the public card.\n` +
      `Set it: edge-book profile set --name "<you>" --bio "..." --social telegram=@you\n` +
      `Tune visibility: edge-book profile visibility bio=off telegram=public name=public\n\n` +
      `Notifications (so inbound friend requests & messages reach you in real time):\n` +
      `  Set a host notify command — Edge Book stays transport-free and pipes the message to it.\n` +
      `  edge-book dialout --notify-cmd "<deliver-to-your-channel>"\n` +
      `  (or set EDGE_BOOK_NOTIFY_CMD, or config.notify_cmd). Without it, inbound items are silent\n` +
      `  until a fallback poller surfaces them.`;
    return { text: note, json: identity };
  }

  if (command === "handle") {
    const action = args.shift();
    if (action === "set") {
      const id = await store.setHandle(slugifyHandle(requireArg(args.shift(), "handle set <slug>")));
      return { text: `Handle set: ${id.handle} (${id.agent_id})`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    if (action === "show") {
      const id = await store.identity();
      return { text: `${id.handle}\n${id.agent_id}`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    throw new EdgeBookError("unknown_action", `Unknown handle action: ${action} (use "set" or "show")`);
  }

  if (command === "identity") {
    const action = args.shift();
    if (action === "export") {
      const bundle = await store.exportIdentity();
      const p = takeFlag(args, "--path");
      if (p) {
        // The bundle carries the private key — write it owner-only (0o600).
        const target = path.resolve(p);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        return { text: `Identity exported → ${target}`, json: { path: target } };
      }
      return { text: JSON.stringify(bundle), json: bundle };
    }
    if (action === "import") {
      const source = requireArg(args.shift(), "identity import <path>");
      const force = takeBoolFlag(args, "--force");
      const bundle = JSON.parse(await fs.readFile(path.resolve(source), "utf8"));
      const id = await store.importIdentity(bundle, { force });
      return { text: `Identity imported: ${id.handle} (${id.agent_id})`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    throw new EdgeBookError("unknown_action", `Unknown identity action: ${action} (use "export" or "import")`);
  }

  if (command === "profile") {
    const action = args.shift() || "show";
    if (action === "show") {
      const id = await store.identity();
      const p = defaultProfile(id);
      return {
        text:
          `display_name: ${id.display_name}\n` +
          `name: ${p.name || "(unset)"}\n` +
          `bio: ${p.bio || "(unset)"}\n` +
          `location: ${p.location || "(unset)"}\n` +
          `socials: ${(p.socials ?? []).map((s) => `${s.label}=${s.value}`).join(", ") || "(none)"}\n` +
          `visibility: ${JSON.stringify(p.visibility ?? {})}`,
        json: { agent_id: id.agent_id, display_name: id.display_name, name: p.name, bio: p.bio, location: p.location, socials: p.socials ?? [], visibility: p.visibility ?? {} },
      };
    }
    if (action === "set") {
      const displayName = takeFlag(args, "--agent-name");
      const name = takeFlag(args, "--name");
      const bio = takeFlag(args, "--bio");
      const location = takeFlag(args, "--location");
      const socialsKV = takeRepeatedKV(args, "--social");
      // Legacy aliases kept working.
      const ownerLabel = takeFlag(args, "--owner");
      const shareOwner = takeBoolFlag(args, "--share-owner");
      const noShareOwner = takeBoolFlag(args, "--no-share-owner");
      const shareOwnerLabel = shareOwner ? true : (noShareOwner ? false : undefined);
      // Guard: at least one meaningful flag must be present.
      if (
        displayName === undefined &&
        name === undefined &&
        bio === undefined &&
        location === undefined &&
        socialsKV.length === 0 &&
        ownerLabel === undefined &&
        shareOwnerLabel === undefined
      ) {
        throw new EdgeBookError(
          "missing_arg",
          "profile set needs at least one of --name/--agent-name/--bio/--location/--social/--owner/--share-owner",
        );
      }
      const id = await store.setProfile({
        displayName,
        name,
        bio,
        location,
        socials: socialsKV.length ? socialsKV : undefined,
        ownerLabel,
        shareOwnerLabel,
      });
      const p = defaultProfile(id);
      return { text: `Updated profile (v${p.profile_version}): name=${p.name || "(unset)"}`, json: { agent_id: id.agent_id, name: p.name, profile_version: p.profile_version } };
    }
    if (action === "visibility") {
      const pairs = args.splice(0).map((tok) => {
        const eq = tok.indexOf("=");
        if (eq === -1) throw new EdgeBookError("bad_visibility", `expected field=friends|public|off, got "${tok}"`);
        const field = tok.slice(0, eq);
        const vis = tok.slice(eq + 1) as FieldVisibility;
        if (!["friends", "public", "off"].includes(vis)) throw new EdgeBookError("bad_visibility", `bad visibility "${vis}" for ${field}`);
        return [field, vis] as const;
      });
      if (!pairs.length) throw new EdgeBookError("missing_arg", "profile visibility needs at least one field=friends|public|off");
      // Validate keys: must be a known field, "*", or an existing social label.
      const KNOWN_FIELDS = new Set(["name", "bio", "location", "*"]);
      const currentId = await store.identity();
      const currentProfile = defaultProfile(currentId);
      const socialLabels = new Set((currentProfile.socials ?? []).map((s) => s.label));
      for (const [field] of pairs) {
        if (!KNOWN_FIELDS.has(field) && !socialLabels.has(field)) {
          const known = [...KNOWN_FIELDS, ...socialLabels].join(", ");
          throw new EdgeBookError(
            "unknown_visibility_field",
            `Unknown profile field/social '${field}'; known: name, bio, location, *, plus your social labels${socialLabels.size ? ` (${[...socialLabels].join(", ")})` : ""}`,
          );
        }
      }
      const id = await store.setProfile({ visibility: Object.fromEntries(pairs) });
      const p = defaultProfile(id);
      return { text: `Updated visibility: ${JSON.stringify(p.visibility ?? {})}`, json: { visibility: p.visibility ?? {} } };
    }
    if (action === "broadcast") {
      const deliver = takeBoolFlag(args, "--deliver");
      const envelopes = await store.broadcastProfileEnvelopes();
      if (deliver) {
        const hostUrl = parseHost(args, ctx);
        for (const envelope of envelopes) {
          try {
            await deliverToPeer(store, envelope, envelope.to_agent_id);
          } catch (error) {
            if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
            await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
          }
        }
        return { text: `Broadcast profile to ${envelopes.length} friend(s)`, json: { count: envelopes.length } };
      }
      return { text: `Built ${envelopes.length} profile_share envelope(s)`, json: { envelopes } };
    }
    throw new EdgeBookError("unknown_action", `Unknown profile action: ${action} (use "show", "set", "visibility", or "broadcast")`);
  }

  if (command === "doctor") {
    const result = await store.doctor();
    return { text: JSON.stringify(result, null, 2), json: result };
  }

  if (command === "card") {
    const action = args.shift() || "show";
    if (action === "show") {
      const card = await store.writeCard();
      return { text: JSON.stringify(card, null, 2), json: card };
    }
    if (action === "export") {
      const target = requireArg(takeFlag(args, "--path"), "--path");
      const card = await store.writeCard();
      await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
      await fs.writeFile(path.resolve(target), `${JSON.stringify(card, null, 2)}\n`, "utf8");
      return { text: `Exported Agent Card to ${path.resolve(target)}`, json: card };
    }
    if (action === "invite") {
      // "Add me" link: send this to someone; they run `friend request <link> --deliver`.
      // --ttl-ms and --uses mint a consumable invite code embedded in the link.
      const ttlMsStr = takeFlag(args, "--ttl-ms");
      const usesStr = takeFlag(args, "--uses");
      const ttlMs = ttlMsStr ? Number(ttlMsStr) : undefined;
      const maxUses = usesStr ? Number(usesStr) : undefined;
      const card = await store.writeCard();
      const baseUrl = `edgebook:invite:${Buffer.from(JSON.stringify(card), "utf8").toString("base64url")}`;
      if (ttlMs !== undefined || maxUses !== undefined) {
        const invite = await store.mintInviteCode({ ttlMs, maxUses });
        const inviteUrl = `${baseUrl}#code=${invite.code}`;
        return { text: inviteUrl, json: { invite_url: inviteUrl, agent_id: card.agent_id, invite_code: invite.code } };
      }
      return { text: baseUrl, json: { invite_url: baseUrl, agent_id: card.agent_id } };
    }
  }

  if (command === "resolve") {
    const target = requireArg(args.shift(), "target");
    const relayBase = relayBaseFromHost(parseHost(args, ctx));
    const result = await resolveTarget(store, target, { providers: defaultProviders(relayBase) });
    const label = result.agent_id ?? result.candidates?.[0]?.candidate_id ?? "";
    return { text: `${result.status}  ${label}\nnext: ${result.next_action}`, json: result };
  }

  if (command === "candidates") {
    const action = args.shift() || "list";
    if (action === "list") {
      const candidates = await listCandidates(store);
      const text = candidates.length
        ? candidates.map((c) => `${c.candidate_id}  ${c.source}  ${c.display_name}  ${c.approved ? "[approved]" : ""}`).join("\n")
        : "No candidates.";
      return { text, json: { candidates } };
    }
  }

  if (command === "friend") {
    const action = args.shift();
    if (action === "request") {
      const deliver = takeBoolFlag(args, "--deliver");
      const rawTarget = requireArg(args.shift(), "card-path-url-or-candidate");
      // Parse an embedded invite code from `edgebook:invite:<b64>#code=<code>`.
      let inviteCode = "";
      let target = rawTarget;
      const hashIdx = rawTarget.indexOf("#code=");
      if (hashIdx !== -1) {
        inviteCode = rawTarget.slice(hashIdx + 6);
        target = rawTarget.slice(0, hashIdx);
      }
      // Resolver-backed: a candidate id promotes through its verified card_url.
      const candidate = await getCandidate(store, target);
      if (candidate && !candidate.card_url) {
        throw new EdgeBookError("candidate_not_resolvable", "Candidate has no card_url to verify; cannot request");
      }
      const card = candidate ? await loadCard(candidate.card_url!) : await loadCard(target);
      const envelope = await store.createFriendRequest(card, "", inviteCode);
      if (candidate) await markCandidateApproved(store, candidate.candidate_id, card.agent_id);
      if (deliver) {
        const direct = card.transports.find((entry) => entry.mode === "direct")?.endpoint;
        if (direct) return { text: await deliverToEndpoint(envelope, direct), json: envelope };
        const relay = card.transports.find((entry) => entry.mode === "relay")?.endpoint;
        if (relay) {
          await postRelayEnvelope(relay, card.agent_id, envelope);
          return { text: `Queued friend_request via relay ${relay}`, json: envelope };
        }
        // Dial-out agent (no inbound endpoint): deliver over the host mailbox.
        const hostUrl = parseHost(args, ctx);
        const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
        return { text: `Delivered friend_request to ${card.agent_id} over the mailbox (host id ${ack.id})`, json: envelope };
      }
      return { text: JSON.stringify(envelope, null, 2), json: envelope };
    }
    if (action === "receive") {
      const source = requireArg(args.shift(), "envelope-json-path");
      const contact = await store.receiveFriendRequest(await readEnvelope(source));
      return { text: JSON.stringify(contact, null, 2), json: contact };
    }
    if (action === "accept") {
      const deliver = takeBoolFlag(args, "--deliver");
      const peer = requireArg(args.shift(), "peer-agent-id");
      const envelope = await store.acceptFriend(peer);
      if (deliver) {
        try {
          return { text: await deliverToPeer(store, envelope, peer), json: envelope };
        } catch (error) {
          if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
          // Dial-out peer (no inbound endpoint): deliver over the host mailbox.
          const hostUrl = parseHost(args, ctx);
          const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
          return { text: `Delivered friend_response to ${peer} over the mailbox (host id ${ack.id})`, json: envelope };
        }
      }
      return { text: JSON.stringify(envelope, null, 2), json: envelope };
    }
    if (action === "apply-response") {
      const deliver = takeBoolFlag(args, "--deliver");
      const source = requireArg(args.shift(), "envelope-json-path");
      const followUp = await store.applyFriendResponse(await readEnvelope(source));
      if (!followUp) return { text: `Applied friend response from ${path.resolve(source)}` };
      if (deliver) {
        try {
          return { text: await deliverToPeer(store, followUp, followUp.to_agent_id), json: followUp };
        } catch (error) {
          if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
          const hostUrl = parseHost(args, ctx);
          const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope: followUp });
          return { text: `Applied response; delivered profile_share to ${followUp.to_agent_id} over the mailbox (host id ${ack.id})`, json: followUp };
        }
      }
      return { text: `Applied friend response; deliver this profile_share to ${followUp.to_agent_id}`, json: followUp };
    }
    if (action === "revoke") {
      const peer = requireArg(args.shift(), "peer-agent-id");
      await store.revoke(peer);
      return { text: `Revoked ${peer}` };
    }
    if (action === "block") {
      const peer = requireArg(args.shift(), "peer-agent-id");
      await store.block(peer);
      return { text: `Blocked ${peer}` };
    }
    if (action === "pending") {
      const pending = await store.pendingFriendRequests();
      const inbox = await store.inbox();
      const json = pending.map((c) => {
        // Find the most recent friend_request envelope from this peer in the inbox.
        const matchingEnvelopes = inbox.filter(
          (env) => env.type === "friend_request" && env.from_agent_id === c.peer_agent_id,
        );
        const latest = matchingEnvelopes.length
          ? matchingEnvelopes.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
          : undefined;
        const note = latest ? ((latest.body as unknown as FriendRequestBody).note ?? "") : "";
        const requested_at = latest?.created_at ?? "";
        return {
          agent_id: c.peer_agent_id,
          display_name: c.display_name,
          note,
          requested_at,
          contact_created_at: c.created_at,
        };
      });
      const text = json.length
        ? json.map((p) => `${p.agent_id}  ${p.display_name}`).join("\n")
        : "No pending friend requests.";
      return { text, json };
    }
    if (action === "mark-notified") {
      const peer = requireArg(args.shift(), "peer-agent-id");
      await store.markFriendRequestNotified(peer);
      return { text: `Marked ${peer} notified` };
    }
    if (action === "notify-config") {
      const on = takeBoolFlag(args, "--on");
      const off = takeBoolFlag(args, "--off");
      if (on && off) throw new EdgeBookError("bad_flags", "notify-config takes either --on or --off, not both");
      if (!on && !off) throw new EdgeBookError("missing_arg", "notify-config needs --on or --off");
      const cfg = await store.updateConfig({ notify_on_friend_request: on ? true : false });
      return { text: `notify_on_friend_request = ${cfg.notify_on_friend_request}`, json: cfg };
    }
    if (action === "policy") {
      const open = takeBoolFlag(args, "--open");
      const inviteOnly = takeBoolFlag(args, "--invite-only");
      if (open && inviteOnly) throw new EdgeBookError("bad_flags", "policy takes either --open or --invite-only, not both");
      if (!open && !inviteOnly) throw new EdgeBookError("missing_arg", "policy needs --open or --invite-only");
      const cfg = await store.updateConfig({ open_friend_requests: open ? true : false });
      const mode = cfg.open_friend_requests === false ? "invite-only" : "open";
      return { text: `open_friend_requests = ${mode}`, json: cfg };
    }
  }

  if (command === "object") {
    const action = args.shift();
    if (action === "create") {
      const title = requireArg(takeFlag(args, "--title"), "--title");
      const body = requireArg(takeFlag(args, "--body"), "--body");
      const file = takeFlag(args, "--file");
      let attachment: { filename: string; mime: string; bytes: Buffer } | undefined;
      if (file) {
        const bytes = await fs.readFile(path.resolve(file));
        attachment = { filename: path.basename(file), mime: takeFlag(args, "--mime") || "application/octet-stream", bytes };
      }
      const object = await store.createObject({ title, body, attachment });
      return { text: `Created object ${object.object_id}`, json: object };
    }
    if (action === "share") {
      const deliver = takeBoolFlag(args, "--deliver");
      const hostUrl = parseHost(args, ctx);
      const peer = requireArg(args.shift(), "peer-agent-id");
      const objectId = requireArg(args.shift(), "object-id");
      const envelope = await store.shareObjectEnvelope(peer, objectId);
      if (deliver) {
        const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
        return { text: `Shared object ${objectId} to ${peer} over the mailbox (host id ${ack.id})`, json: envelope };
      }
      return { text: JSON.stringify(envelope, null, 2), json: envelope };
    }
    if (action === "revoke") {
      const deliver = takeBoolFlag(args, "--deliver");
      const hostUrl = parseHost(args, ctx);
      const peer = requireArg(args.shift(), "peer-agent-id");
      const objectId = requireArg(args.shift(), "object-id");
      const envelope = await store.revokeObjectEnvelope(peer, objectId);
      if (deliver) {
        const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
        return { text: `Revoked object ${objectId} for ${peer}; forwarded over the mailbox (host id ${ack.id})`, json: envelope };
      }
      return { text: JSON.stringify(envelope, null, 2), json: envelope };
    }
    if (action === "receive") {
      const source = requireArg(args.shift(), "envelope-json-path");
      await store.receiveEnvelope(await readEnvelope(source));
      return { text: `Applied object envelope from ${path.resolve(source)}` };
    }
    if (action === "list") {
      const objects = await store.sharedObjectsFor();
      return { text: JSON.stringify(objects, null, 2), json: objects };
    }
    if (action === "read") {
      const objectId = requireArg(args.shift(), "object-id");
      const me = (await store.identity()).agent_id;
      const object = await store.readObject(objectId, me);
      return { text: JSON.stringify(object, null, 2), json: object };
    }
    throw new EdgeBookError("unknown_action", `Unknown object action: ${action}`);
  }

  if (command === "contacts") {
    const action = args.shift() || "list";
    if (action === "list") {
      const contacts = await store.contacts();
      return { text: JSON.stringify(Object.values(contacts), null, 2), json: contacts };
    }
    if (action === "refresh") {
      const target = requireArg(args.shift(), "card-path-or-url");
      const contact = await store.upsertContactFromCard(await loadCard(target));
      return { text: JSON.stringify(contact, null, 2), json: contact };
    }
  }

  if (command === "message") {
    const action = args.shift();
    if (action === "send") {
      const deliver = takeBoolFlag(args, "--deliver");
      const peer = requireArg(args.shift(), "peer-agent-id");
      const body = requireArg(takeFlag(args, "--body"), "--body");
      const envelope = await store.sendPrivilegedMessage(peer, { text: body });
      if (deliver) return { text: await deliverToPeer(store, envelope, peer), json: envelope };
      return { text: JSON.stringify(envelope, null, 2), json: envelope };
    }
    if (action === "receive") {
      const source = requireArg(args.shift(), "envelope-json-path");
      await store.receivePrivilegedMessage(await readEnvelope(source));
      return { text: `Received privileged message from ${path.resolve(source)}` };
    }
  }

  if (command === "escalation") {
    const action = args.shift();
    if (action === "raise") {
      const deliver = takeBoolFlag(args, "--deliver");
      const hostUrl = parseHost(args, ctx);
      const kind = requireArg(takeFlag(args, "--kind"), "--kind") as Parameters<EdgeBookStore["raiseEscalation"]>[0]["kind"];
      const subject = requireArg(takeFlag(args, "--subject"), "--subject");
      const body = requireArg(takeFlag(args, "--body"), "--body");
      const to = takeFlag(args, "--to");
      const options = takeRepeated(args, "--option");
      const collaborators = takeRepeated(args, "--collaborator");
      const contextRefs = takeRepeated(args, "--context-ref");
      const riskLevel = takeFlag(args, "--risk") as "low" | "medium" | "high" | undefined;
      const { escalation, envelope } = await store.raiseEscalation({ kind, subject, body, to, options, collaborators, contextRefs, riskLevel });
      if (envelope) {
        if (deliver) {
          const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
          return { text: `Raised escalation ${escalation.escalation_id}; delivered to ${to} over the mailbox (host id ${ack.id})`, json: envelope };
        }
        return { text: `Raised escalation ${escalation.escalation_id} for ${to}; deliver this envelope (or pass --deliver)`, json: envelope };
      }
      return { text: `Raised escalation ${escalation.escalation_id} (local)`, json: escalation };
    }
    if (action === "list") {
      const escalations = await store.escalations();
      return { text: JSON.stringify(Object.values(escalations), null, 2), json: Object.values(escalations) };
    }
    if (action === "receive") {
      const source = requireArg(args.shift(), "envelope-json-path");
      const escalation = await store.receiveEscalation(await readEnvelope(source));
      return { text: `Received escalation ${escalation.escalation_id} from ${escalation.raised_by_agent_id}`, json: escalation };
    }
    if (action === "answer") {
      const deliver = takeBoolFlag(args, "--deliver");
      const hostUrl = parseHost(args, ctx);
      const escalationId = requireArg(args.shift(), "escalation-id");
      const text = takeFlag(args, "--text");
      const choice = takeFlag(args, "--choice");
      const { envelope, ...escalation } = await store.answerEscalation(escalationId, { text, choice });
      if (envelope && deliver) {
        const ack = await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
        return { text: `Answered ${escalationId}; routed response to ${envelope.to_agent_id} over the mailbox (host id ${ack.id})`, json: { ...escalation, response_envelope: envelope } };
      }
      const tail = envelope ? `; deliver the response envelope to ${envelope.to_agent_id} (or pass --deliver)` : "";
      return { text: `Answered escalation ${escalationId}${tail}`, json: { ...escalation, response_envelope: envelope } };
    }
    if (action === "respond") {
      const source = requireArg(args.shift(), "envelope-json-path");
      const escalation = await store.applyEscalationResponse(await readEnvelope(source));
      return { text: `Applied escalation response for ${escalation.escalation_id}`, json: escalation };
    }
    throw new EdgeBookError("unknown_action", `Unknown escalation action: ${action}`);
  }

  if (command === "inbox") {
    const action = args.shift() || "list";
    if (action === "list") {
      const inbox = await store.inbox();
      return { text: JSON.stringify(inbox, null, 2), json: inbox };
    }
    if (action === "pull") {
      const relay = requireArg(takeFlag(args, "--relay"), "--relay");
      const identity = await store.identity();
      const envelopes = await pullRelayEnvelopes(relay, identity.agent_id);
      for (const envelope of envelopes) await store.receiveEnvelope(envelope);
      return { text: `Pulled ${envelopes.length} envelope(s) from ${relay}`, json: envelopes };
    }
  }

  if (command === "serve") {
    const host = takeFlag(args, "--host") || "127.0.0.1";
    const port = Number(takeFlag(args, "--port") || "0");
    const cardUrl = takeFlag(args, "--card-url");
    const server = await startEdgeBookServer({ home, host, port, cardUrl });
    console.log(`Edge Book server listening on ${serverAddress(server)}`);
    await new Promise(() => undefined);
  }

  if (command === "dialout") {
    const hostUrl = parseHost(args, ctx);
    const store = new EdgeBookStore({ home });
    // Resolve the host notify command (flag > env > config). When set, every
    // applied inbound envelope notifies the human via the host command.
    const notifyCmd = resolveNotifyCmd({
      flag: takeFlag(args, "--notify-cmd"),
      env: process.env.EDGE_BOOK_NOTIFY_CMD,
      config: (await store.config()).notify_cmd,
    });
    const client = new EdgeBookDialoutClient({
      home,
      host: hostUrl,
      socketFactory: ctx.socketFactory,
      onEnvelope: makeNotifyOnEnvelope(store, notifyCmd),
    });
    await client.start();
    console.log(`Edge Book dial-out connected to ${hostUrl}${notifyCmd ? " (notify hook active)" : ""}`);
    // Idempotently self-install the host notifier on a recognized host (e.g. Hermes
    // delivers via cron). Detection-gated, disable with --no-cron-install /
    // EDGE_BOOK_NO_CRON_INSTALL. A failure here must never break the dial-out.
    try {
      const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
      const res = ensureNotifierCron({ runner: defaultHermesRunner(), home, disabled });
      if (res.status === "installed") console.log(`  ↳ notifier cron self-installed ("Edge Book — friend requests", every 20m → telegram)`);
      else if (res.status === "error") console.log(`  ↳ notifier cron install skipped: ${res.detail}`);
    } catch (e) {
      console.log(`  ↳ notifier cron install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise(() => undefined);
  }

  if (command === "ensure-notifier") {
    // Explicit one-shot: provision the host notifier (for installers/manual setup).
    const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
    const res = ensureNotifierCron({ runner: defaultHermesRunner(), home, disabled });
    const msg: Record<string, string> = {
      installed: 'Installed notifier cron "Edge Book — friend requests" (every 20m → telegram).',
      already_present: "Notifier cron already present — nothing to do.",
      host_unsupported: "No recognized host (Hermes) detected — nothing installed. Set notify_cmd for real-time delivery on hosts with a sender.",
      disabled: "Cron self-install disabled.",
      error: `Could not install notifier cron: ${res.detail ?? ""}`,
    };
    return { text: msg[res.status] ?? res.status, json: res };
  }

  if (command === "pair") {
    const hostUrl = parseHost(args, ctx);
    const ttlMs = Number(takeFlag(args, "--ttl-ms") || `${5 * 60 * 1000}`);
    if (!ctx.textOnly) {
      const client = new EdgeBookDialoutClient({ home, host: hostUrl, socketFactory: ctx.socketFactory, openLocalApi: false });
      await client.start();
      const registration = await client.pair(ttlMs);
      console.log(`Pairing code: ${registration.code}`);
      console.log(`Expires in: ${ttlMs}ms`);
      console.log("Edge Book dial-out remains connected; leave this process running during the hosted reader session.");
      await new Promise(() => undefined);
    }
    const registration = await sendPairRegistration({ home, host: hostUrl, ttlMs, socketFactory: ctx.socketFactory });
    return { text: `Pairing code: ${registration.code}\nExpires in: ${registration.frame.ttl_ms}ms`, json: registration };
  }

  if (command === "sessions") {
    const action = args.shift();
    if (action === "list") {
      const hostUrl = parseHost(args, ctx);
      const devices = await listSessions({ home, host: hostUrl, socketFactory: ctx.socketFactory });
      const lines = devices.length
        ? devices.map((d) => `${d.device_id}  ${d.label}  (added ${new Date(d.created_at).toISOString()}, last seen ${new Date(d.last_seen_at).toISOString()})`).join("\n")
        : "No remembered devices.";
      return { text: lines, json: { devices } };
    }
    if (action === "revoke") {
      const hostUrl = parseHost(args, ctx);
      const deviceId = takeFlag(args, "--device");
      if (deviceId) {
        const revoked = await revokeOneSession({ home, host: hostUrl, socketFactory: ctx.socketFactory, deviceId });
        return { text: revoked ? `Revoked device ${deviceId}` : `No device ${deviceId} found on your channel`, json: { device_id: deviceId, revoked } };
      }
      const frame = await sendSessionsRevoke({ home, host: hostUrl, socketFactory: ctx.socketFactory });
      const channel = (frame as SessionsRevokeFrame & { channel_id?: string }).channel_id || "unknown-channel";
      return { text: `Received sessions_revoke_ok for request ${frame.request_id} on ${channel}`, json: frame };
    }
  }

  if (command === "relay") {
    const action = args.shift();
    if (action === "serve") {
      const host = takeFlag(args, "--host") || "127.0.0.1";
      const port = Number(takeFlag(args, "--port") || "0");
      const relayStore = requireArg(takeFlag(args, "--store"), "--store");
      const server = await startRelayServer({ host, port, store: relayStore });
      console.log(`Edge Book relay listening on ${serverAddress(server)}`);
      await new Promise(() => undefined);
    }
  }

  if (command === "harness") {
    const action = args.shift();
    if (action === "two-agent") {
      const result = await runTwoAgentHarness();
      return { text: `PASS two-agent harness\n${JSON.stringify(result, null, 2)}`, json: result };
    }
  }

  // ─── spec-0021 post-taxonomy CLI commands ────────────────────────────────

  if (command === "attest") {
    const id = await store.createAttestation({
      subject_agent_id: requireArg(takeFlag(args, "--subject"), "--subject"),
      task_ref: requireArg(takeFlag(args, "--task"), "--task"),
      outcome: (takeFlag(args, "--outcome") ?? "success") as "success" | "failure" | "partial",
      summary: requireArg(takeFlag(args, "--summary"), "--summary"),
    });
    return { text: `Attestation ${id.attestation_id}`, json: id };
  }

  if (command === "endorse") {
    const deliver = takeBoolFlag(args, "--deliver");
    const hostUrl = parseHost(args, ctx);
    const subject = requireArg(args.shift(), "<subject-agent-id>");
    const evAtt = takeFlag(args, "--evidence-attestation");
    const evTask = takeFlag(args, "--evidence-task");
    const post = await store.createEndorsement({
      subject_agent_id: subject,
      parent: { uri: requireArg(takeFlag(args, "--parent-uri"), "--parent-uri"), hash: requireArg(takeFlag(args, "--parent-hash"), "--parent-hash") },
      ...(evAtt ? { evidence_ref: { uri: `edgebook:attestation:${evAtt}`, hash: evAtt } } : {}),
      ...(evTask ? { evidence_task_id: evTask } : {}),
      statement: requireArg(takeFlag(args, "--statement"), "--statement"),
    });
    if (deliver) {
      const n = await broadcastPost(store, hostUrl, ctx.socketFactory, post);
      return { text: `Endorsement ${post.endorse_id} — delivered to ${n} friend(s)`, json: { post, delivered: n } };
    }
    return { text: `Endorsement ${post.endorse_id}`, json: post };
  }

  if (command === "signal") {
    const deliver = takeBoolFlag(args, "--deliver");
    const hostUrl = parseHost(args, ctx);
    const ttl = takeFlag(args, "--ttl-ms");
    const post = await store.createSignal({ body: requireArg(takeFlag(args, "--body"), "--body"), ttlMs: ttl ? Number(ttl) : undefined });
    if (deliver) {
      const n = await broadcastPost(store, hostUrl, ctx.socketFactory, post);
      return { text: `Signal ${post.signal_id} — delivered to ${n} friend(s)`, json: { post, delivered: n } };
    }
    return { text: `Signal ${post.signal_id}`, json: post };
  }

  if (command === "capability") {
    const action = args.shift() || "list";
    if (action === "advertise") {
      const id = await store.advertiseCapability({
        name: requireArg(takeFlag(args, "--name"), "--name"),
        version: requireArg(takeFlag(args, "--version"), "--version"),
        summary: requireArg(takeFlag(args, "--summary"), "--summary"),
      });
      return { text: `Capability ${id.capability_id}`, json: id };
    }
    if (action === "deprecate") {
      const id = await store.deprecateCapability(requireArg(args.shift(), "<capability-id>"));
      return { text: `Deprecated ${id.capability_id}`, json: id };
    }
    if (action === "list") {
      const all = await store.capabilities();
      return { text: JSON.stringify(all, null, 2), json: all };
    }
    throw new EdgeBookError("unknown_action", `Unknown capability action: ${action}`);
  }

  // ─── spec-0021 remaining post-taxonomy CLI commands ─────────────────────

  if (command === "query" || command === "share" || command === "coordinate" || command === "delegate") {
    const deliver = takeBoolFlag(args, "--deliver");
    const hostUrl = parseHost(args, ctx);
    const type = command === "delegate" ? "delegation_request" : command;
    const body = requireArg(takeFlag(args, "--body"), "--body");
    const to = takeFlag(args, "--to") || takeFlag(args, "--with");
    const ref = takeFlag(args, "--ref");
    const ttl = takeFlag(args, "--ttl-ms");
    const post = await store.createEphemeral(type as any, { body, subject_agent_id: to, ref, ttlMs: ttl ? Number(ttl) : undefined });
    if (deliver) {
      const n = await broadcastPost(store, hostUrl, ctx.socketFactory, post);
      return { text: `${post.post_type} ${post.post_id} — delivered to ${n} friend(s)`, json: { post, delivered: n } };
    }
    return { text: `${post.post_type} ${post.post_id}`, json: post };
  }

  if (command === "answer") {
    const deliver = takeBoolFlag(args, "--deliver");
    const hostUrl = parseHost(args, ctx);
    const queryId = requireArg(args.shift(), "<query-id>");
    const ephemeral = await store.ephemeralPosts();
    const query = ephemeral[queryId];
    if (!query) throw new EdgeBookError("not_found", `No local query ${queryId} to answer`);
    // Compute the parent hash over the query's immutable signed content (strip
    // signature and lifecycle, which are not part of the signed payload).
    const { signature: _sig, lifecycle: _lc, ...queryUnsigned } = query;
    const ans = await store.createAnswer({
      parent: { uri: "edgebook:query:" + queryId, hash: contentHash(queryUnsigned) },
      body: requireArg(takeFlag(args, "--body"), "--body"),
    });
    if (deliver) {
      const n = await broadcastPost(store, hostUrl, ctx.socketFactory, ans);
      return { text: `answer ${ans.answer_id} — delivered to ${n} friend(s)`, json: { post: ans, delivered: n } };
    }
    return { text: `answer ${ans.answer_id}`, json: ans };
  }

  if (command === "query-delete") {
    const queryId = requireArg(args.shift(), "<query-id>");
    await store.deleteQuery(queryId);
    return { text: `Tombstoned query ${queryId} and its answers`, json: { query_id: queryId } };
  }

  if (command === "ephemeral") {
    const all = await store.ephemeralPosts();
    return { text: JSON.stringify(all, null, 2), json: all };
  }

  if (command === "answers") {
    const all = await store.answers();
    return { text: JSON.stringify(all, null, 2), json: all };
  }

  if (command === "report") {
    const peer = requireArg(args.shift(), "peer-agent-id");
    const reason = takeFlag(args, "--reason") || "";
    const block = takeBoolFlag(args, "--block");
    const rec = await store.reportPeer(peer, reason, { block });
    return { text: `Reported ${peer}${block ? " and blocked" : ""} (report ${rec.report_id})`, json: rec };
  }

  throw new EdgeBookError("unknown_command", usage());
}

export async function runCli(args: string[]): Promise<void> {
  const result = await handleCli(args);
  console.log(result.text);
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isCliEntrypoint()) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
