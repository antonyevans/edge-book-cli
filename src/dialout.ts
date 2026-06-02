import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import { startEdgeBookServer } from "./http.ts";

const KEY_FILE = "host-dialout-key.json";
const DEFAULT_PAIR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface DialoutKey {
  schema: "edge-book-host-dialout-key/0.1";
  key_id: string;
  agent_key: string;
  public_key_pem: string;
  private_key_pem: string;
  created_at: string;
}

export interface DialoutApiRequest {
  type: "host.api.request" | "api_request";
  id?: string;
  request_id?: string;
  method?: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  body?: unknown;
  body_b64?: string | null;
}

export interface DialoutApiResponse {
  type: "api_response";
  id: string;
  request_id: string;
  status: number;
  headers: Record<string, string>;
  body_b64: string;
  body?: unknown;
}

export interface PairRegistration {
  code: string;
  frame: {
    type: "pair_register";
    code: string;
    ttl_ms: number;
    request_id: string;
  };
}

export interface SessionsRevokeFrame {
  type: "sessions_revoke";
  request_id: string;
}

export interface SessionsRevokeAck {
  type: "sessions_revoke_ok";
  request_id?: string;
  channel_id?: string;
}

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
}

interface LocalApi {
  server: http.Server;
  baseUrl: string;
  sessionId: string;
  csrf: string;
}

function now(): string {
  return new Date().toISOString();
}

function keyId(agentKey: string): string {
  return `agent_${crypto.createHash("sha256").update(agentKey).digest("base64url").slice(0, 32)}`;
}

export function channelIdForKey(key: DialoutKey): string {
  return crypto.createHash("sha256").update(key.agent_key).digest("hex");
}

async function chmodBestEffort(file: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(file, mode);
  } catch {
    // Some mounted filesystems do not honor POSIX modes.
  }
}

export async function loadOrCreateDialoutKey(store: EdgeBookStore): Promise<DialoutKey> {
  const file = store.file(KEY_FILE);
  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DialoutKey>;
    if (existing.agent_key && existing.public_key_pem && existing.private_key_pem && existing.key_id) return existing as DialoutKey;
    if (existing.public_key_pem && existing.private_key_pem && existing.key_id) {
      const migrated = {
        ...existing,
        agent_key: `ed25519:${Buffer.from(existing.public_key_pem, "utf8").toString("base64")}`
      } as DialoutKey;
      migrated.key_id = keyId(migrated.agent_key);
      await fs.writeFile(file, `${JSON.stringify(migrated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmodBestEffort(file, 0o600);
      return migrated;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyDer = pair.publicKey.export({ type: "spki", format: "der" });
  const agentKey = `ed25519:${Buffer.from(publicKeyDer).toString("base64")}`;
  const key: DialoutKey = {
    schema: "edge-book-host-dialout-key/0.1",
    key_id: keyId(agentKey),
    agent_key: agentKey,
    public_key_pem: publicKeyPem,
    private_key_pem: privateKeyPem,
    created_at: now()
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(key, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmodBestEffort(file, 0o600);
  return key;
}

export function generatePairingCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export async function createPairRegistration(store: EdgeBookStore, ttlMs = DEFAULT_PAIR_TTL_MS): Promise<PairRegistration> {
  const code = generatePairingCode();
  return {
    code,
    frame: {
      type: "pair_register",
      code,
      ttl_ms: ttlMs,
      request_id: crypto.randomUUID()
    }
  };
}

export async function createSessionsRevokeFrame(store: EdgeBookStore): Promise<SessionsRevokeFrame> {
  await loadOrCreateDialoutKey(store);
  return {
    type: "sessions_revoke",
    request_id: crypto.randomUUID()
  };
}

function socketFactory(url: string): DialoutSocket {
  const SocketCtor = globalThis.WebSocket;
  if (!SocketCtor) throw new EdgeBookError("websocket_unavailable", "This Node runtime does not provide global WebSocket");
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

function serverBaseUrl(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new EdgeBookError("local_api_unavailable", "Local API server did not expose a port");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function openLocalApi(store: EdgeBookStore): Promise<LocalApi> {
  const server = await startEdgeBookServer({ home: store.home, host: "127.0.0.1", port: 0 });
  const baseUrl = serverBaseUrl(server);
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth_method: "future-remote-auth", ttl_ms: 24 * 60 * 60 * 1000 })
  });
  if (!login.ok) {
    await closeServer(server);
    throw new EdgeBookError("local_api_login_failed", `Local API login failed: ${login.status}`);
  }
  const body = await login.json() as { session_id: string; csrf_token: string };
  return { server, baseUrl, sessionId: body.session_id, csrf: body.csrf_token };
}

function normalizeApiPath(value: string): string {
  if (!value.startsWith("/api/")) throw new EdgeBookError("invalid_proxy_path", "Dial-out only proxies /api/* JSON requests");
  return value;
}

function apiUrl(baseUrl: string, frame: DialoutApiRequest): string {
  return `${baseUrl}${normalizeApiPath(frame.path)}${frame.query || ""}`;
}

function requestBody(frame: DialoutApiRequest, method: string): Buffer | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (typeof frame.body_b64 === "string") return Buffer.from(frame.body_b64, "base64");
  return Buffer.from(JSON.stringify(frame.body ?? {}), "utf8");
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

  constructor(options: DialoutClientOptions) {
    this.options = {
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      reconnect: options.reconnect ?? true,
      backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
      socketFactory: options.socketFactory ?? socketFactory,
      openLocalApi: options.openLocalApi ?? true,
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

  async revokeSessions(): Promise<SessionsRevokeFrame> {
    const frame = await createSessionsRevokeFrame(this.store);
    this.send(frame);
    return frame;
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

  private async connect(): Promise<void> {
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
      if (!this.stopped && this.options.reconnect) this.scheduleReconnect();
    });

    await opened;
  }

  private scheduleReconnect(): void {
    const delay = this.currentBackoff;
    this.currentBackoff = Math.min(MAX_BACKOFF_MS, Math.round(this.currentBackoff * 1.7));
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
    if ((frame as { type?: string }).type === "pair_register_ok" || (frame as { type?: string }).type === "pair_register_err") return;
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
    if ((frame as { type?: string }).type === "error") return;
    if (frame.type !== "host.api.request" && frame.type !== "api_request") return;
    const response = await this.handleApiRequest(frame);
    this.send(response);
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

export async function sendPairRegistration(options: DialoutClientOptions & { ttlMs?: number }): Promise<PairRegistration> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const registration = await client.pair(options.ttlMs ?? DEFAULT_PAIR_TTL_MS);
  await client.stop();
  return registration;
}

export async function sendSessionsRevoke(options: DialoutClientOptions): Promise<SessionsRevokeFrame> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { frame, ack } = await client.revokeSessionsAndWait();
  await client.stop();
  return { ...frame, channel_id: ack.channel_id } as SessionsRevokeFrame & { channel_id?: string };
}
