// Outbox ledger (spec-097): every successful --deliver records the host-assigned
// mailbox message id here so `edge-book outbox` can ask the host for per-message
// delivery state later — today the id is printed and lost. A JSON ARRAY
// (insertion-ordered; deliberately NOT the keyed-object house pattern, because
// cap eviction needs order), capped at OUTBOX_CAP by dropping the front.
import path from "node:path";
import { now, readJson, resolveHome, writeJson } from "./fs-json.ts";
import { OUTBOX_FILE } from "./store-files.ts";

export const OUTBOX_CAP = 200;
const DEFAULT_STALE_QUEUE_MS = 10 * 60 * 1000;

export interface OutboxEntry {
  /** Host-assigned mailbox message id (from mailbox_send_ok). */
  id: string;
  to_agent_id: string;
  envelope_type: string;
  /** ISO timestamp of the local send. */
  sent_at: string;
  /** Liveness answer from the send ack; absent against a pre-receipts host. */
  recipient_live?: boolean;
}

function outboxPath(home?: string): string {
  return path.join(resolveHome(home), OUTBOX_FILE);
}

export async function readOutbox(home?: string): Promise<OutboxEntry[]> {
  return readJson<OutboxEntry[]>(outboxPath(home), []);
}

// Append one entry, evicting from the FRONT beyond OUTBOX_CAP (oldest first).
export async function recordOutboxEntry(home: string | undefined, entry: Omit<OutboxEntry, "sent_at"> & { sent_at?: string }): Promise<void> {
  const entries = await readOutbox(home);
  entries.push({ sent_at: now(), ...entry });
  await writeJson(outboxPath(home), entries.slice(-OUTBOX_CAP));
}

// A message still `queued` past this threshold gets the loud stale warning
// (spec-097 §C.3 — the June 9 diagnosis, automated). Env-tunable.
export function staleQueueMs(): number {
  const raw = Number(process.env.EDGE_BOOK_STALE_QUEUE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_QUEUE_MS;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
