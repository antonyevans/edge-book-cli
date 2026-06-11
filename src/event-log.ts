// Protocol event log — the flight recorder (ea-claude-137, spec-133).
//
// Append-only NDJSON ring buffer at <home>/events.ndjson recording protocol
// touchpoints (dial-out lifecycle, envelopes, notifications, friend-graph
// transitions, cron installs) so `edge-book doctor` can show what actually
// happened without ssh-ing into anything.
//
// Invariants:
//   - logEvent NEVER throws: event logging must never break the protocol
//     path it observes. All failures are swallowed.
//   - Sanitized BY CONSTRUCTION: call sites log ids, fingerprints, envelope
//     kinds, and dedup keys — never message/post bodies, private keys, or
//     tokens. The field type (string|number|boolean) discourages dumping
//     whole objects; the doctor sanitization test enforces the outcome.
//   - Deterministic cap: when the file exceeds MAX_EVENT_LINES lines it is
//     rewritten (atomic temp+rename) keeping only the newest
//     COMPACT_KEEP_LINES, so the file never grows unbounded.
//   - trace_id is reserved for cross-agent correlation (follow-up task);
//     nothing sets it yet.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EVENTS_FILE } from "./store-files.ts";

export const MAX_EVENT_LINES = 2000;
export const COMPACT_KEEP_LINES = 1000;

export type EventField = string | number | boolean | undefined;

export interface ProtocolEvent {
  ts: string;   // ISO timestamp
  kind: string; // dotted event kind, e.g. "dialout.connected", "envelope.sent"
  trace_id?: string; // reserved — cross-agent trace correlation (follow-up)
  [field: string]: EventField;
}

// Minimal seam: anything with a file() resolver (EdgeBookStore qualifies).
export interface EventLogHome {
  file(name: string): string;
}

export interface EventLogCaps {
  maxLines?: number;  // default MAX_EVENT_LINES
  keepLines?: number; // default COMPACT_KEEP_LINES
}

// Append one event. Never throws (see module invariants).
export async function logEvent(
  store: EventLogHome,
  kind: string,
  fields: Record<string, EventField> = {},
  caps: EventLogCaps = {},
): Promise<void> {
  try {
    const event: ProtocolEvent = { ts: new Date().toISOString(), kind, ...fields };
    const file = store.file(EVENTS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
    await compactIfNeeded(file, caps.maxLines ?? MAX_EVENT_LINES, caps.keepLines ?? COMPACT_KEEP_LINES);
  } catch {
    // Event logging must never break the protocol path.
  }
}

// Ring-buffer compaction: over maxLines → atomically rewrite the newest
// keepLines (temp + rename, same discipline as fs-json writeJson so a
// concurrent reader never observes a truncated file).
async function compactIfNeeded(file: string, maxLines: number, keepLines: number): Promise<void> {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length <= maxLines) return;
  const kept = lines.slice(-keepLines);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error; // caught (and swallowed) by logEvent
  }
}

// Read events oldest→newest, tolerating corrupt/partial lines (skipped, same
// policy as fs-json readJsonl). `limit` keeps only the newest N.
export async function readEvents(store: EventLogHome, limit?: number): Promise<ProtocolEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(store.file(EVENTS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return []; // a broken read must not break the caller (doctor)
  }
  const out: ProtocolEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ProtocolEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") out.push(parsed);
    } catch {
      // corrupt/partial line — skip
    }
  }
  return limit !== undefined && out.length > limit ? out.slice(-limit) : out;
}

// Newest event of a given kind (or matching prefix when kind ends with "."),
// for doctor's "last connect" style summaries.
export async function lastEvent(store: EventLogHome, kind: string): Promise<ProtocolEvent | undefined> {
  const events = await readEvents(store);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (kind.endsWith(".") ? e.kind.startsWith(kind) : e.kind === kind) return e;
  }
  return undefined;
}
