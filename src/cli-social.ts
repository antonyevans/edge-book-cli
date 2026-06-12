// Social-graph & messaging CLI commands (split from cli.ts): resolve,
// candidates, friend lifecycle, object share/revoke/read, contacts,
// privileged messages, escalations, inbox. Command names/flags are FROZEN
// (npm surface); handleCli in cli.ts stays the only dispatch entry and calls
// this handler in dispatch order. Returns null when the command is not its own.
import { existsSync } from "node:fs";
import path from "node:path";
import { deliverToEndpoint, deliverToPeer, deliverViaMailboxRecorded, parseHost, readEnvelope, relayBaseFromHost, requireArg, takeBoolFlag, takeFlag, takeRepeated } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { loadCard, EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import type { AgentCard, FriendRequestBody } from "./edge-book.ts";
import { postRelayEnvelope, pullRelayEnvelopes } from "./http-relay.ts";
import { resolveTarget, defaultProviders, listCandidates, getCandidate, markCandidateApproved } from "./resolver.ts";
import type { ResolverProvider } from "./resolver.ts";
import { runGreeterPass } from "./store-greeter.ts";
import fs from "node:fs/promises";

// spec-138: targets that loadCard can handle directly — a URL, an invite
// deeplink, or a file that actually exists. Everything else (bare handles,
// typos, missing paths) routes through the resolver instead of dying on a
// raw fs ENOENT inside loadCard.
function isCardLocation(target: string): boolean {
  if (/^https?:\/\//.test(target) || target.startsWith("edgebook:invite:")) return true;
  if (target.startsWith("file://")) return true;
  return existsSync(path.resolve(target));
}

const notResolvable = (target: string) =>
  new EdgeBookError("target_not_resolvable", `could not resolve '${target}' — share your invite link instead (card invite)`);

// spec-138: resolve a friend-request target to a verified Agent Card through
// the same pipeline as `resolve`, so the canonical `resolve <handle>` →
// `friend request <handle> --deliver` sequence works. A non-resolvable target
// is a domain error with a next action, never an fs error. Exported for tests.
export async function resolveFriendRequestCard(store: EdgeBookStore, target: string, providers: ResolverProvider[]): Promise<AgentCard> {
  if (isCardLocation(target)) return loadCard(target);
  let result;
  try {
    result = await resolveTarget(store, target, { providers });
  } catch (error) {
    // A path-shaped target that does not exist must never surface a raw ENOENT.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw notResolvable(target);
    throw error;
  }
  if (result.status === "resolved") {
    if (result.card) return result.card;
    // Local-contact resolution carries no card — re-verify via the stored card_url.
    // Stored card_urls can be unusable on THIS machine (0.15.x cards advertise
    // their own home as file:///…/openclaw-agent.json): on any load failure,
    // fall back to non-local resolution (registry) instead of surfacing an
    // fs error — found live when pack re-join hit a replica contact.
    const cardUrl = result.agent_id ? (await store.contacts())[result.agent_id]?.card_url : undefined;
    if (cardUrl) {
      try {
        return await loadCard(cardUrl);
      } catch {
        const nonLocal = providers.filter((p) => p.name !== "local");
        const retry = await resolveTarget(store, target, { providers: nonLocal });
        if (retry.status === "resolved" && retry.card) return retry.card;
        throw notResolvable(target);
      }
    }
    throw notResolvable(target);
  }
  if (result.status === "approval_required" || result.status === "candidates") {
    const first = result.candidates?.[0];
    throw new EdgeBookError("approval_required",
      `'${target}' matched an unverified candidate — run: candidates list   then: friend request ${first?.candidate_id ?? "<candidate-id>"}`);
  }
  throw notResolvable(target);
}

export async function handleSocialCli(command: string, args: string[], ctx: CliContext, home: string | undefined, store: EdgeBookStore): Promise<CliResult | null> {
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
      // Parse --host up front (it can sit anywhere in args): the resolver needs
      // the relay base, and the mailbox fallback below reuses the same host.
      const hostUrl = parseHost(args, ctx);
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
      // spec-138: non-candidate targets route through the resolver pipeline
      // (card locations load directly; handles hit the registry; misses are
      // a target_not_resolvable domain error, never a raw ENOENT).
      const card = candidate
        ? await loadCard(candidate.card_url!)
        : await resolveFriendRequestCard(store, target, defaultProviders(relayBaseFromHost(hostUrl)));
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
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Delivered friend_request to ${card.agent_id} over the mailbox (host id ${id})`);
        return { text: outcome.text, json: envelope };
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
          const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
            (id) => `Delivered friend_response to ${peer} over the mailbox (host id ${id})`);
          return { text: outcome.text, json: envelope };
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
          const outcome = await deliverViaMailboxRecorded(followUp, { home, host: hostUrl, socketFactory: ctx.socketFactory },
            (id) => `delivered profile_share to ${followUp.to_agent_id} over the mailbox (host id ${id})`);
          return { text: `Applied response; ${outcome.text}`, json: followUp };
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
      // spec-139: plain `pending` = ALL requests awaiting accept/decline;
      // `--new` = only un-notified ones (the notifier-cron surface).
      const onlyNew = takeBoolFlag(args, "--new");
      const pending = onlyNew ? await store.unnotifiedFriendRequests() : await store.pendingFriendRequests();
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
          // spec-139: lets callers distinguish new from already-surfaced requests.
          ...(c.notified_at ? { notified_at: c.notified_at } : {}),
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
    if (action === "auto-accept") {
      // spec-132 greeter: accept every pending request and send the welcome
      // share. Hard-gated on greeter_mode (runGreeterPass throws
      // greeter_mode_required). Delivery wiring copies `friend accept --deliver`.
      const deliver = takeBoolFlag(args, "--deliver");
      const hostUrl = parseHost(args, ctx);
      const entries = await runGreeterPass(store);
      if (deliver) {
        for (const entry of entries) {
          for (const envelope of [entry.accept_envelope, entry.share_envelope]) {
            if (!envelope) continue;
            try {
              await deliverToPeer(store, envelope, envelope.to_agent_id);
            } catch (error) {
              if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
              // Dial-out peer (no inbound endpoint): deliver over the host mailbox.
              await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
                (id) => `Delivered ${envelope.type} (host id ${id})`);
            }
          }
        }
      }
      const json = entries.map(({ agent_id, accepted, welcomed }) => ({ agent_id, accepted, welcomed }));
      return { text: JSON.stringify(json, null, 2), json };
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
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Shared object ${objectId} to ${peer} over the mailbox (host id ${id})`);
        return { text: outcome.text, json: envelope };
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
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Revoked object ${objectId} for ${peer}; forwarded over the mailbox (host id ${id})`);
        return { text: outcome.text, json: envelope };
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
          const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
            (id) => `delivered to ${to} over the mailbox (host id ${id})`);
          return { text: `Raised escalation ${escalation.escalation_id}; ${outcome.text}`, json: envelope };
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
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `routed response to ${envelope.to_agent_id} over the mailbox (host id ${id})`);
        return { text: `Answered ${escalationId}; ${outcome.text}`, json: { ...escalation, response_envelope: envelope } };
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

  return null;
}
