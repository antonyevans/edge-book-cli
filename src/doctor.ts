// `edge-book doctor` diagnostic bundle (ea-claude-137, spec-133).
//
// Builds a single report covering identity, relay reachability, dial-out
// state, friend requests, notification wiring, store counts, and the
// protocol event-log tail. The CLI renders it as human text by default and
// full JSON with --json.
//
// SAFE TO PASTE PUBLICLY by construction: the report carries public ids
// (agent DIDs, fingerprints, handles), envelope kinds, dedup keys, counts,
// and booleans — never private keys, message/post bodies, or the raw
// notify_cmd string (which may embed channel tokens). The doctor
// sanitization test enforces this.
import fs from "node:fs/promises";
import { relayBaseFromHost } from "./cli-shared.ts";
import { DIALOUT_KEY_FILE } from "./dialout-key.ts";
import { EdgeBookStore } from "./edge-book.ts";
import { lastEvent, readEvents } from "./event-log.ts";
import type { ProtocolEvent } from "./event-log.ts";
import { FRIEND_REQUESTS_CRON_NAME, defaultHermesRunner } from "./host-cron.ts";
import type { HermesRunner } from "./host-cron.ts";

export const DOCTOR_EVENT_TAIL = 50;
export const DOCTOR_TRACE_TAIL = 10;
export const DOCTOR_AUDIT_TAIL = 20;
const DEFAULT_RELAY_TIMEOUT_MS = 3_000;

export interface DoctorRelayCheck {
  url: string;
  reachable: boolean;
  status?: number;
  latency_ms?: number;
  error?: string;
}

export interface DoctorReport {
  version: string;
  generated_at: string;
  home: string;
  // Legacy store-check fields (test/edge-book.test.ts asserts these at top level).
  initialized: boolean;
  pass: boolean;
  card_valid: boolean;
  private_key_mode_ok: boolean;
  files: Record<string, unknown>;
  identity: { fingerprint: string; handle: string; display_name: string } | null;
  relay: DoctorRelayCheck;
  dialout: {
    key_present: boolean;
    last_connected_at?: string;
    last_disconnected_at?: string;
  };
  friends: {
    pending_requests: number;
    pending: Array<{ from: string; display_name?: string }>;
    contacts: number;
    friends: number;
  };
  notify: {
    notify_cmd_configured: boolean;
    notify_on_friend_request: boolean;
    notifier_cron: "installed" | "not_installed" | "host_unsupported" | "error";
  };
  stores: {
    contacts: number;
    friends: number;
    posts: number;
    objects: number;
    escalations: number;
    pending_approvals: number;
  };
  events: ProtocolEvent[]; // newest-last tail (DOCTOR_EVENT_TAIL)
  audit: DoctorAuditEvent[]; // sanitized newest-last tail (DOCTOR_AUDIT_TAIL)
  // Recent envelope traces (ea-claude-138): the newest DOCTOR_TRACE_TAIL
  // DISTINCT trace_ids seen in the event log, newest-last, each with the kind
  // + direction + timestamp of its most recent event. Public ids only.
  traces: DoctorTrace[];
}

export interface DoctorAuditEvent {
  ts: string;
  kind: string;
  actor_agent_id?: string;
  peer_agent_id?: string;
  object_id?: string;
  grant_id?: string;
  grant_ids?: string;
  grant_scope?: string;
}

export interface DoctorTrace {
  trace_id: string;
  kind: string;       // event kind of the newest event carrying this trace
  direction: "out" | "in";
  ts: string;
}

// Compact "recent traces" view: walk newest→oldest, keep the first (newest)
// event per distinct trace_id, cap at DOCTOR_TRACE_TAIL, return newest-last.
export function recentTraces(events: ProtocolEvent[], limit = DOCTOR_TRACE_TAIL): DoctorTrace[] {
  const out: DoctorTrace[] = [];
  const seen = new Set<string>();
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]!;
    const trace_id = typeof e.trace_id === "string" ? e.trace_id : undefined;
    if (!trace_id || seen.has(trace_id)) continue;
    seen.add(trace_id);
    out.push({ trace_id, kind: e.kind, direction: e.kind === "envelope.sent" ? "out" : "in", ts: e.ts });
  }
  return out.reverse();
}

export interface DoctorOptions {
  host: string; // dial-out host url (wss://…/agent/ws); relay base derived from it
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  hermesRunner?: HermesRunner;
}

async function packageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function checkRelay(base: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<DoctorRelayCheck> {
  const started = Date.now();
  try {
    const response = await fetchImpl(base, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    // Any HTTP response — even a 404 — proves the relay host is reachable.
    return { url: base, reachable: true, status: response.status, latency_ms: Date.now() - started };
  } catch (error) {
    return { url: base, reachable: false, latency_ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function notifierCronState(runner: HermesRunner): DoctorReport["notify"]["notifier_cron"] {
  if (!runner.hermesBin) return "host_unsupported";
  try {
    return runner.list().includes(FRIEND_REQUESTS_CRON_NAME) ? "installed" : "not_installed";
  } catch {
    return "error";
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detailString(details: unknown, key: string): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join(",");
  return undefined;
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const found = stringField(value);
    if (found) return found;
  }
  return undefined;
}

function addAuditField(event: DoctorAuditEvent, key: keyof DoctorAuditEvent, value: string | undefined): void {
  if (value) event[key] = value;
}

function auditEvent(event: Record<string, unknown>): DoctorAuditEvent {
  const out: DoctorAuditEvent = {
    ts: firstString(event.created_at, event.ts) ?? "",
    kind: firstString(event.kind, event.action) ?? "unknown",
  };
  addAuditField(out, "actor_agent_id", stringField(event.actor_agent_id));
  addAuditField(out, "peer_agent_id", stringField(event.peer_agent_id));
  addAuditField(out, "object_id", firstString(event.object_id, detailString(event.details, "object_id")));
  addAuditField(out, "grant_id", firstString(event.grant_id, detailString(event.details, "grant_id")));
  addAuditField(out, "grant_ids", firstString(event.grant_ids, detailString(event.details, "grant_ids")));
  addAuditField(out, "grant_scope", firstString(event.grant_scope, detailString(event.details, "scope"), detailString(event.details, "scopes")));
  return out;
}

function auditTail(events: Array<Record<string, unknown>>, limit = DOCTOR_AUDIT_TAIL): DoctorAuditEvent[] {
  return events.slice(-limit).map(auditEvent);
}

export async function buildDoctorReport(store: EdgeBookStore, opts: DoctorOptions): Promise<DoctorReport> {
  // Legacy store check (files, card validity, key-file mode) — keep its
  // top-level fields, but DROP its raw `config` echo: notify_cmd may embed a
  // channel token and the doctor bundle must be safe to paste publicly.
  const legacy = await store.doctor();
  const config = await store.config();

  let identity: DoctorReport["identity"] = null;
  try {
    const id = await store.identity();
    identity = { fingerprint: id.agent_id, handle: id.handle, display_name: id.display_name };
  } catch {
    identity = null; // uninitialized store — report still renders
  }

  const relay = await checkRelay(
    relayBaseFromHost(opts.host),
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS,
  );

  const keyPresent = await fs.stat(store.file(DIALOUT_KEY_FILE)).then(() => true).catch(() => false);
  const lastConnected = await lastEvent(store, "dialout.connected");
  const lastDisconnected = await lastEvent(store, "dialout.disconnected");

  const contacts = await store.contacts();
  const contactList = Object.values(contacts);
  const friendCount = contactList.filter((c) => c.relationship_state === "friend").length;
  const pending = await store.pendingFriendRequests();

  const approvals = await store.approvals();
  const stores: DoctorReport["stores"] = {
    contacts: contactList.length,
    friends: friendCount,
    posts: Object.keys(await store.posts()).length,
    objects: Object.keys(await store.objects()).length,
    escalations: Object.keys(await store.escalations()).length,
    pending_approvals: Object.values(approvals).filter((a) => a.status === "pending").length,
  };

  return {
    version: await packageVersion(),
    generated_at: new Date().toISOString(),
    home: store.home,
    initialized: Boolean(legacy.initialized),
    pass: Boolean(legacy.pass),
    card_valid: Boolean(legacy.card_valid),
    private_key_mode_ok: Boolean(legacy.private_key_mode_ok),
    files: (legacy.files as Record<string, unknown>) ?? {},
    identity,
    relay,
    dialout: {
      key_present: keyPresent,
      ...(typeof lastConnected?.ts === "string" ? { last_connected_at: lastConnected.ts } : {}),
      ...(typeof lastDisconnected?.ts === "string" ? { last_disconnected_at: lastDisconnected.ts } : {}),
    },
    friends: {
      pending_requests: pending.length,
      pending: pending.map((c) => ({ from: c.peer_agent_id, ...(c.display_name ? { display_name: c.display_name } : {}) })),
      contacts: contactList.length,
      friends: friendCount,
    },
    notify: {
      notify_cmd_configured: Boolean(typeof config.notify_cmd === "string" && config.notify_cmd.trim()),
      notify_on_friend_request: config.notify_on_friend_request !== false,
      notifier_cron: notifierCronState(opts.hermesRunner ?? defaultHermesRunner()),
    },
    stores,
    events: await readEvents(store, DOCTOR_EVENT_TAIL),
    audit: auditTail(await store.auditEvents()),
    // Traces are derived from the FULL event log (not just the tail) so a
    // busy log does not hide an older still-relevant trace.
    traces: recentTraces(await readEvents(store)),
  };
}

function renderEventLine(e: ProtocolEvent): string {
  const extras = Object.entries(e)
    .filter(([k]) => k !== "ts" && k !== "kind")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `  ${e.ts}  ${e.kind}${extras ? `  ${extras}` : ""}`;
}

function renderAuditLine(e: DoctorAuditEvent): string {
  const extras = Object.entries(e)
    .filter(([k]) => k !== "ts" && k !== "kind")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `  ${e.ts}  ${e.kind}${extras ? `  ${extras}` : ""}`;
}

function appendTraceSection(lines: string[], traces: DoctorTrace[]): void {
  lines.push(`Recent traces (distinct trace_ids, newest last, up to ${DOCTOR_TRACE_TAIL})`);
  if (traces.length === 0) lines.push("  (no traced envelopes yet)");
  for (const t of traces) lines.push(`  ${t.ts}  ${t.direction === "out" ? "→" : "←"} ${t.kind}  ${t.trace_id}`);
}

function appendEventSection(lines: string[], events: ProtocolEvent[]): void {
  lines.push(`Event log (newest last, up to ${DOCTOR_EVENT_TAIL})`);
  if (events.length === 0) lines.push("  (no events recorded yet)");
  for (const e of events) lines.push(renderEventLine(e));
}

function appendAuditSection(lines: string[], audit: DoctorAuditEvent[]): void {
  lines.push(`Audit log (newest last, up to ${DOCTOR_AUDIT_TAIL})`);
  if (audit.length === 0) lines.push("  (no audit records yet)");
  for (const e of audit) lines.push(renderAuditLine(e));
}

export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Edge Book doctor — v${report.version} (${report.generated_at})`);
  lines.push(`Home: ${report.home}`);
  lines.push(`Overall: ${report.pass ? "PASS" : "FAIL"} (initialized=${report.initialized} card_valid=${report.card_valid} key_mode_ok=${report.private_key_mode_ok})`);
  lines.push("");
  lines.push("Identity");
  if (report.identity) {
    lines.push(`  fingerprint:  ${report.identity.fingerprint}`);
    lines.push(`  handle:       ${report.identity.handle}`);
    lines.push(`  display name: ${report.identity.display_name}`);
  } else {
    lines.push("  not initialized — run: edge-book init");
  }
  lines.push("");
  lines.push("Relay");
  lines.push(`  url:       ${report.relay.url}`);
  lines.push(report.relay.reachable
    ? `  reachable: yes (HTTP ${report.relay.status}, ${report.relay.latency_ms}ms)`
    : `  reachable: NO (${report.relay.error ?? "unreachable"})`);
  lines.push("");
  lines.push("Dial-out");
  lines.push(`  transport key:     ${report.dialout.key_present ? "present" : "missing (never dialed out from this home)"}`);
  lines.push(`  last connected:    ${report.dialout.last_connected_at ?? "never (no connect event recorded)"}`);
  lines.push(`  last disconnected: ${report.dialout.last_disconnected_at ?? "—"}`);
  lines.push("");
  lines.push("Friend requests");
  lines.push(`  pending: ${report.friends.pending_requests}`);
  for (const p of report.friends.pending) lines.push(`    - ${p.display_name ?? "(no name)"} (${p.from})`);
  lines.push("");
  lines.push("Notifications");
  lines.push(`  notify_cmd configured:    ${report.notify.notify_cmd_configured ? "yes" : "no"}`);
  lines.push(`  notify on friend request: ${report.notify.notify_on_friend_request ? "yes" : "no"}`);
  lines.push(`  notifier cron:            ${report.notify.notifier_cron}`);
  lines.push("");
  lines.push("Stores");
  lines.push(`  contacts: ${report.stores.contacts} (friends: ${report.stores.friends})`);
  lines.push(`  posts: ${report.stores.posts}  objects: ${report.stores.objects}  escalations: ${report.stores.escalations}  pending approvals: ${report.stores.pending_approvals}`);
  lines.push("");
  appendTraceSection(lines, report.traces);
  lines.push("");
  appendEventSection(lines, report.events);
  lines.push("");
  appendAuditSection(lines, report.audit);
  return lines.join("\n");
}
