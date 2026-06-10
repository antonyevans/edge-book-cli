/* eslint-disable max-lines -- GRANDFATHERED at 835 code lines (2026-06-10): flat command dispatch; split per-command handlers into feature modules, then remove this disable. See DESIGN.md. */
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
import { broadcastPost, deliverToEndpoint, deliverToPeer, parseHome, parseHost, readEnvelope, relayBaseFromHost, requireArg, takeBoolFlag, takeFlag, takeRepeated, takeRepeatedKV } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { handleIdentityCli } from "./cli-identity.ts";
import { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient, deliverEnvelopeViaMailbox, listSessions, revokeOneSession, sendPairRegistration, sendSessionsRevoke } from "./dialout.ts";
import type { SessionsRevokeFrame } from "./dialout-key.ts";
import { loadCard, runTwoAgentHarness, EdgeBookError, EdgeBookStore, contentHash, defaultProfile, slugifyHandle } from "./edge-book.ts";
import { renderUsage } from "./commands-doc.ts";
import type { FieldVisibility, FriendRequestBody } from "./edge-book.ts";
import { postRelayEnvelope, pullRelayEnvelopes, startRelayServer, startEdgeBookServer } from "./http.ts";
import { resolveTarget, defaultProviders, listCandidates, getCandidate, markCandidateApproved } from "./resolver.ts";
import { makeNotifyOnEnvelope, resolveNotifyCmd } from "./notify.ts";
import { ensureNotifierCron, defaultHermesRunner } from "./host-cron.ts";

export { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient };
export type { CliContext, CliResult } from "./cli-shared.ts";

function usage(): string {
  return renderUsage();
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

  const identityResult = await handleIdentityCli(command, args, ctx, home, store);
  if (identityResult) return identityResult;

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
      // `home` can be undefined when neither --home nor ctx.home is set; ensureNotifierCron
      // tolerates that at runtime (any failure is caught below). Documented cast to keep
      // pre-existing behavior unchanged — see FINDINGS.md §1.
      const res = ensureNotifierCron({ runner: defaultHermesRunner(), home: home as string, disabled });
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
    // Same documented cast as the dialout branch: `home` may be undefined and
    // ensureNotifierCron reports (not throws) failures. See FINDINGS.md §1.
    const res = ensureNotifierCron({ runner: defaultHermesRunner(), home: home as string, disabled });
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
