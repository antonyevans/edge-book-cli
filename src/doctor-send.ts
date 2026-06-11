// `edge-book doctor --send` (spec-134, ea-claude-139): consented delivery of
// the sanitized diagnostic bundle to the operator's support mailbox.
//
// Invariants:
//   - the payload is EXACTLY a buildDoctorReport() output (plus the sender's
//     public card and an optional user-typed note), so it inherits the doctor
//     sanitization guarantee — no private keys, no message/post bodies, no
//     notify-command tokens. Never assemble the report any other way.
//   - consent is explicit: the user sees what will be shared (sections,
//     recipient, size) and must confirm interactively; --yes skips for
//     agent-driven runs; a non-interactive run without --yes FAILS CLOSED.
//   - the support recipient is the operator's agent DID, discovered from the
//     relay (GET /support/recipient, backed by the host's SUPPORT_DID env var)
//     or passed explicitly with --to. No recipient → clear failure, no send.
//   - the envelope's trace_id is the support reference: printed to the user,
//     correlatable by the operator via the host's /admin/trace/<id>.
//   - client-side size cap mirrors the host's frame-level cap (256 KiB).
import readline from "node:readline/promises";
import { relayBaseFromHost } from "./cli-shared.ts";
import type { CliResult } from "./cli-shared.ts";
import { deliverEnvelopeViaMailbox } from "./dialout.ts";
import type { DialoutSocket } from "./dialout.ts";
import { buildDoctorReport } from "./doctor.ts";
import type { DoctorReport } from "./doctor.ts";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import type { MessageEnvelope, SupportBundleBody } from "./types.ts";
import { relationshipId } from "./crypto.ts";
import { logEvent } from "./event-log.ts";

// Mirrors the host's SUPPORT_MAX_BLOB_BYTES (edge-book-host src/support.ts).
export const SUPPORT_BUNDLE_MAX_BYTES = 256 * 1024;
// Matches the host mailbox TTL (7 days) so a bundle queued for an offline
// operator still verifies whenever it is delivered.
const SUPPORT_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DoctorSendOptions {
  host: string; // dial-out host url; relay base + mailbox derive from it
  yes: boolean;
  to?: string; // explicit recipient DID (skips relay discovery)
  note?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => DialoutSocket;
  confirmImpl?: (prompt: string) => Promise<boolean>;
}

// Ask the relay who operates its support mailbox. The host fails closed: when
// SUPPORT_DID is unset the route 404s and we report "not configured".
export async function discoverSupportRecipient(relayBase: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${relayBase}/support/recipient`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; did?: string };
    return body.ok && typeof body.did === "string" && body.did ? body.did : null;
  } catch {
    return null; // unreachable relay reads the same as "no recipient configured"
  }
}

// Sign the support_bundle envelope. Exported for the operator-roundtrip tests.
export async function buildSupportBundleEnvelope(store: EdgeBookStore, recipient: string, report: DoctorReport, note?: string): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const card = await store.writeCard();
  const body: SupportBundleBody = {
    card,
    report: report as unknown as Record<string, unknown>,
    ...(note ? { note } : {}),
  };
  const envelope = await store.signEnvelope({
    type: "support_bundle",
    to_agent_id: recipient,
    relationship_id: relationshipId(identity.agent_id, recipient),
    capability_id: "",
    ref: "",
    transport: "local",
    expires_at: new Date(Date.now() + SUPPORT_ENVELOPE_TTL_MS).toISOString(),
    body: body as unknown as Record<string, unknown>,
  });
  const size = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (size > SUPPORT_BUNDLE_MAX_BYTES) {
    throw new EdgeBookError("support_bundle_too_large", `Support bundle is ${size} bytes; the cap is ${SUPPORT_BUNDLE_MAX_BYTES} (256 KiB). Trim the note or report the issue another way.`);
  }
  return envelope;
}

// The consent text shown before anything leaves the machine. Lists every
// section of the bundle and the exact recipient.
export function renderConsentPrompt(report: DoctorReport, recipient: string, sizeBytes: number, note?: string): string {
  const lines = [
    "edge-book doctor --send",
    "",
    "This will share your diagnostic bundle with the operator support mailbox:",
    "",
    `  recipient: ${recipient}`,
    `  size:      ${(sizeBytes / 1024).toFixed(1)} KiB (cap 256 KiB)`,
    "  sections:  identity (fingerprint, handle, display name)",
    "             relay reachability + dial-out state",
    `             friend-request counts + pending requester ids (${report.friends.pending_requests} pending)`,
    "             notification settings (booleans only — never the notify command)",
    "             store counts (contacts/posts/objects/escalations)",
    `             event-log tail (${report.events.length} protocol events: kinds, ids, dedup keys)`,
    `             recent envelope traces (${report.traces.length})`,
    ...(note ? ["", `  your note: "${note}"`] : []),
    "",
    "The bundle is sanitized by construction: no private keys, no message or",
    "post bodies, no tokens. A support reference is printed after sending.",
  ];
  return lines.join("\n");
}

async function promptYesNo(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${promptText}\n\nSend? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function runDoctorSend(store: EdgeBookStore, home: string | undefined, opts: DoctorSendOptions): Promise<CliResult> {
  const report = await buildDoctorReport(store, { host: opts.host, fetchImpl: opts.fetchImpl });
  const recipient = opts.to ?? (await discoverSupportRecipient(relayBaseFromHost(opts.host), opts.fetchImpl ?? fetch));
  if (!recipient) {
    throw new EdgeBookError("no_support_recipient", `No support recipient is configured on this relay (${relayBaseFromHost(opts.host)} — host SUPPORT_DID unset or unreachable). Ask the operator, or pass --to <did>.`);
  }
  const envelope = await buildSupportBundleEnvelope(store, recipient, report, opts.note);
  if (!opts.yes) {
    const promptText = renderConsentPrompt(report, recipient, Buffer.byteLength(JSON.stringify(envelope), "utf8"), opts.note);
    const confirm = opts.confirmImpl ?? (process.stdin.isTTY ? promptYesNo : undefined);
    // Fail closed: a non-interactive run must opt in explicitly.
    if (!confirm) throw new EdgeBookError("confirmation_required", "doctor --send needs interactive confirmation; pass --yes to send without a prompt.");
    if (!(await confirm(promptText))) return { text: "Aborted — nothing was sent." };
  }
  const ack = await deliverEnvelopeViaMailbox({ home, host: opts.host, socketFactory: opts.socketFactory, envelope });
  // Flight recorder: ids/refs only — never the report.
  await logEvent(store, "support.sent", { to: recipient, dedup_key: envelope.message_id, trace_id: envelope.trace_id });
  const text = [
    `Support bundle sent to ${recipient} (host id ${ack.id}).`,
    `support reference: ${envelope.trace_id}`,
    "Quote this reference in any follow-up; the operator correlates it server-side.",
  ].join("\n");
  return { text, json: { recipient, trace_id: envelope.trace_id, host_message_id: ack.id, message_id: envelope.message_id } };
}
