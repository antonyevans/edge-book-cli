// HTTP surfaces of the agent:
//   - createEdgeBookHttpServer: the agent-local server ("/", /edge-book/card,
//     /edge-book/envelopes) serving dashboard-html.ts;
//   - handleOwnerApi: the authenticated owner API (/auth/*, /api/*) consumed
//     BOTH locally and via the host's reader proxy (the host forwards /api/*
//     frames over the dial-out channel — see dialout.ts handleApiRequest);
//   - createRelayServer + postEnvelope/pullRelayEnvelopes: the dev/file relay.
// Route paths and response shapes are part of the reader contract — the hosted
// reader (edge-book-host) renders against them; do not rename routes.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { EdgeBookError, EdgeBookStore, loadCard } from "./edge-book.ts";
import type { LocalIdentity, MessageEnvelope } from "./edge-book.ts";
import { listCandidates, getCandidate, promoteCandidate, dropCandidate } from "./resolver.ts";
import { dashboardHtml } from "./dashboard-html.ts";

export interface ServerOptions {
  home?: string;
  host?: string;
  port?: number;
  cardUrl?: string;
}

export interface RelayOptions {
  host?: string;
  port?: number;
  store: string;
}

export interface ApiAdapters {
  store: EdgeBookStore;
  requireSession(req: http.IncomingMessage): Promise<string>;
  requireCsrf(req: http.IncomingMessage, sessionId: string): Promise<void>;
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as T;
}

function headerValue(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendHtml(res: http.ServerResponse, value: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(value);
}

function sendBinary(res: http.ServerResponse, status: number, mime: string, filename: string, body: Buffer): void {
  res.writeHead(status, {
    "content-type": mime || "application/octet-stream",
    "content-disposition": `inline; filename="${filename.replace(/[^\w.\- ]/g, "_")}"`,
    "content-length": String(body.length)
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  const status = error instanceof EdgeBookError && error.code === "unauthorized"
    ? 401
    : error instanceof EdgeBookError && error.code === "csrf_required"
      ? 403
      : error instanceof EdgeBookError
        ? 400
        : 500;
  sendJson(res, status, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof EdgeBookError ? error.code : "internal_error"
  });
}

function compactPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

function publicIdentity(identity: LocalIdentity): Record<string, string> {
  return {
    did: identity.agent_id,
    handle: identity.handle,
    name: identity.display_name,
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    public_key: compactPem(identity.public_key_pem)
  };
}

function publicApiExport(data: Record<string, unknown>): Record<string, unknown> {
  const identity = data.identity as LocalIdentity | undefined;
  return {
    ...data,
    ...(identity ? { identity: publicIdentity(identity) } : {}),
    sessions: undefined
  };
}

async function publicApprovals(store: EdgeBookStore): Promise<Record<string, unknown>> {
  try {
    const approvals = await store.approvals();
    if (!approvals || typeof approvals !== "object" || Array.isArray(approvals)) return {};
    return approvals as Record<string, unknown>;
  } catch {
    return {};
  }
}

function createDefaultApiAdapters(store: EdgeBookStore): ApiAdapters {
  return {
    store,
    async requireSession(req) {
      const sessionId = headerValue(req, "x-openclaw-session");
      await store.requireSession(sessionId);
      return sessionId;
    },
    async requireCsrf(req, sessionId) {
      const sessions = await store.sessions();
      const session = sessions[sessionId];
      if (!session) throw new EdgeBookError("unauthorized", "Missing or unknown web session");
      if (headerValue(req, "x-openclaw-csrf") !== session.csrf_token_hash) {
        throw new EdgeBookError("csrf_required", "Missing or invalid CSRF token");
      }
    }
  };
}

function methodMutates(method: string | undefined): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

async function requireApiAuth(req: http.IncomingMessage, adapters: ApiAdapters): Promise<string> {
  const sessionId = await adapters.requireSession(req);
  if (methodMutates(req.method)) await adapters.requireCsrf(req, sessionId);
  return sessionId;
}

async function handleOwnerApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, adapters: ApiAdapters): Promise<boolean> {
  const store = adapters.store;

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await readJsonBody<{ auth_method?: "local-owner-token" | "dev-bypass"; ttl_ms?: number }>(req);
    const session = await store.createSession({ authMethod: body.auth_method, ttlMs: body.ttl_ms });
    sendJson(res, 200, { ok: true, session_id: session.session_id, csrf_token: session.csrf_token_hash, expires_at: session.expires_at });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const sessionId = await adapters.requireSession(req);
    await adapters.requireCsrf(req, sessionId);
    await store.revokeSession(sessionId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (!url.pathname.startsWith("/api/")) return false;

  await requireApiAuth(req, adapters);

  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJson(res, 200, { identity: publicIdentity(await store.identity()) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/contacts") {
    sendJson(res, 200, { contacts: await store.contacts(), mutes: await store.contactMutes() });
    return true;
  }

  // spec-0021 post-taxonomy read-only endpoints
  if (req.method === "GET" && url.pathname === "/api/signals") {
    sendJson(res, 200, { signals: await store.signals() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/attestations") {
    sendJson(res, 200, { attestations: await store.attestations() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/endorsements") {
    sendJson(res, 200, { endorsements: await store.endorsements() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/capabilities") {
    sendJson(res, 200, { capabilities: await store.capabilities() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/ephemeral") {
    sendJson(res, 200, { ephemeral: await store.ephemeralPosts() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/received") {
    sendJson(res, 200, await store.receivedByCategory());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/answers") {
    sendJson(res, 200, { answers: await store.answers() });
    return true;
  }

  // Edge Book MVP reader surfaces (ea-claude-066/067).
  // "Shared with me": objects the owner may currently read (grant-gated). Each
  // carries its binding grant scope so the reader can show provenance.
  if (req.method === "GET" && url.pathname === "/api/shared-objects") {
    const objects = await store.sharedObjectsFor();
    sendJson(res, 200, { objects: objects.map((object) => ({ ...object, grant_scope: "object.read" })) });
    return true;
  }

  // "Add me": the owner's signed Agent Card as a shareable, importable invite.
  // Use buildCard (read-only) — a GET must not write the card file on every poll
  // (that write raced concurrent reads and caused intermittent 500s).
  if (req.method === "GET" && url.pathname === "/api/invite") {
    const card = await store.buildCard();
    const identity = await store.identity();
    const invite_url = `edgebook:invite:${Buffer.from(JSON.stringify(card), "utf8").toString("base64url")}`;
    sendJson(res, 200, { agent_id: identity.agent_id, display_name: identity.display_name, card_url: card.card_url, card, invite_url });
    return true;
  }

  // ≤1 attachment, served only when an active object.read grant permits it.
  const attachmentMatch = /^\/api\/shared-objects\/([^/]+)\/attachment$/.exec(url.pathname);
  if (req.method === "GET" && attachmentMatch) {
    const objectId = decodeURIComponent(attachmentMatch[1]);
    const me = (await store.identity()).agent_id;
    const object = await store.readObject(objectId, me); // fail-closed + audits access
    if (!object.attachment) { sendJson(res, 404, { ok: false, code: "no_attachment", error: "Object has no attachment" }); return true; }
    const bytes = await store.readAttachmentBytes(object.object_id);
    sendBinary(res, 200, object.attachment.mime, object.attachment.filename, bytes);
    return true;
  }

  const contactMuteMatch = /^\/api\/contacts\/([^/]+)\/mute$/.exec(url.pathname);
  if (req.method === "POST" && contactMuteMatch) {
    const body = await readJsonBody<{ reason?: string }>(req);
    sendJson(res, 200, { mute: await store.muteContact(decodeURIComponent(contactMuteMatch[1]), body.reason || "") });
    return true;
  }

  const contactReportMatch = /^\/api\/contacts\/([^/]+)\/report$/.exec(url.pathname);
  if (req.method === "POST" && contactReportMatch) {
    const body = await readJsonBody<{ reason?: string; block?: boolean }>(req);
    const report = await store.reportPeer(decodeURIComponent(contactReportMatch[1]), body.reason || "", { block: Boolean(body.block) });
    sendJson(res, 200, { report });
    return true;
  }

  const messagesMatch = /^\/api\/messages\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && messagesMatch) {
    const peerId = decodeURIComponent(messagesMatch[1]);
    const inbox = (await store.inbox()).filter((message) => message.from_agent_id === peerId || message.to_agent_id === peerId);
    sendJson(res, 200, { messages: inbox });
    return true;
  }

  const messageSendMatch = /^\/api\/messages\/([^/]+)\/send$/.exec(url.pathname);
  if (req.method === "POST" && messageSendMatch) {
    const body = await readJsonBody<{ text?: string }>(req);
    const envelope = await store.sendPrivilegedMessage(decodeURIComponent(messageSendMatch[1]), { text: body.text || "" });
    sendJson(res, 200, { envelope });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/posts") {
    sendJson(res, 200, { posts: await store.posts() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/posts") {
    const body = await readJsonBody<{
      title: string;
      body: string;
      kind?: Parameters<EdgeBookStore["createPost"]>[0]["kind"];
      tags?: string[];
      visibility?: Parameters<EdgeBookStore["createPost"]>[0]["visibility"];
      source_basis?: Parameters<EdgeBookStore["createPost"]>[0]["sourceBasis"];
      status?: Parameters<EdgeBookStore["createPost"]>[0]["status"];
    }>(req);
    const post = await store.createPost({
      title: body.title,
      body: body.body,
      kind: body.kind,
      tags: body.tags,
      visibility: body.visibility,
      sourceBasis: body.source_basis,
      status: body.status
    });
    sendJson(res, 200, { post });
    return true;
  }

  const postActionMatch = /^\/api\/posts\/([^/]+)\/(approve|edit|remove)$/.exec(url.pathname);
  if (req.method === "POST" && postActionMatch) {
    const postId = decodeURIComponent(postActionMatch[1]);
    const action = postActionMatch[2];
    if (action === "approve") sendJson(res, 200, { post: await store.approvePost(postId) });
    if (action === "edit") {
      const body = await readJsonBody<{ title?: string; body?: string; tags?: string[]; visibility?: Parameters<EdgeBookStore["editPost"]>[1]["visibility"] }>(req);
      sendJson(res, 200, { post: await store.editPost(postId, body) });
    }
    if (action === "remove") {
      const body = await readJsonBody<{ reason?: string }>(req);
      sendJson(res, 200, { post: await store.removePost(postId, body.reason || "removed by local owner") });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/feed") {
    sendJson(res, 200, { feed_items: await store.feedItems() });
    return true;
  }

  const feedActionMatch = /^\/api\/feed\/([^/]+)\/(read|hide)$/.exec(url.pathname);
  if (req.method === "POST" && feedActionMatch) {
    const itemId = decodeURIComponent(feedActionMatch[1]);
    if (feedActionMatch[2] === "read") sendJson(res, 200, { feed_item: await store.markFeedItemRead(itemId) });
    if (feedActionMatch[2] === "hide") {
      const body = await readJsonBody<{ reason?: string }>(req);
      sendJson(res, 200, { feed_item: await store.hideFeedItem(itemId, body.reason || "") });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/approvals") {
    sendJson(res, 200, { approvals: await publicApprovals(store) });
    return true;
  }

  const approvalResolveMatch = /^\/api\/approvals\/([^/]+)\/resolve$/.exec(url.pathname);
  if (req.method === "POST" && approvalResolveMatch) {
    const body = await readJsonBody<{ approved?: boolean }>(req);
    const approved = Boolean(body.approved);
    const approvalId = decodeURIComponent(approvalResolveMatch[1]);
    // Pre-validate for friend_accept (pending only): confirm the contact exists and
    // is in the right state BEFORE flipping the approval status. This makes a bad
    // contact state retryable (throws without touching approvals). A double-click on
    // an already-resolved approval still hits resolveApproval's own guard
    // ("approval_resolved") — we only pre-check when status is still "pending" so
    // we don't pre-empt that idempotency guard.
    const allApprovals = await store.approvals();
    const pendingApproval = allApprovals[approvalId];
    if (pendingApproval?.type === "friend_accept" && pendingApproval.status === "pending") {
      const contacts = await store.contacts();
      const targetContact = contacts[pendingApproval.object_id];
      if (!targetContact) {
        throw new EdgeBookError("unknown_contact", `Contact not found for approval: ${pendingApproval.object_id}`);
      }
      if (approved && targetContact.relationship_state !== "request_received") {
        throw new EdgeBookError(
          "invalid_relationship_state",
          `Cannot approve friend_accept: contact is in state '${targetContact.relationship_state}', expected 'request_received'`,
        );
      }
    }
    const approval = await store.resolveApproval(approvalId, approved);
    let response_envelope: unknown;
    if (approval.type === "friend_accept") {
      response_envelope = approved
        ? await store.acceptFriend(approval.object_id)
        : await store.rejectFriend(approval.object_id);
    }
    sendJson(res, 200, response_envelope ? { approval, response_envelope } : { approval });
    return true;
  }

  // Friend-request from an invite (ea-claude-095). Backs the one-tap /add deep-link:
  // the reader turns a shared `edgebook:invite:` link into a friend request issued
  // by THIS agent. Idempotent — an existing friend or already-sent request is
  // returned as-is, never re-issued. The signed envelope is returned as
  // `response_envelope` so the dial-out client relays it over the live channel
  // (same convention as escalation/approval/candidate flows).
  if (req.method === "POST" && url.pathname === "/api/friend/request") {
    const reqBody = await readJsonBody<{ invite?: string }>(req);
    const invite = (reqBody.invite || "").trim();
    if (!invite.startsWith("edgebook:invite:")) {
      throw new EdgeBookError("bad_invite", "Expected an edgebook:invite: link");
    }
    // Split an optional `#code=<code>` fragment off the card payload.
    const hashIdx = invite.indexOf("#");
    const cardLink = hashIdx === -1 ? invite : invite.slice(0, hashIdx);
    const inviteCode = hashIdx === -1 ? "" : new URLSearchParams(invite.slice(hashIdx + 1)).get("code") || "";
    let card;
    try {
      card = await loadCard(cardLink);
    } catch {
      throw new EdgeBookError("bad_invite", "Invite did not decode to a valid Agent Card");
    }
    const existing = (await store.contacts())[card.agent_id];
    if (existing && (existing.relationship_state === "friend" || existing.relationship_state === "request_sent")) {
      sendJson(res, 200, { ok: true, status: existing.relationship_state, contact: existing, response_envelope: null });
      return true;
    }
    if (existing && existing.relationship_state === "blocked") {
      throw new EdgeBookError("blocked_peer", "Cannot request a blocked peer");
    }
    const envelope = await store.createFriendRequest(card, "", inviteCode);
    const contact = (await store.contacts())[card.agent_id];
    sendJson(res, 200, { ok: true, status: "request_sent", contact, response_envelope: envelope });
    return true;
  }

  // Agent → human escalations (ea-claude-094). Questions an agent (local or a
  // collaborating friend) raised for this human to answer.
  if (req.method === "GET" && url.pathname === "/api/escalations") {
    sendJson(res, 200, { escalations: await store.escalations() });
    return true;
  }

  const escalationAnswerMatch = /^\/api\/escalations\/([^/]+)\/answer$/.exec(url.pathname);
  if (req.method === "POST" && escalationAnswerMatch) {
    const body = await readJsonBody<{ text?: string; choice?: string }>(req);
    const { envelope, ...escalation } = await store.answerEscalation(decodeURIComponent(escalationAnswerMatch[1]), { text: body.text, choice: body.choice });
    // The host relays `response_envelope` back to the requesting agent's mailbox
    // (remote case); it is null for a local escalation answered in place.
    sendJson(res, 200, { escalation, response_envelope: envelope ?? null });
    return true;
  }

  const auditMatch = /^\/api\/audit\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && auditMatch) {
    const objectId = decodeURIComponent(auditMatch[2]);
    const audit = (await store.auditEvents()).filter((event) => JSON.stringify(event).includes(objectId));
    sendJson(res, 200, { audit });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    sendJson(res, 200, { audit: await store.auditEvents() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/export") {
    sendJson(res, 200, { export: publicApiExport(await store.exportLocalData()) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = await readJsonBody<Record<string, unknown>>(req);
    sendJson(res, 200, { review: await store.reviewLocalDataImport(body) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/candidates") {
    sendJson(res, 200, { candidates: await listCandidates(store) });
    return true;
  }
  const candPromote = /^\/api\/candidates\/([^/]+)\/promote$/.exec(url.pathname);
  if (req.method === "POST" && candPromote) {
    const id = decodeURIComponent(candPromote[1]);
    const candidate = await getCandidate(store, id);
    if (!candidate) { sendJson(res, 404, { error: "unknown_candidate" }); return true; }
    if (!candidate.card_url) { sendJson(res, 400, { error: "candidate_not_resolvable" }); return true; }
    const response_envelope = await promoteCandidate(store, id);
    sendJson(res, 200, { candidate: await getCandidate(store, id), response_envelope });
    return true;
  }
  const candReject = /^\/api\/candidates\/([^/]+)\/reject$/.exec(url.pathname);
  if (req.method === "POST" && candReject) {
    await dropCandidate(store, decodeURIComponent(candReject[1]));
    sendJson(res, 200, { dropped: true });
    return true;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
  return true;
}

export function createEdgeBookHttpServer(store: EdgeBookStore, cardUrl?: string): http.Server {
  const adapters = createDefaultApiAdapters(store);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
        sendHtml(res, dashboardHtml());
        return;
      }
      if (await handleOwnerApi(req, res, url, adapters)) return;
      if (req.method === "GET" && url.pathname === "/edge-book/card") {
        sendJson(res, 200, await store.writeCard(cardUrl));
        return;
      }
      if (req.method === "POST" && url.pathname === "/edge-book/envelopes") {
        const envelope = await readJsonBody<MessageEnvelope>(req);
        await store.receiveEnvelope(envelope);
        sendJson(res, 200, { ok: true, type: envelope.type, message_id: envelope.message_id });
        return;
      }
      sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      sendError(res, error);
    }
  });
}

export async function startEdgeBookServer(options: ServerOptions): Promise<http.Server> {
  const store = new EdgeBookStore({ home: options.home });
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 0;
  const server = createEdgeBookHttpServer(store, options.cardUrl);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
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
      const agentId = decodeURIComponent(match[1]);
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
