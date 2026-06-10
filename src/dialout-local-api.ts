// Local-API bridge for the dial-out client (split from dialout.ts): spins up
// the in-process Edge Book HTTP server and translates proxied host
// `api_request` frames into authenticated local fetches. Frame shapes
// (api_request / api_response) are FROZEN by the host repo's
// docs/wire-protocol.md.
import http from "node:http";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import { startEdgeBookServer } from "./http.ts";

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

export interface LocalApi {
  server: http.Server;
  baseUrl: string;
  sessionId: string;
  csrf: string;
}

export function serverBaseUrl(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new EdgeBookError("local_api_unavailable", "Local API server did not expose a port");
  return `http://127.0.0.1:${address.port}`;
}

export async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function openLocalApi(store: EdgeBookStore): Promise<LocalApi> {
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

export function apiUrl(baseUrl: string, frame: DialoutApiRequest): string {
  return `${baseUrl}${normalizeApiPath(frame.path)}${frame.query || ""}`;
}

// Return type is Uint8Array<ArrayBuffer> (which Buffer.from satisfies) rather than
// Buffer so the result is assignable to fetch's BodyInit under strict lib types.
export function requestBody(frame: DialoutApiRequest, method: string): Uint8Array<ArrayBuffer> | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (typeof frame.body_b64 === "string") return Buffer.from(frame.body_b64, "base64");
  return Buffer.from(JSON.stringify(frame.body ?? {}), "utf8");
}
