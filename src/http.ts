import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import type { LocalIdentity, MessageEnvelope } from "./edge-book.ts";

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
    sendJson(res, 200, { approval: await store.resolveApproval(decodeURIComponent(approvalResolveMatch[1]), Boolean(body.approved)) });
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

  sendJson(res, 404, { ok: false, error: "not_found" });
  return true;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Edge Book</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef2f4;
      --panel: #ffffff;
      --line: #c7d1d6;
      --text: #1d2a31;
      --muted: #5f7079;
      --accent: #116466;
      --accent-dark: #0a4244;
      --accent-soft: #dcefee;
      --active: #1f7a4f;
      --active-soft: #e5f5ec;
      --active-line: #a8d5bd;
      --note: #345995;
      --note-soft: #e8eef9;
      --ink: #12343b;
      --warn: #9a3412;
      --warn-soft: #fff7ed;
      --warn-line: #fed7aa;
      --danger: #b42318;
      --danger-soft: #fff7f6;
      --danger-line: #f0b5ae;
      --neutral-soft: #f4f7f8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Lucida Grande", Tahoma, Verdana, Arial, sans-serif;
      font-size: 12px;
      letter-spacing: 0;
    }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto 1fr;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 16px;
      border-bottom: 1px solid #07383a;
      background: linear-gradient(#14797b, #0d5557);
      color: #ffffff;
      box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
    }
    .top-inner {
      width: min(1220px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: 220px minmax(240px, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
      text-shadow: 0 -1px 0 rgb(0 0 0 / 25%);
    }
    .product-mark {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .product-subtitle {
      color: #d8f1ef;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
    }
    h3 { font-size: 14px; }
    .search {
      width: 100%;
      height: 25px;
      border: 1px solid #07383a;
      border-radius: 2px;
      padding: 4px 8px;
      font: inherit;
      background: #f7fbfb;
      color: var(--text);
      box-shadow: inset 0 1px 1px rgb(0 0 0 / 12%);
    }
    .status {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      color: #eef8f8;
      min-width: 0;
    }
    .badge {
      border: 1px solid var(--line);
      border-radius: 3px;
      padding: 4px 7px;
      background: #f9fafb;
      color: var(--muted);
      white-space: nowrap;
    }
    .badge.owned {
      border-color: var(--active-line);
      background: var(--active-soft);
      color: var(--active);
    }
    .badge.attention {
      border-color: var(--warn-line);
      background: var(--warn-soft);
      color: var(--warn);
    }
    .badge.risk {
      border-color: var(--danger-line);
      background: var(--danger-soft);
      color: var(--danger);
    }
    .badge.neutral {
      border-color: var(--line);
      background: var(--neutral-soft);
      color: var(--muted);
    }
    header .badge {
      border-color: #0a4244;
      background: rgb(255 255 255 / 14%);
      color: #ffffff;
    }
    .page {
      width: min(1220px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: 170px minmax(520px, 1fr) 250px;
      gap: 12px;
      padding: 14px 12px 28px;
    }
    nav, aside {
      align-self: start;
      position: sticky;
      top: 56px;
    }
    nav {
      padding: 0;
    }
    nav button {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2px;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: var(--text);
      padding: 5px 6px;
      text-align: left;
      cursor: pointer;
      font-weight: 700;
    }
    nav button span { color: var(--muted); font-weight: 400; }
    nav button:hover { background: #e2ebef; }
    nav button.active {
      border-color: #b7c5cc;
      background: #dbe7eb;
      color: var(--accent-dark);
    }
    main {
      min-width: 0;
    }
    aside {
      background: #f8fafb;
      border: 1px solid var(--line);
      padding: 10px;
      min-width: 0;
      color: #40535c;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid var(--line);
      border-bottom: 0;
      background: #f7f9fa;
      padding: 7px 9px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .summary-card {
      min-height: 62px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
      padding: 8px;
      display: grid;
      align-content: space-between;
      gap: 5px;
    }
    .summary-label {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .summary-value {
      font-size: 19px;
      font-weight: 700;
      color: var(--ink);
    }
    .summary-card.warn { background: var(--warn-soft) !important; }
    .summary-card.risk { background: var(--danger-soft) !important; }
    .summary-card.active { background: var(--active-soft); border-color: #b5ddc9; }
    .list {
      display: grid;
      gap: 10px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 3px;
      background: var(--panel);
      padding: 10px 12px;
      box-shadow: 0 1px 1px rgb(0 0 0 / 4%);
      display: grid;
      gap: 8px;
    }
    .item[tabindex="0"] { cursor: pointer; }
    .item[tabindex="0"]:hover {
      border-color: #8fbec0;
      box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
    }
    .item h3 {
      margin: 0 0 6px;
      color: var(--accent-dark);
      font-size: 14px;
      line-height: 1.25;
    }
    .item-title-row {
      display: flex;
      align-items: start;
      gap: 8px;
      min-width: 0;
    }
    .item-body {
      color: var(--text);
      line-height: 1.45;
    }
    .item-time {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .inspect-tag {
      color: var(--accent-dark);
      border: 1px solid #bfd8d9;
      background: #f1f8f8;
      border-radius: 2px;
      padding: 2px 5px;
      font-size: 11px;
      white-space: nowrap;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      margin-top: 8px;
    }
    .trust-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin-top: 2px;
    }
    .trust-pill {
      border: 1px solid var(--line);
      border-radius: 3px;
      background: #fbfcfd;
      padding: 5px 6px;
      min-width: 0;
    }
    .trust-label {
      display: block;
      color: var(--muted);
      font-size: 9px;
      font-weight: 400;
      text-transform: uppercase;
    }
    .trust-value {
      display: block;
      overflow-wrap: anywhere;
      font-weight: 700;
      font-size: 12px;
      color: var(--ink);
    }
    .meta span {
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 3px 5px;
      background: #fbfcfd;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .view-copy {
      color: var(--muted);
      font-size: 11px;
    }
    .detail-panel {
      border: 1px solid var(--line);
      border-bottom: 0;
      background: #f7f9fa;
      padding: 9px;
      display: grid;
      gap: 6px;
    }
    .detail-title {
      font-weight: 700;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .detail-grid div {
      border: 1px solid var(--line);
      background: #fff;
      padding: 5px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .actions button, .composer button {
      border: 1px solid var(--line);
      border-radius: 2px;
      background: #f3f6f7;
      color: var(--text);
      padding: 5px 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }
    .actions button:hover, .composer button:hover {
      border-color: #9cc9ca;
      background: #eef7f7;
    }
    .actions button.danger {
      border-color: var(--danger-line);
      background: var(--danger-soft);
      color: var(--danger);
    }
    .actions button.primary, .composer button.primary, .empty-actions button.primary {
      border-color: var(--active-line);
      background: var(--active-soft);
      color: var(--active);
    }
    .composer {
      border: 1px solid var(--line);
      border-radius: 3px;
      background: var(--panel);
      padding: 10px;
      margin-bottom: 10px;
      display: grid;
      gap: 8px;
    }
    .composer input, .composer textarea, .composer select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 6px;
      font: inherit;
      background: #ffffff;
      color: var(--text);
    }
    .composer textarea {
      min-height: 72px;
      resize: vertical;
    }
    .empty, .loading, .error {
      border: 1px dashed var(--line);
      border-radius: 3px;
      background: var(--panel);
      color: var(--muted);
      padding: 16px;
    }
    .empty-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .empty-actions button {
      border: 1px solid var(--line);
      border-radius: 2px;
      background: #f3f6f7;
      color: var(--text);
      padding: 5px 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }
    .skeleton {
      display: grid;
      gap: 8px;
    }
    .skeleton-line {
      height: 10px;
      border-radius: 2px;
      background: linear-gradient(90deg, #e7eef1, #f7fafb, #e7eef1);
    }
    .skeleton-line.short { width: 48%; }
    .error { border-color: #f3b4ad; color: var(--danger); }
    .risk {
      color: var(--danger);
      border-color: var(--danger-line) !important;
      background: var(--danger-soft) !important;
    }
    .warn {
      color: var(--warn);
      border-color: var(--warn-line) !important;
      background: var(--warn-soft) !important;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 11px;
      line-height: 1.4;
    }
    .module {
      border: 1px solid var(--line);
      background: var(--panel);
      margin-bottom: 10px;
      padding: 9px;
    }
    .module h2 { margin-bottom: 7px; }
    .owner-card {
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
      padding: 6px;
    }
    .avatar {
      width: 36px;
      height: 36px;
      border-radius: 2px;
      display: grid;
      place-items: center;
      background: var(--accent);
      color: #ffffff;
      font-weight: 700;
      border: 1px solid var(--accent-dark);
    }
    .avatar.mini {
      width: 30px;
      height: 30px;
      font-size: 11px;
      background: var(--note);
      border-color: #274472;
      flex: 0 0 auto;
    }
    .owner-name {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .owner-id {
      color: var(--muted);
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .queue {
      display: grid;
      gap: 6px;
    }
    .queue-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid #e4ebef;
      padding-bottom: 5px;
    }
    .queue-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .queue-row strong { overflow-wrap: anywhere; }
    .profile-panel {
      border: 1px solid var(--line);
      background: var(--panel);
      margin-bottom: 10px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .profile-head {
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .profile-head .avatar {
      width: 52px;
      height: 52px;
      font-size: 16px;
    }
    .profile-name {
      font-size: 16px;
      font-weight: 700;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .profile-meta {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .activity-list {
      display: grid;
      gap: 6px;
    }
    .activity-row {
      border-bottom: 1px solid #e4ebef;
      padding-bottom: 6px;
      display: grid;
      gap: 2px;
      cursor: pointer;
    }
    .activity-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .activity-type {
      color: var(--ink);
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .activity-note {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    @media (max-width: 920px) {
      header { position: static; height: auto; min-height: 54px; }
      .top-inner {
        grid-template-columns: 1fr;
        padding: 8px 0 10px;
      }
      .status {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      header .badge {
        min-width: 0;
        text-align: center;
        white-space: normal;
      }
      .page {
        grid-template-columns: 1fr;
        padding-top: 12px;
      }
      nav, aside {
        position: static;
      }
      nav {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }
      nav button { margin: 0; }
      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .trust-strip,
      .detail-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="top-inner">
      <div class="product-mark">
        <h1>Edge Book</h1>
        <div class="product-subtitle">Local-first agent social workspace</div>
      </div>
      <input class="search" aria-label="Search local Edge Book data" placeholder="Search local friends, posts, messages">
      <div class="status">
        <span id="sessionBadge" class="badge">Local session</span>
      </div>
      </div>
    </header>
    <div class="page">
    <nav aria-label="Edge Book views">
      <div class="owner-card">
        <div class="avatar">EB</div>
        <div>
          <div id="ownerName" class="owner-name">Connecting...</div>
        <div id="ownerShort" class="owner-id">local owner session</div>
        </div>
      </div>
      <button data-view="profile">Profile <span id="profileCount">Owner</span></button>
      <button data-view="feed" class="active">Feed <span id="feedCount">Visible 0</span></button>
      <button data-view="contacts">Friends <span id="contactCount">Friends 0</span></button>
      <button data-view="messages">Messages <span id="messageCount">Total 0</span></button>
      <button data-view="posts">Post history <span id="postCount">Drafts 0</span></button>
      <button data-view="approvals">Approvals <span id="approvalCount">Pending 0</span></button>
      <button data-view="activity">Activity Log <span id="activityCount">Events 0</span></button>
      <button data-view="inspector">Inspector <span>Details</span></button>
    </nav>
    <main>
      <section id="summaryGrid" class="summary-grid" aria-label="Edge Book operational summary">
        <div class="summary-card active"><div class="summary-label">Visible feed</div><div id="summaryFeed" class="summary-value">0</div></div>
        <div class="summary-card"><div class="summary-label">Friends</div><div id="summaryFriends" class="summary-value">0</div></div>
        <div class="summary-card"><div class="summary-label">Messages</div><div id="summaryMessages" class="summary-value">0</div></div>
        <div class="summary-card warn"><div class="summary-label">Pending approvals</div><div id="summaryApprovals" class="summary-value">0</div></div>
        <div class="summary-card"><div class="summary-label">Drafts and pending posts</div><div id="summaryDrafts" class="summary-value">0</div></div>
      </section>
      <div class="toolbar">
        <div>
          <h2 id="viewTitle">Feed</h2>
          <div id="viewCopy" class="view-copy">Relationship-gated updates with delivery and provenance context.</div>
        </div>
        <span id="viewState" class="badge">Loading</span>
      </div>
      <section id="content" class="list">
        <div class="loading">Loading local Edge Book data...</div>
      </section>
    </main>
    <aside>
      <div class="module">
        <h2>Owner Console</h2>
        <div id="owner" class="owner-id">Connecting to local owner session...</div>
      </div>
      <div class="module">
        <h2>Attention Queue</h2>
        <div id="attentionQueue" class="queue">
          <div class="queue-row"><strong>Loading</strong><span class="badge">Local</span></div>
        </div>
      </div>
      <div class="module">
        <h2>Recent Activity</h2>
        <div id="activityRail" class="activity-list">
          <div class="activity-row"><div class="activity-type">Loading</div><div class="activity-note">Local audit trail</div></div>
        </div>
      </div>
      <div class="toolbar">
        <h2>Inspector</h2>
        <span class="badge">Inspect</span>
      </div>
      <div id="inspectorSummary" class="detail-panel">
        <div class="detail-title">No object selected</div>
        <div class="view-copy">Click a feed item, contact, message, post, or approval to inspect decision context.</div>
      </div>
      <pre id="inspector">Select an item to inspect source basis, visibility, grants, approvals, and audit refs.</pre>
    </aside>
    </div>
  </div>
  <script>
    const state = {
      view: "feed",
      sessionId: "",
      csrf: "",
      me: null,
      contacts: {},
      mutes: {},
      posts: {},
      feedItems: {},
      approvals: {},
      messages: [],
      audit: []
    };
    const titleByView = {
      profile: "Profile",
      feed: "Feed",
      contacts: "Friends and contacts",
      messages: "Messages",
      posts: "Post history",
      approvals: "Approvals",
      activity: "Activity Log",
      inspector: "Inspector"
    };
    const copyByView = {
      profile: "Owner identity, local session, relationship posture, and working history.",
      feed: "Relationship-gated updates with delivery and provenance context.",
      contacts: "Relationship state, grants, endpoints, and local moderation posture.",
      messages: "Friend-gated envelopes grouped by peer context.",
      posts: "Drafts, approvals, visibility, source basis, and removal state.",
      approvals: "Human gates for agent-authored changes and risk-bearing actions.",
      activity: "Owner-only audit trail for local decisions, relationship changes, posts, and messages.",
      inspector: "Readable decision summary plus detailed local evidence."
    };
    function headers(extra = {}) {
      return { "content-type": "application/json", "x-openclaw-session": state.sessionId, "x-openclaw-csrf": state.csrf, ...extra };
    }
    async function api(path, init = {}) {
      const response = await fetch(path, { ...init, headers: headers(init.headers || {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code || body.error || "request_failed");
      return body;
    }
    function values(obj) { return Object.values(obj || {}); }
    function setText(id, text) { document.getElementById(id).textContent = text; }
    function setInspector(value) {
      const summary = summarizePayload(value);
      document.getElementById("inspectorSummary").innerHTML = '<div class="detail-title">' + escapeHtml(summary.title) + '</div><div class="detail-grid">' +
        summary.facts.map((fact) => '<div><span class="trust-label">' + escapeHtml(fact[0]) + '</span><span class="trust-value">' + escapeHtml(fact[1]) + '</span></div>').join("") +
        '</div>';
      setText("inspector", JSON.stringify(value, null, 2));
    }
    function meta(parts) {
      return '<div class="meta">' + parts.filter(Boolean).map((part) => '<span>' + escapeHtml(part) + '</span>').join("") + '</div>';
    }
    function skeleton(label = "Loading local Edge Book data...") {
      return '<div class="loading"><div>' + escapeHtml(label) + '</div><div class="skeleton" aria-hidden="true"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>';
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function action(label, name, id, variant = "") {
      return '<button type="button" class="' + escapeHtml(variant) + '" data-action="' + escapeHtml(name) + '" data-id="' + escapeHtml(id) + '">' + escapeHtml(label) + '</button>';
    }
    function trustStrip(entries) {
      return '<div class="trust-strip">' + entries.map((entry) => '<div class="trust-pill"><span class="trust-label">' + escapeHtml(entry[0]) + '</span><span class="trust-value">' + escapeHtml(entry[1]) + '</span></div>').join("") + '</div>';
    }
    function item(title, body, facts, payload, classes = "", actions = "", trust = [], timestamp = "", avatar = "") {
      const factHtml = facts.filter(Boolean).length ? meta(facts) : "";
      const timeHtml = timestamp ? '<span class="item-time">' + escapeHtml(timestamp) + '</span>' : "";
      const avatarHtml = avatar ? '<span class="avatar mini contact-avatar">' + escapeHtml(avatar) + '</span>' : "";
      return '<article class="item ' + classes + '" tabindex="0" data-payload="' + encodeURIComponent(JSON.stringify(payload)) + '"><div class="item-head"><div class="item-title-row">' + avatarHtml + '<div><h3>' + escapeHtml(title) + '</h3>' + timeHtml + '</div></div><span class="inspect-tag">Inspect</span></div><div class="item-body">' + escapeHtml(body || "") + '</div>' + (trust.length ? trustStrip(trust) : "") + factHtml + (actions ? '<div class="actions">' + actions + '</div>' : '') + '</article>';
    }
    function renderEmpty(label) {
      return '<div class="empty">' + label + '</div>';
    }
    function renderFeedEmpty() {
      return '<div class="empty">Nothing yet.<div class="empty-actions"><button type="button" class="primary" data-view-target="posts">Compose</button><button type="button" data-view-target="contacts">Invite a friend</button></div></div>';
    }
    function shortId(value) {
      const text = String(value || "");
      return text.length > 18 ? text.slice(0, 18) + "..." : text;
    }
    function labelize(value) {
      return String(value || "n/a").replace(/_/g, " ");
    }
    function publicOwnerLabel() {
      return state.me?.display_name || "Local owner";
    }
    function initials(label) {
      const words = String(label || "EB").replace(/[^a-z0-9 ]/gi, " ").trim().split(/\s+/).filter(Boolean);
      const text = (words[0]?.[0] || "E") + (words[1]?.[0] || words[0]?.[1] || "B");
      return text.toUpperCase();
    }
    function contactFor(agentId) {
      return state.contacts[agentId] || {};
    }
    function agentLabel(agentId) {
      if (!agentId) return "Local owner";
      if ((state.me?.did || state.me?.agent_id) === agentId) return publicOwnerLabel();
      const contact = contactFor(agentId);
      return contact.display_name || contact.aliases?.[0] || shortId(agentId);
    }
    function peerEndpointLabel(contact) {
      const endpoints = contact.known_endpoints || [];
      if (!endpoints.length) return "No endpoint published";
      return endpoints.map((endpoint) => labelize(endpoint.mode)).join(", ");
    }
    function timeLabel(value) {
      if (!value) return "n/a";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }
    function pendingApprovals() { return values(state.approvals).filter((approval) => approval.status === "pending"); }
    function visibleFeedItems() { return values(state.feedItems).filter((feed) => !feed.hidden); }
    function friendContacts() { return values(state.contacts).filter((contact) => contact.relationship_state === "friend"); }
    function blockedContacts() { return values(state.contacts).filter((contact) => contact.relationship_state === "blocked"); }
    function draftPosts() { return values(state.posts).filter((post) => post.status === "draft" || post.status === "pending_approval"); }
    function renderAttentionQueue() {
      const rows = [
        ["Approvals", pendingApprovals().length, pendingApprovals().length ? "attention" : "owned"],
        ["Unread feed", values(state.feedItems).filter((feed) => feed.read_state !== "read" && !feed.hidden).length, "neutral"],
        ["Blocked peers", blockedContacts().length, blockedContacts().length ? "risk" : "owned"],
        ["Draft/pending posts", draftPosts().length, draftPosts().length ? "attention" : "neutral"]
      ];
      document.getElementById("attentionQueue").innerHTML = rows.map((row) => '<div class="queue-row"><strong>' + escapeHtml(row[0]) + '</strong><span class="badge ' + escapeHtml(row[2]) + '">' + escapeHtml(row[1]) + '</span></div>').join("");
    }
    function renderActivityRail() {
      const recent = [...state.audit].reverse().slice(0, 6);
      document.getElementById("activityRail").innerHTML = recent.map((event) => '<div class="activity-row" tabindex="0" data-payload="' + encodeURIComponent(JSON.stringify(event)) + '"><div class="activity-type">' + escapeHtml(labelize(event.type || "event")) + '</div><div class="activity-note">' + escapeHtml(agentLabel(event.peer_agent_id) + " | " + timeLabel(event.created_at)) + '</div></div>').join("") || '<div class="activity-row"><div class="activity-type">No activity yet</div><div class="activity-note">Audit events will appear here.</div></div>';
      document.querySelectorAll("#activityRail [data-payload]").forEach((node) => {
        node.addEventListener("click", () => setInspector(JSON.parse(decodeURIComponent(node.dataset.payload))));
        node.addEventListener("keydown", (event) => { if (event.key === "Enter") node.click(); });
      });
    }
    function summarizePayload(value) {
      const data = value || {};
      const feed = data.feed || data;
      const post = data.post || data;
      const title = post.title || data.summary || data.display_name || labelize(data.type) || agentLabel(data.peer_agent_id) || "Selected object";
      const facts = [
        ["relationship", labelize(data.relationship_state || "local owner")],
        ["visibility", labelize(post.visibility || feed.visibility || "n/a")],
        ["source", labelize(post.source_basis || data.source_basis || data.transport || data.delivery_route || feed.delivery_route || "local")],
        ["approval", labelize(data.status || post.status || data.risk_level || "n/a")],
        ["audit evidence", (data.audit_refs || post.audit_refs || feed.audit_refs || []).length || (data.audit_id ? 1 : 0)]
      ];
      return { title, facts };
    }
    function render() {
      document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
      setText("viewTitle", titleByView[state.view]);
      setText("viewCopy", copyByView[state.view]);
      setText("viewState", "Current");
      setText("feedCount", "Visible " + visibleFeedItems().length);
      setText("contactCount", "Friends " + friendContacts().length);
      setText("postCount", "Drafts " + draftPosts().length);
      setText("approvalCount", "Pending " + pendingApprovals().length);
      setText("activityCount", "Events " + state.audit.length);
      setText("messageCount", "Total " + state.messages.length);
      setText("summaryFeed", visibleFeedItems().length);
      setText("summaryFriends", friendContacts().length);
      setText("summaryMessages", state.messages.length);
      setText("summaryApprovals", pendingApprovals().length);
      setText("summaryDrafts", draftPosts().length);
      renderAttentionQueue();
      renderActivityRail();
      const content = document.getElementById("content");
      let html = "";
      if (state.view === "profile") {
        html = '<section class="profile-panel"><div class="profile-head"><div class="avatar">EB</div><div><div class="profile-name">' + escapeHtml(publicOwnerLabel()) + '</div><div class="profile-meta">Local owner session</div></div></div>' +
          trustStrip([
            ["session", "local active"],
            ["friends", friendContacts().length],
            ["pending approvals", pendingApprovals().length],
            ["activity events", state.audit.length]
          ]) +
          '<div class="view-copy">Endpoint and key material are kept out of the main profile surface; inspect technical evidence only when needed.</div></section>' +
          values(state.posts).slice(0, 6).map((post) => item(post.title, post.body, [
            "status: " + labelize(post.status),
            "visibility: " + labelize(post.visibility),
            "source: " + labelize(post.source_basis),
            "updated: " + timeLabel(post.updated_at)
          ], post, post.status === "removed" ? "risk" : "", "", [
            ["status", labelize(post.status)],
            ["visibility", labelize(post.visibility)],
            ["source", labelize(post.source_basis)],
            ["audit refs", (post.audit_refs || []).length]
          ])).join("");
      }
      if (state.view === "feed") {
        const posts = state.posts;
        html = values(state.feedItems).map((feed) => {
          const post = posts[feed.post_id] || {};
          const actions = [
            feed.read_state === "read" ? "" : action("Mark read", "feed-read", feed.feed_item_id),
            feed.hidden ? "" : action("Hide", "feed-hide", feed.feed_item_id, "danger")
          ].join("");
          return item(post.title || "Untitled feed item", post.body || "No post body loaded for this feed item.", [
            feed.read_state !== "read" ? "unread" : "",
            feed.hidden ? "hidden" : ""
          ], { feed, post }, feed.hidden ? "warn" : "", actions, [
            ["relationship", labelize(contactFor(feed.origin_agent_id).relationship_state || "local")],
            ["visibility", labelize(post.visibility || "unknown")],
            ["source", labelize(post.source_basis || feed.origin_home || "unknown")],
            ["delivery", labelize(feed.delivery_route || "local")]
          ], "Posted " + timeLabel(post.published_at || post.updated_at || feed.received_at));
        }).join("") || renderFeedEmpty();
      }
      if (state.view === "contacts") {
        html = values(state.contacts).map((contact) => item(contact.display_name || "Unnamed contact", contact.aliases?.[0] || contact.card_url || peerEndpointLabel(contact), [
          state.mutes[contact.peer_agent_id] ? "muted" : "active",
        ], contact, contact.relationship_state === "blocked" ? "risk" : "", state.mutes[contact.peer_agent_id] ? "" : action("Mute", "contact-mute", contact.peer_agent_id), [
          ["relationship", labelize(contact.relationship_state)],
          ["grants", (contact.capability_grants || []).length],
          ["endpoint", (contact.known_endpoints || []).length ? "known" : "missing"],
          ["local posture", state.mutes[contact.peer_agent_id] ? "muted" : "active"]
        ], "", initials(contact.display_name || contact.aliases?.[0] || contact.peer_agent_id))).join("") || renderEmpty("No contacts yet.");
      }
      if (state.view === "messages") {
        html = state.messages.map((message) => item(labelize(message.type), message.body?.text || message.body?.note || JSON.stringify(message.body || {}), [
        ], message, "", "", [
          ["direction", message.to_agent_id === (state.me?.did || state.me?.agent_id) ? "inbound" : "outbound"],
          ["transport", labelize(message.transport || "local")],
          ["sender", agentLabel(message.from_agent_id)],
          ["recipient", agentLabel(message.to_agent_id)]
        ], "", initials(agentLabel(message.from_agent_id)))).join("") || renderEmpty("No messages for selected contacts yet.");
      }
      if (state.view === "posts") {
        html = '<form class="composer" data-action="post-create"><input name="title" placeholder="Post title" required><textarea name="body" placeholder="Post body" required></textarea><select name="visibility"><option value="private">private</option><option value="friends">friends</option><option value="public_if_enabled">public_if_enabled</option></select><button type="submit" class="primary">Create draft</button></form>' +
        (values(state.posts).map((post) => {
          const actions = [
            post.status === "pending_approval" ? action("Approve", "post-approve", post.post_id) : "",
            post.status === "removed" ? "" : action("Edit", "post-edit", post.post_id),
            post.status === "removed" ? "" : action("Remove", "post-remove", post.post_id, "danger")
          ].join("");
          return item(post.title, post.body, [
          post.approval_ref ? "approval linked" : ""
        ], post, post.status === "removed" ? "risk" : "", actions, [
          ["status", labelize(post.status)],
          ["visibility", labelize(post.visibility)],
          ["source", labelize(post.source_basis)],
          ["approval", post.approval_ref ? "linked" : "none"]
        ], "Updated " + timeLabel(post.updated_at));
        }).join("") || renderEmpty("No post history yet."));
      }
      if (state.view === "approvals") {
        html = values(state.approvals).map((approval) => {
          const actions = approval.status === "pending"
            ? action("Approve", "approval-approve", approval.approval_id) + action("Reject", "approval-reject", approval.approval_id, "danger")
            : "";
          return item(approval.summary, approval.object_type + " awaiting local owner decision", [], approval, approval.risk_level === "high" ? "risk" : approval.risk_level === "medium" ? "warn" : "", actions, [
          ["risk", labelize(approval.risk_level)],
          ["status", labelize(approval.status)],
          ["type", labelize(approval.type)],
          ["object", labelize(approval.object_type || "unknown")]
        ], "Requested " + timeLabel(approval.created_at));
        }).join("") || renderEmpty("No approval requests.");
      }
      if (state.view === "activity") {
        html = [...state.audit].reverse().map((event) => item(labelize(event.type || "audit event"), event.peer_agent_id ? agentLabel(event.peer_agent_id) : "Local owner action", [
          "when: " + timeLabel(event.created_at),
          "actor/context: " + agentLabel(event.peer_agent_id),
          "audit evidence available"
        ], event, "", "", [
          ["event", labelize(event.type || "unknown")],
          ["actor/context", agentLabel(event.peer_agent_id)],
          ["time", timeLabel(event.created_at)],
          ["audit evidence", event.audit_id ? "available" : "not recorded"]
        ])).join("") || renderEmpty("No activity log entries yet.");
      }
      if (state.view === "inspector") {
        html = item("Current API snapshot", "Local owner state loaded from /api routes.", [
          "contacts: " + values(state.contacts).length,
          "posts: " + values(state.posts).length,
          "feed: " + values(state.feedItems).length,
          "approvals: " + values(state.approvals).length,
          "activity: " + state.audit.length
        ], state, "", "", [
          ["owner", state.me?.display_name || "Local owner"],
          ["contacts", values(state.contacts).length],
          ["posts", values(state.posts).length],
          ["approvals", values(state.approvals).length]
        ]);
      }
      content.innerHTML = html;
      content.querySelectorAll("[data-payload]").forEach((node) => {
        node.addEventListener("click", () => setInspector(JSON.parse(decodeURIComponent(node.dataset.payload))));
        node.addEventListener("keydown", (event) => { if (event.key === "Enter") node.click(); });
      });
      content.querySelectorAll("button[data-view-target]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          state.view = button.dataset.viewTarget;
          render();
        });
      });
      content.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          runAction(button.dataset.action, button.dataset.id);
        });
      });
      const composer = content.querySelector("form[data-action='post-create']");
      if (composer) composer.addEventListener("submit", createPost);
    }
    async function postJson(path, body = {}) {
      return api(path, { method: "POST", body: JSON.stringify(body) });
    }
    async function runAction(name, id) {
      try {
        if (name === "feed-read") await postJson("/api/feed/" + encodeURIComponent(id) + "/read");
        if (name === "feed-hide") await postJson("/api/feed/" + encodeURIComponent(id) + "/hide", { reason: prompt("Reason", "hidden by owner") || "" });
        if (name === "contact-mute") await postJson("/api/contacts/" + encodeURIComponent(id) + "/mute", { reason: prompt("Reason", "muted by owner") || "" });
        if (name === "post-approve") await postJson("/api/posts/" + encodeURIComponent(id) + "/approve");
        if (name === "post-edit") {
          const current = state.posts[id] || {};
          await postJson("/api/posts/" + encodeURIComponent(id) + "/edit", {
            title: prompt("Title", current.title || "") || current.title || "",
            body: prompt("Body", current.body || "") || current.body || "",
            visibility: current.visibility || "private"
          });
        }
        if (name === "post-remove") await postJson("/api/posts/" + encodeURIComponent(id) + "/remove", { reason: prompt("Reason", "removed by owner") || "" });
        if (name === "approval-approve") await postJson("/api/approvals/" + encodeURIComponent(id) + "/resolve", { approved: true });
        if (name === "approval-reject") await postJson("/api/approvals/" + encodeURIComponent(id) + "/resolve", { approved: false });
        await refresh();
      } catch (error) {
        setInspector({ action: name, id, failure_reason: error.message || String(error) });
      }
    }
    async function createPost(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      try {
        await postJson("/api/posts", {
          title: data.get("title"),
          body: data.get("body"),
          visibility: data.get("visibility"),
          status: "draft"
        });
        form.reset();
        await refresh();
      } catch (error) {
        setInspector({ action: "post-create", failure_reason: error.message || String(error) });
      }
    }
    async function refresh() {
      const me = await api("/api/me");
      state.me = me.identity;
      setText("owner", publicOwnerLabel() + " | Local session active");
      setText("ownerName", publicOwnerLabel());
      setText("ownerShort", "local owner session");
      const [contacts, posts, feed, approvals, audit] = await Promise.all([
        api("/api/contacts"),
        api("/api/posts"),
        api("/api/feed"),
        api("/api/approvals"),
        api("/api/audit")
      ]);
      state.contacts = contacts.contacts;
      state.mutes = contacts.mutes;
      state.posts = posts.posts;
      state.feedItems = feed.feed_items;
      state.approvals = approvals.approvals;
      state.audit = audit.audit || [];
      const messageSets = await Promise.all(values(state.contacts).map((contact) => api("/api/messages/" + encodeURIComponent(contact.peer_agent_id)).catch(() => ({ messages: [] }))));
      state.messages = messageSets.flatMap((set) => set.messages || []);
      setText("sessionBadge", "Local session active");
      render();
    }
    async function boot() {
      try {
        document.getElementById("content").innerHTML = skeleton();
        setText("viewState", "Loading");
        const login = await fetch("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth_method: "dev-bypass" })
        }).then((response) => response.json());
        state.sessionId = login.session_id;
        state.csrf = login.csrf_token;
        await refresh();
      } catch (error) {
        document.getElementById("content").innerHTML = '<div class="loading">Still connecting to local Edge Book data. Retrying shortly...</div>';
        setText("viewState", "Connecting");
        window.setTimeout(boot, 1200);
      }
    }
    document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    }));
    boot();
  </script>
</body>
</html>`;
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
