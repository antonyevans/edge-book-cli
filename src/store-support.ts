// Operator support inbox (spec-134, ea-claude-139): storage + lifecycle for
// received `support_bundle` envelopes (`edge-book doctor --send`).
//
// Free functions taking `store` first, like every store-*.ts module — but
// WITHOUT the usual EdgeBookStore delegate methods: edge-book.ts sits at
// 493/500 code lines, so callers (store-trust receive routing, cli-support)
// import these functions directly. Add delegates only after the facade is
// split (follow-up extraction).
//
// Invariants:
//   - FAIL CLOSED: bundles are accepted only when config.support_inbox === true
//     (operator opt-in via `edge-book support inbox --on`). Every other agent
//     rejects stranger bundles outright.
//   - The sender is usually NOT a contact: envelope signature verification
//     bootstraps from the card embedded in the body (same pattern as
//     friend_request), and the card itself must validate + match the sender.
//   - The stored report is the sender's sanitized DoctorReport. Body-level
//     sanitization is the SENDER's guarantee (buildDoctorReport); the inbox
//     stores it as received and never executes anything from it.
//   - Inbound throttle: support receives count against the same per-peer +
//     global inbound rate windows as friend requests (enforceInboundRate).
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { MessageEnvelope, SupportBundleBody, SupportBundleRecord } from "./types.ts";
import { validateCard } from "./cards.ts";
import { now, readJson, writeJson } from "./fs-json.ts";
import { SUPPORT_BUNDLES_FILE } from "./store-files.ts";
import { logEvent } from "./event-log.ts";

// Receiver-owned invariants. The size cap is enforced HERE (not only by the
// sender and the host frame guard): --to <did> lets a sender reach any
// opted-in agent through any relay, so the inbox protects itself.
export const SUPPORT_BUNDLE_MAX_BYTES = 256 * 1024;
// Bounded retention: the whole file is read/rewritten per operation, and
// dismiss never deletes — so cap stored records. Dismissed go first
// (oldest-first), then oldest others; the newest arrival always survives.
export const SUPPORT_BUNDLE_KEEP = 200;

function pruneSupportBundles(all: Record<string, SupportBundleRecord>, keepId: string): Record<string, SupportBundleRecord> {
  const records = Object.values(all);
  if (records.length <= SUPPORT_BUNDLE_KEEP) return all;
  const byAge = (a: SupportBundleRecord, b: SupportBundleRecord) => a.received_at.localeCompare(b.received_at);
  const evictable = [
    ...records.filter((r) => r.status === "dismissed" && r.bundle_id !== keepId).sort(byAge),
    ...records.filter((r) => r.status !== "dismissed" && r.bundle_id !== keepId).sort(byAge),
  ];
  for (const r of evictable) {
    if (Object.keys(all).length <= SUPPORT_BUNDLE_KEEP) break;
    delete all[r.bundle_id];
  }
  return all;
}

export async function supportBundles(store: EdgeBookStore): Promise<Record<string, SupportBundleRecord>> {
  return readJson<Record<string, SupportBundleRecord>>(store.file(SUPPORT_BUNDLES_FILE), {});
}

export async function saveSupportBundles(store: EdgeBookStore, all: Record<string, SupportBundleRecord>): Promise<void> {
  await writeJson(store.file(SUPPORT_BUNDLES_FILE), all);
}

export async function receiveSupportBundle(store: EdgeBookStore, envelope: MessageEnvelope): Promise<SupportBundleRecord> {
  // Opt-in gate FIRST (fail closed, before any verification work): a normal
  // agent must never accumulate stranger bundles.
  if ((await store.config()).support_inbox !== true) {
    throw new EdgeBookError("support_inbox_disabled", "This agent does not accept support bundles (operator opt-in: edge-book support inbox --on)");
  }
  if (envelope.type !== "support_bundle") throw new EdgeBookError("wrong_message_type", "Expected support_bundle envelope");
  // Size cap BEFORE rate/crypto work: oversize must not burn budget or keys.
  const size = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (size > SUPPORT_BUNDLE_MAX_BYTES) {
    throw new EdgeBookError("support_bundle_too_large", `Support bundle is ${size} bytes; the receiver cap is ${SUPPORT_BUNDLE_MAX_BYTES} (256 KiB)`);
  }
  await store.enforceInboundRate(envelope.from_agent_id);
  await store.verifyEnvelope(envelope); // key bootstraps from the embedded card (store-trust)
  const body = envelope.body as unknown as SupportBundleBody;
  if (!body || typeof body !== "object" || !body.report || typeof body.report !== "object") {
    throw new EdgeBookError("bad_support_bundle", "support_bundle envelope carries no report");
  }
  validateCard(body.card);
  if (body.card.agent_id !== envelope.from_agent_id) {
    throw new EdgeBookError("agent_id_mismatch", "Embedded card does not match the envelope sender");
  }
  const record: SupportBundleRecord = {
    bundle_id: envelope.message_id,
    from_agent_id: envelope.from_agent_id,
    ...(body.card.display_name ? { from_display_name: body.card.display_name } : {}),
    ...(envelope.trace_id ? { trace_id: envelope.trace_id } : {}),
    received_at: now(),
    status: "pending",
    report: body.report,
    ...(typeof body.note === "string" && body.note ? { note: body.note } : {}),
  };
  const all = await supportBundles(store);
  all[record.bundle_id] = record;
  await saveSupportBundles(store, pruneSupportBundles(all, record.bundle_id));
  await store.audit("support.receive", envelope.from_agent_id, { bundle_id: record.bundle_id, trace_id: envelope.trace_id ?? "" });
  // Flight recorder (spec-133 discipline): ids/refs only — never the report.
  await logEvent(store, "support.received", { from: envelope.from_agent_id, dedup_key: envelope.message_id, trace_id: envelope.trace_id });
  return record;
}

// Pending bundles, oldest first (the operator works the queue in arrival order).
export async function pendingSupportBundles(store: EdgeBookStore): Promise<SupportBundleRecord[]> {
  const all = await supportBundles(store);
  return Object.values(all)
    .filter((b) => b.status === "pending")
    .sort((a, b) => a.received_at.localeCompare(b.received_at));
}

export async function setSupportBundleStatus(store: EdgeBookStore, bundleId: string, status: "read" | "dismissed"): Promise<SupportBundleRecord> {
  const all = await supportBundles(store);
  const record = all[bundleId];
  if (!record) throw new EdgeBookError("unknown_bundle", `Unknown support bundle: ${bundleId}`);
  record.status = status;
  all[bundleId] = record;
  await saveSupportBundles(store, all);
  return record;
}
