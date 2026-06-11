// Dial-out client: the agent side of the host <-> agent WebSocket protocol
// (canonical spec: edge-book-host/docs/wire-protocol.md — every frame shape
// here is FROZEN by that doc).
//
// Invariants:
//   - the transport key (host-dialout-key.json) defines channel_id =
//     sha256(agent_key) and is TOFU-locked by the host; it is SEPARATE from
//     the identity keypair (identity.json) that defines the DID;
//   - on a `stand_down` frame the client MUST stop reconnecting (idle
//     stand-down); any other socket drop reconnects with jittered backoff;
//   - API responses carrying a `response_envelope` are auto-relayed over the
//     live channel (escalation answers, friend requests — spec-094/095);
//   - mailbox delivery is at-least-once: ack only after the envelope is
//     applied; dedupe happens by inner message_id in receiveEnvelope.
import crypto from "node:crypto";
import WebSocket from "ws";
import { DEFAULT_PAIR_TTL_MS, createPairRegistration, createSessionsRevokeFrame, loadOrCreateDialoutKey } from "./dialout-key.ts";
import type { PairRegistration, SessionsRevokeFrame } from "./dialout-key.ts";
import { apiUrl, closeServer, openLocalApi, requestBody } from "./dialout-local-api.ts";
import type { DialoutApiRequest, DialoutApiResponse, LocalApi } from "./dialout-local-api.ts";
import { PairCompleteWaiter } from "./dialout-pair.ts";
import type { PairCompleteResult } from "./dialout-pair.ts";
import { EdgeBookError, EdgeBookStore, type MessageEnvelope } from "./edge-book.ts";
import { logEvent, eventErrorCode } from "./event-log.ts";

export const DEFAULT_DIALOUT_HOST = "wss://edge-book-host.fly.dev/agent/ws";
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface SessionsRevokeAck {
  type: "sessions_revoke_ok";
  request_id?: string;
  channel_id?: string;
}

// Per-device session management (ea-claude-057).
export interface DeviceInfo {
  device_id: string;
  label: string;
  created_at: number;
  last_seen_at: number;
}
export interface SessionsListAck { type: "sessions_list_ok"; request_id?: string; devices?: DeviceInfo[] }
export interface SessionRevokeOneAck { type: "session_revoke_one_ok"; request_id?: string; device_id?: string; revoked?: boolean }

export interface DialoutSocket {
  readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener?(event: "open" | "message" | "close" | "error", handler: (event?: unknown) => void): void;
  onopen?: (event?: unknown) => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event?: unknown) => void;
  onerror?: (event?: unknown) => void;
}

export interface DialoutClientOptions {
  home?: string;
  host: string;
  heartbeatMs?: number;
  reconnect?: boolean;
  backoffMs?: number;
  socketFactory?: (url: string) => DialoutSocket;
  openLocalApi?: boolean;
  onStandDown?: (frame: { type?: string; reason?: string; idle_ms?: number }) => void | Promise<void>;
  // Mailbox transport (ea-claude-065). When a queued envelope is delivered, the
  // client decodes it, applies it via the store (friend request / object share /
  // revoke), then acks the host. Set autoApplyEnvelopes=false to handle manually.
  autoApplyEnvelopes?: boolean;
  onEnvelope?: (envelope: MessageEnvelope, result: { applied: boolean; error?: string }) => void | Promise<void>;
}

// A delivered mailbox message (Contract 1, mirrors edge-book-host).
export interface MailboxDeliverFrame { type: "mailbox_deliver"; id: string; from: string; blob_b64: string; ts: number }

// Resolved mailbox_send acknowledgement (spec-097). recipient_live reports
// whether any live channel claimed the recipient at enqueue time; absent when
// the host predates receipts.
export interface MailboxSendAck { id: string; recipient_live?: boolean }

// One entry from mailbox_status_ok (spec-097). queued_ms/recipient_live are
// present only for queued/delivered (key omitted otherwise).
export interface MailboxStatusEntry { id: string; state: "queued" | "delivered" | "acked" | "unknown"; queued_ms?: number; recipient_live?: boolean }

// Decide whether the agent should claim a handle with the relay on connect.
// Skip the default placeholder and any handle that isn't a valid slug — the
// slug rule mirrors isValidHandle in edge-book.ts.
export function shouldClaimHandle(handle: string | undefined): boolean {
  return !!handle && handle !== "agent.openclaw.local" && /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(handle);
}

function socketFactory(url: string): DialoutSocket {
  const SocketCtor = globalThis.WebSocket ?? WebSocket;
  return new SocketCtor(url) as unknown as DialoutSocket;
}

function addSocketListener(socket: DialoutSocket, event: "open" | "message" | "close" | "error", handler: (event?: unknown) => void): void {
  if (socket.addEventListener) {
    socket.addEventListener(event, handler);
    return;
  }
  const prop = `on${event}` as "onopen" | "onmessage" | "onclose" | "onerror";
  socket[prop] = handler as never;
}

export class EdgeBookDialoutClient {
  private options: Required<Omit<DialoutClientOptions, "home">> & { home?: string };
  private store: EdgeBookStore;
  private socket?: DialoutSocket;
  private localApi?: LocalApi;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private currentBackoff: number;
  private opened?: { resolve: () => void; reject: (error: Error) => void };
  private pendingSessionRevokes = new Map<string, {
    resolve: (ack: SessionsRevokeAck) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  // Generic request_id-keyed RPC waiters (sessions_list / session_revoke_one /
  // mailbox_status). rpcType lets an old host's {type:"error", ref:"<type>"}
  // frame — which carries NO request_id — reject pending requests of that type.
  private pendingRpc = new Map<string, {
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    rpcType: string;
  }>();
  private pendingMailboxSends = new Map<string, {
    resolve: (ack: MailboxSendAck) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pairCompleteWaiter = new PairCompleteWaiter();

  constructor(options: DialoutClientOptions) {
    this.options = {
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      reconnect: options.reconnect ?? true,
      backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
      socketFactory: options.socketFactory ?? socketFactory,
      openLocalApi: options.openLocalApi ?? true,
      onStandDown: options.onStandDown ?? (() => undefined),
      autoApplyEnvelopes: options.autoApplyEnvelopes ?? true,
      onEnvelope: options.onEnvelope ?? (() => undefined),
      host: options.host,
      home: options.home
    };
    this.store = new EdgeBookStore({ home: options.home });
    this.currentBackoff = this.options.backoffMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    if (this.localApi) await closeServer(this.localApi.server);
    this.localApi = undefined;
  }

  async pair(ttlMs = DEFAULT_PAIR_TTL_MS): Promise<PairRegistration> {
    const registration = await createPairRegistration(this.store, ttlMs);
    this.send(registration.frame);
    return registration;
  }

  // Wait up to ttlMs for a pair_complete frame from the host.
  // Returns null on timeout — old-host degradation (spec-135).
  waitForPairComplete(ttlMs: number): Promise<PairCompleteResult | null> {
    return this.pairCompleteWaiter.wait(ttlMs);
  }

  async revokeSessions(): Promise<SessionsRevokeFrame> {
    const frame = await createSessionsRevokeFrame(this.store);
    this.send(frame);
    return frame;
  }

  // List this agent's remembered devices on the host (ea-claude-057).
  async listSessionsAndWait(timeoutMs = 5_000): Promise<DeviceInfo[]> {
    const frame = await this.rpc("sessions_list", {}, "sessions_list_ok", timeoutMs);
    return (frame as unknown as SessionsListAck).devices || [];
  }

  // Revoke ONE device by its public device_id (ea-claude-057).
  async revokeOneSessionAndWait(device_id: string, timeoutMs = 5_000): Promise<boolean> {
    const frame = await this.rpc("session_revoke_one", { device_id }, "session_revoke_one_ok", timeoutMs);
    return Boolean((frame as unknown as SessionRevokeOneAck).revoked);
  }

  // Ask the host for per-message delivery state (spec-097). Returns null when
  // the host predates receipts — detected by the unknown-type error frame
  // (fast path) or the RPC timeout (lost-frame path); both degrade the same.
  async mailboxStatusAndWait(ids: string[], timeoutMs = 5_000): Promise<MailboxStatusEntry[] | null> {
    try {
      const frame = await this.rpc("mailbox_status", { ids }, "mailbox_status_ok", timeoutMs) as { type?: string; error?: string; statuses?: MailboxStatusEntry[] };
      if (frame.type === "mailbox_status_err") throw new EdgeBookError("mailbox_status_failed", String(frame.error || "mailbox_status rejected"));
      return frame.statuses ?? [];
    } catch (error) {
      if (error instanceof EdgeBookError && (error.code === "host_rpc_timeout" || error.code === "host_unsupported_rpc")) return null;
      throw error;
    }
  }

  // Small request/response helper over the dial-out socket, correlated by
  // request_id. `expect` documents the ack type; resolution is by request_id.
  private async rpc(type: string, extra: Record<string, unknown>, expect: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const request_id = crypto.randomUUID();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(request_id);
        reject(new EdgeBookError("host_rpc_timeout", `Timed out waiting for ${expect}`));
      }, timeoutMs);
      this.pendingRpc.set(request_id, { resolve, reject, timer, rpcType: type });
    });
    this.send({ type, request_id, ...extra });
    return promise;
  }

  async revokeSessionsAndWait(timeoutMs = 5_000): Promise<{ frame: SessionsRevokeFrame; ack: SessionsRevokeAck }> {
    const frame = await createSessionsRevokeFrame(this.store);
    const ackPromise = new Promise<SessionsRevokeAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSessionRevokes.delete(frame.request_id);
        reject(new EdgeBookError("host_revoke_timeout", "Timed out waiting for sessions_revoke_ok"));
      }, timeoutMs);
      this.pendingSessionRevokes.set(frame.request_id, { resolve, reject, timer });
    });
    this.send(frame);
    return { frame, ack: await ackPromise };
  }

  // ── Mailbox transport (Contract 1 / ea-claude-065) ─────────────────────────

  // Low-level: hand an opaque blob to the host for delivery to `to` (a peer DID
  // or channel_id). Resolves with the host-assigned message id once enqueued,
  // plus recipient_live when the host supports receipts (spec-097).
  async sendMailbox(to: string, blob: Buffer | Uint8Array, timeoutMs = 5_000, trace_id?: string): Promise<MailboxSendAck> {
    const request_id = crypto.randomUUID();
    const blob_b64 = Buffer.from(blob).toString("base64");
    const ack = new Promise<MailboxSendAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMailboxSends.delete(request_id);
        reject(new EdgeBookError("mailbox_send_timeout", "Timed out waiting for mailbox_send_ok"));
      }, timeoutMs);
      this.pendingMailboxSends.set(request_id, { resolve, reject, timer });
    });
    // trace_id (ea-claude-138) is an OPTIONAL observability sibling of the
    // opaque blob so the relay CAN log/correlate hops without parsing the
    // blob (host support ships in edge-book-host#12; older hosts use a
    // lenient field-picking parser and simply ignore it). The authoritative
    // copy lives inside the signed envelope.
    this.send({ type: "mailbox_send", request_id, to, blob_b64, ...(trace_id ? { trace_id } : {}) });
    return ack;
  }

  // High-level: deliver a signed envelope to its recipient (envelope.to_agent_id;
  // the host resolves the DID to a channel). Used to route friend requests,
  // object shares, and revokes through the mailbox instead of a manual file hop.
  async sendEnvelope(envelope: MessageEnvelope): Promise<MailboxSendAck> {
    const ack = await this.sendMailbox(envelope.to_agent_id, Buffer.from(JSON.stringify(envelope), "utf8"), 5_000, envelope.trace_id);
    // Flight recorder (spec-133): kinds/ids/dedup keys only — never bodies.
    await logEvent(this.store, "envelope.sent", { envelope_kind: envelope.type, to: envelope.to_agent_id, dedup_key: envelope.message_id, trace_id: envelope.trace_id });
    return ack;
  }

  private async handleMailboxDeliver(frame: MailboxDeliverFrame): Promise<void> {
    let envelope: MessageEnvelope | undefined;
    let applied = false;
    let error: string | undefined;
    try {
      envelope = JSON.parse(Buffer.from(frame.blob_b64, "base64").toString("utf8")) as MessageEnvelope;
      if (this.mailboxQueue) {
        this.pushMailbox({ id: frame.id, to: envelope.to_agent_id, from: frame.from, blob: frame.blob_b64, ts: frame.ts });
      } else if (this.options.autoApplyEnvelopes) {
        const followUp = await this.store.receiveEnvelope(envelope);
        applied = true;
        // If the store returned a profile_share follow-up (from a friend_response),
        // auto-deliver it to complete the two-step profile exchange.
        if (followUp && typeof followUp === "object" && "type" in followUp && (followUp as MessageEnvelope).type === "profile_share") {
          await this.sendEnvelope(followUp as MessageEnvelope).catch(() => undefined);
        }
      }
    } catch (e) {
      // Code only — e.message can embed raw payload text (JSON.parse), which
      // must never reach the event log (see eventErrorCode).
      error = eventErrorCode(e);
    }
    // Flight recorder (spec-133): kind/from/dedup key + outcome — never bodies.
    await logEvent(this.store, "envelope.received", {
      envelope_kind: envelope?.type ?? "unparseable",
      from: frame.from,
      dedup_key: envelope?.message_id,
      trace_id: envelope?.trace_id,
      applied,
      ...(error ? { error } : {}),
    });
    // Ack so the host deletes it. At-least-once delivery + dedupe-by-message_id
    // (verifyEnvelope rejects replays) makes acking-always safe and avoids a
    // poison message redelivering forever. Manual consumers ack via the queue.
    if (!this.mailboxQueue) this.send({ type: "mailbox_ack", id: frame.id });
    if (envelope) await this.options.onEnvelope?.(envelope, { applied, error });
  }

  // Contract-1 Transport facade. Enabling it switches deliver handling to manual
  // (queue) mode so the consumer drives apply + ack via receive()/ack().
  private mailboxQueue?: Array<{ id: string; to: string; from: string; blob: string; ts: number }>;
  private mailboxWaiters: Array<() => void> = [];
  private pushMailbox(m: { id: string; to: string; from: string; blob: string; ts: number }): void {
    this.mailboxQueue?.push(m);
    this.mailboxWaiters.splice(0).forEach((w) => w());
  }
  transport(): {
    send: (recipient: string, bytes: Uint8Array) => Promise<{ id: string }>;
    receive: () => AsyncIterable<{ id: string; to: string; from: string; blob: string; ts: number }>;
    ack: (id: string) => Promise<void>;
  } {
    this.mailboxQueue ||= [];
    const self = this;
    return {
      send: (recipient, bytes) => self.sendMailbox(recipient, bytes),
      ack: async (id) => { self.send({ type: "mailbox_ack", id }); },
      receive: async function* () {
        for (;;) {
          while (self.mailboxQueue && self.mailboxQueue.length === 0) {
            await new Promise<void>((r) => self.mailboxWaiters.push(r));
          }
          const next = self.mailboxQueue?.shift();
          if (next) yield next;
        }
      }
    };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.options.openLocalApi && !this.localApi) this.localApi = await openLocalApi(this.store);
    const socket = this.options.socketFactory(this.options.host);
    this.socket = socket;

    const opened = new Promise<void>((resolve, reject) => {
      this.opened = { resolve, reject };
      addSocketListener(socket, "open", async () => {
        try {
          this.currentBackoff = this.options.backoffMs;
          const key = await loadOrCreateDialoutKey(this.store);
          const identity = await this.store.identity();
          this.send({
            type: "hello",
            agent_key: key.agent_key,
            agent_did: identity.agent_id,
            version: "0.1.0",
            nonce: crypto.randomUUID()
          });
        } catch (error) {
          this.opened = undefined;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    addSocketListener(socket, "message", (event) => {
      void this.handleMessage((event as { data: unknown })?.data);
    });

    addSocketListener(socket, "close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      void logEvent(this.store, "dialout.disconnected", { host: this.options.host, stopped: this.stopped });
      if (!this.stopped && this.options.reconnect) this.scheduleReconnect();
    });

    await opened;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.currentBackoff;
    this.currentBackoff = Math.min(MAX_BACKOFF_MS, Math.round(this.currentBackoff * 1.7));
    void logEvent(this.store, "dialout.reconnect_scheduled", { host: this.options.host, delay_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  private send(value: unknown): void {
    this.socket?.send(JSON.stringify(value));
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const frame = JSON.parse(text) as DialoutApiRequest;
    if ((frame as { type?: string }).type === "hello_ok") {
      this.opened?.resolve();
      this.opened = undefined;
      void logEvent(this.store, "dialout.connected", { host: this.options.host });
      // Best-effort: auto-claim a real handle so peers can find this agent.
      // A claim failure (or default/invalid handle) never breaks the connection
      // or mail delivery — mail still routes by DID regardless.
      try {
        const identity = await this.store.identity();
        if (shouldClaimHandle(identity.handle)) {
          const claim = await this.store.buildHandleClaim();
          this.send({
            type: "handle_claim",
            request_id: `hc-${claim.claimed_at}`,
            handle: claim.handle,
            card: claim.card,
            claimed_at: claim.claimed_at,
            claim_sig: claim.claim_sig,
            discoverable: claim.discoverable
          });
        }
      } catch {
        /* best-effort: handle claim is non-fatal, mail still routes by DID */
      }
      return;
    }
    if ((frame as { type?: string; error?: string }).type === "hello_err") {
      const error = new EdgeBookError("host_hello_failed", (frame as { error?: string }).error || "Host rejected hello");
      this.opened?.reject(error);
      this.opened = undefined;
      return;
    }
    if ((frame as { type?: string }).type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if ((frame as { type?: string }).type === "sessions_list_ok" || (frame as { type?: string }).type === "session_revoke_one_ok" || (frame as { type?: string }).type === "mailbox_status_ok" || (frame as { type?: string }).type === "mailbox_status_err") {
      const ack = frame as unknown as { request_id?: string };
      const pending = this.pendingRpc.get(ack.request_id || "");
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(ack.request_id || "");
        pending.resolve(frame as unknown as Record<string, unknown>);
      }
      return;
    }
    if ((frame as { type?: string }).type === "stand_down" || (frame as { type?: string }).type === "dialout_idle") {
      await this.standDown(frame as { type?: string; reason?: string; idle_ms?: number });
      return;
    }
    if ((frame as { type?: string }).type === "pair_register_ok" || (frame as { type?: string }).type === "pair_register_err") return;
    if ((frame as { type?: string }).type === "pair_complete") {
      this.pairCompleteWaiter.onFrame(frame as unknown as { device_id?: string; label?: string });
      return;
    }
    if ((frame as { type?: string }).type === "sessions_revoke_ok") {
      const ack = frame as unknown as SessionsRevokeAck;
      const pending = this.pendingSessionRevokes.get(ack.request_id || "");
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSessionRevokes.delete(ack.request_id || "");
        pending.resolve(ack);
      }
      return;
    }
    const frameType = (frame as { type?: string }).type;
    if (frameType === "mailbox_send_ok") {
      const ack = frame as unknown as { request_id?: string; id?: string; recipient_live?: boolean };
      const pending = this.pendingMailboxSends.get(ack.request_id || "");
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMailboxSends.delete(ack.request_id || "");
        pending.resolve({ id: ack.id || "", ...(typeof ack.recipient_live === "boolean" ? { recipient_live: ack.recipient_live } : {}) });
      }
      return;
    }
    if (frameType === "mailbox_send_err") {
      const err = frame as unknown as { request_id?: string; error?: string };
      const pending = this.pendingMailboxSends.get(err.request_id || "");
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMailboxSends.delete(err.request_id || "");
        pending.reject(new EdgeBookError("mailbox_send_failed", err.error || "mailbox_send rejected"));
      }
      return;
    }
    if (frameType === "mailbox_deliver") {
      await this.handleMailboxDeliver(frame as unknown as MailboxDeliverFrame);
      return;
    }
    if (frameType === "handle_claim_ok" || frameType === "handle_claim_err") return;
    if (frameType === "error") {
      // An old host answers an unknown frame type with {type:"error", error:
      // "unknown_message_type", ref:"<type>"} and NO request_id. Fail every
      // pending RPC of that type so callers degrade immediately instead of
      // waiting out the timeout (spec-097 §C.3 fast path).
      const ref = (frame as unknown as { ref?: string | null }).ref;
      if (typeof ref !== "string") return;
      for (const [request_id, pending] of [...this.pendingRpc]) {
        if (pending.rpcType !== ref) continue;
        clearTimeout(pending.timer);
        this.pendingRpc.delete(request_id);
        pending.reject(new EdgeBookError("host_unsupported_rpc", `Host does not support ${ref}`));
      }
      return;
    }
    if (frame.type !== "host.api.request" && frame.type !== "api_request") return;
    const response = await this.handleApiRequest(frame);
    this.send(response);
  }

  private async standDown(frame: { type?: string; reason?: string; idle_ms?: number }): Promise<void> {
    this.stopped = true;
    await logEvent(this.store, "dialout.stand_down", { host: this.options.host, reason: frame.reason, idle_ms: frame.idle_ms });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    if (this.localApi) await closeServer(this.localApi.server);
    this.localApi = undefined;
    await this.options.onStandDown?.(frame);
  }

  // If an API response carries a routed-back `response_envelope` (e.g. the escalation
  // answer endpoint for remote escalations, or the approval resolve endpoint for
  // friend_accept approvals), deliver it over the mailbox. Best-effort: swallow +
  // audit relay errors so the human's action, which is already persisted, still
  // returns 200. Audit event names are keyed on the envelope type for honest trails
  // (e.g. "escalation_response.relay", "friend_response.relay").
  private async maybeRelayResponseEnvelope(status: number, bodyBuffer: Buffer): Promise<void> {
    if (status < 200 || status >= 300) return;
    let envelope: MessageEnvelope | undefined;
    try {
      const body = JSON.parse(bodyBuffer.toString("utf8")) as { response_envelope?: MessageEnvelope | null };
      if (body && body.response_envelope) envelope = body.response_envelope;
    } catch {
      return; // non-JSON or unparseable — nothing to relay
    }
    if (!envelope) return;
    const envType = (envelope as { type?: string }).type || "unknown";
    try {
      await this.sendEnvelope(envelope);
      await this.store.audit(`${envType}.relay`, envelope.to_agent_id, { message_id: envelope.message_id, ref: envelope.ref });
    } catch (error) {
      await this.store.audit(`${envType}.relay_failed`, envelope.to_agent_id, { ref: envelope.ref, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async handleApiRequest(frame: DialoutApiRequest): Promise<DialoutApiResponse> {
    try {
      if (!this.localApi) {
        if (!this.options.openLocalApi) throw new EdgeBookError("local_api_disabled", "This dial-out client does not serve local API requests");
        this.localApi = await openLocalApi(this.store);
      }
      const method = (frame.method || "GET").toUpperCase();
      const response = await fetch(apiUrl(this.localApi.baseUrl, frame), {
        method,
        headers: {
          "content-type": "application/json",
          "x-openclaw-session": this.localApi.sessionId,
          "x-openclaw-csrf": this.localApi.csrf
        },
        body: requestBody(frame, method)
      });
      const bodyBuffer = Buffer.from(await response.arrayBuffer());
      // Auto-relay: when the owner answers a *remote* escalation or approves/rejects
      // a friend request in the reader, the endpoint returns a signed `response_envelope`
      // addressed to the originating agent. We hold the live channel, so route it back
      // over the mailbox. Best-effort — the action is already persisted locally, so a
      // relay failure must not fail the human's request.
      await this.maybeRelayResponseEnvelope(response.status, bodyBuffer);
      return {
        type: "api_response",
        id: frame.id || frame.request_id || "",
        request_id: frame.request_id || frame.id || "",
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8" },
        body_b64: bodyBuffer.toString("base64")
      };
    } catch (error) {
      const body = {
        ok: false,
        code: error instanceof EdgeBookError ? error.code : "internal_error",
        error: error instanceof Error ? error.message : String(error)
      };
      return {
        type: "api_response",
        id: frame.id || frame.request_id || "",
        request_id: frame.request_id || frame.id || "",
        status: error instanceof EdgeBookError ? 400 : 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body_b64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
        body
      };
    }
  }
}

// One-shot transient-connection helpers live in dialout-oneshot.ts to keep
// this file within the 500-line limit. Re-exported here for back-compat.
export { deliverEnvelopeViaMailbox, listSessions, mailboxStatus, revokeOneSession, sendPairRegistration, sendSessionsRevoke } from "./dialout-oneshot.ts";
