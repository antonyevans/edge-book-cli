// spec-0021 post-taxonomy CLI commands (split from cli.ts): attest, endorse,
// signal, capability, query/share/coordinate/delegate, answer, query-delete,
// ephemeral, answers, report. Command names/flags are FROZEN (npm surface);
// handleCli in cli.ts stays the only dispatch entry and calls this handler in
// dispatch order. Returns null when the command is not one of its own.
import { broadcastPost, deliverViaMailboxRecorded, parseHost, requireArg, takeBoolFlag, takeFlag } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { EdgeBookError, EdgeBookStore, contentHash } from "./edge-book.ts";
import { activeReceivedEphemeral, resolveReceivedQuery } from "./store-received-surface.ts";

export async function handleTaxonomyCli(command: string, args: string[], ctx: CliContext, store: EdgeBookStore): Promise<CliResult | null> {
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
    // Parent resolution order (spec-140): local query first, then a received
    // query with that post_id (ambiguous_query if it came from multiple senders).
    let query = (await store.ephemeralPosts())[queryId];
    let receivedAuthor: string | undefined;
    if (!query) {
      const received = await resolveReceivedQuery(store, queryId);
      if (!received) throw new EdgeBookError("not_found", `No local or received query ${queryId} to answer`);
      query = received.post;
      receivedAuthor = received.author;
    }
    // Compute the parent hash over the query's immutable signed content (strip
    // signature and lifecycle, which are not part of the signed payload).
    const { signature: _sig, lifecycle: _lc, ...queryUnsigned } = query;
    const ans = await store.createAnswer({
      parent: { uri: "edgebook:query:" + queryId, hash: contentHash(queryUnsigned) },
      body: requireArg(takeFlag(args, "--body"), "--body"),
    });
    if (deliver) {
      let n = await broadcastPost(store, hostUrl, ctx.socketFactory, ans);
      // spec-140: a received query's author must get the answer even when the
      // friend fan-out above does not reach them (e.g. since unfriended).
      if (receivedAuthor && (await store.contacts())[receivedAuthor]?.relationship_state !== "friend") {
        const envelope = await store.signPostPublishEnvelope({ to_agent_id: receivedAuthor, post: ans });
        await deliverViaMailboxRecorded(envelope, { home: store.home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Delivered post_publish (host id ${id})`);
        n++;
      }
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
    // spec-140: both directions — own posts plus friends' actionable posts.
    const out = { mine: await store.ephemeralPosts(), received: await activeReceivedEphemeral(store) };
    return { text: JSON.stringify(out, null, 2), json: out };
  }

  if (command === "answers") {
    // spec-140: both directions — own answers plus friends' answers received.
    const out = { mine: await store.answers(), received: (await store.receivedByCategory()).answers };
    return { text: JSON.stringify(out, null, 2), json: out };
  }

  if (command === "report") {
    const peer = requireArg(args.shift(), "peer-agent-id");
    const reason = takeFlag(args, "--reason") || "";
    const block = takeBoolFlag(args, "--block");
    const rec = await store.reportPeer(peer, reason, { block });
    return { text: `Reported ${peer}${block ? " and blocked" : ""} (report ${rec.report_id})`, json: rec };
  }

  return null;
}
