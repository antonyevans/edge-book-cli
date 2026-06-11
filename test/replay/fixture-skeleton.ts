// Doctor-bundle → replay-fixture skeleton extraction (ea-claude-141, spec-135).
//
// Pure logic behind scripts/extract-replay-fixture.ts: given a doctor bundle's
// event log (the `events` array of a DoctorReport, or a received support
// bundle wrapping one) and a trace_id, produce a SKELETON replay fixture.
//
// A skeleton is deliberately incomplete in two ways (both normative):
//   - Bodies are TODO placeholders: doctor bundles never contain message/post
//     bodies (spec-133 sanitization), so the operator supplies a synthetic
//     reproduction body.
//   - Identities are synthetic stand-ins with freshly minted seeds: we never
//     have a user's private key, so replayed envelopes are re-signed by these
//     stand-ins. The original DIDs are kept as provenance notes only.
import crypto from "node:crypto";
import type { ReplayFixture, DeliverStep } from "./replay-harness.ts";
import { REPLAY_FIXTURE_SCHEMA } from "./replay-harness.ts";

export interface BundleEventLike {
  ts: string;
  kind: string;
  [field: string]: string | number | boolean | undefined;
}

export interface SkeletonResult {
  fixture: ReplayFixture;
  notes: string[];
}

const ENVELOPE_TYPES = new Set([
  "friend_request", "friend_response", "privileged_message", "ack", "error",
  "object_share", "object_revoke", "post_publish", "profile_share",
  "escalation", "escalation_response", "support_bundle",
]);

export const TODO_BODY = {
  TODO_synthetic_body: "doctor bundles never contain message bodies — replace with a synthetic reproduction body",
};

// Accept a raw DoctorReport, a support-bundle body ({ report: ... }), or a
// bare { events: [...] } excerpt — wherever the events array lives.
export function eventsFromBundle(bundle: unknown): BundleEventLike[] {
  const b = bundle as Record<string, unknown> | null;
  const candidate = (b?.events ?? (b?.report as Record<string, unknown> | undefined)?.events
    ?? ((b?.body as Record<string, unknown> | undefined)?.report as Record<string, unknown> | undefined)?.events) as unknown;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((e): e is BundleEventLike => !!e && typeof e === "object" && typeof (e as BundleEventLike).kind === "string");
}

function inferOutcome(e: BundleEventLike, companions: BundleEventLike[]): DeliverStep["expect"]["outcome"] {
  if (companions.some((c) => c.kind === "envelope.dedup_hit")) return "dedup_hit";
  if (companions.some((c) => c.kind === "envelope.signature_failed")) return "signature_failed";
  if (e.applied === true) return "accepted";
  return "rejected";
}

export function buildFixtureSkeleton(
  bundle: unknown,
  traceId: string | "all",
  mintSeed: () => string = () => crypto.randomBytes(32).toString("hex"),
): SkeletonResult {
  const events = eventsFromBundle(bundle);
  if (events.length === 0) throw new Error("bundle contains no event log (expected a DoctorReport `events` array)");

  const available = [...new Set(events.map((e) => e.trace_id).filter((t): t is string => typeof t === "string"))];
  const selected = traceId === "all"
    ? events.filter((e) => typeof e.trace_id === "string")
    : events.filter((e) => e.trace_id === traceId);
  if (selected.length === 0) {
    throw new Error(`no events for trace_id "${traceId}" — available trace_ids: ${available.join(", ") || "(none)"}`);
  }

  const notes: string[] = [];
  const identities: ReplayFixture["identities"] = {};
  const senderNames = new Map<string, string>(); // original DID → synthetic name
  const syntheticName = (from: string): string => {
    let name = senderNames.get(from);
    if (!name) {
      name = `synthetic-${senderNames.size + 1}`;
      senderNames.set(from, name);
      identities[name] = { seed: mintSeed(), handle: `${name}.replay.local`, display_name: `${name} (stand-in for ${from})` };
    }
    return name;
  };

  // One deliver step per inbound delivery (envelope.received); dedup/signature
  // events with the same dedup_key refine that step's expected outcome.
  const steps: DeliverStep[] = [];
  const covered = new Set<string>();
  for (const [i, e] of selected.entries()) {
    if (e.kind !== "envelope.received") continue;
    const messageId = typeof e.dedup_key === "string" ? e.dedup_key : `msg-replay-${i + 1}`;
    const companions = selected.filter((c) => c !== e && c.dedup_key === e.dedup_key && (c.kind === "envelope.dedup_hit" || c.kind === "envelope.signature_failed"));
    const envelopeKind = typeof e.envelope_kind === "string" && ENVELOPE_TYPES.has(e.envelope_kind) ? e.envelope_kind : "friend_request";
    if (envelopeKind !== e.envelope_kind) notes.push(`event ${i}: envelope_kind ${JSON.stringify(e.envelope_kind)} is not replayable — defaulted to friend_request, adjust by hand`);
    covered.add(messageId);
    steps.push({
      deliver: {
        from: syntheticName(typeof e.from === "string" ? e.from : "unknown-sender"),
        type: envelopeKind as DeliverStep["deliver"]["type"],
        message_id: messageId,
        trace_id: typeof e.trace_id === "string" ? e.trace_id : `trace-replay-${i + 1}`,
        created_at: e.ts,
        expires_at: "2099-01-01T00:00:00.000Z",
        body: { ...TODO_BODY },
      },
      expect: { outcome: inferOutcome(e, companions) },
    });
  }
  for (const e of selected) {
    if (e.kind === "envelope.sent") notes.push(`outbound event skipped (replay drives inbound only): ${e.kind} ${String(e.dedup_key ?? "")}`);
    else if (e.kind !== "envelope.received" && typeof e.dedup_key === "string" && !covered.has(e.dedup_key)) {
      notes.push(`event ${e.kind} (${e.dedup_key}) has no envelope.received counterpart — add a deliver step by hand if it matters`);
    }
  }
  if (steps.length === 0) throw new Error(`trace "${traceId}" carries no inbound envelope.received events — nothing to replay`);

  const fixture: ReplayFixture = {
    schema: REPLAY_FIXTURE_SCHEMA,
    title: `Extracted replay skeleton — trace ${traceId}`,
    description: "SKELETON: fill in synthetic bodies, rename identities, tighten expectations, then drop into test/replay/fixtures/.",
    source: {
      trace_id: traceId,
      note: "identities are synthetic stand-ins (user private keys are never available); original sender DIDs recorded in display_name",
    },
    identities,
    steps,
  };
  return { fixture, notes };
}
