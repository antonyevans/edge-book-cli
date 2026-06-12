// Record-and-replay harness (ea-claude-141, spec-135).
//
// Loads a replay fixture (JSON), materializes its SYNTHETIC sender identities,
// and drives the described envelope sequence through the REAL receive path —
// `mailbox_deliver` frames into an `EdgeBookDialoutClient` over the FakeSocket
// seam (the exact path production envelopes take: handleMailboxDeliver →
// store.receiveEnvelope → verifyEnvelope → type handler → event log + ack).
//
// Invariants:
//   - SYNTHETIC IDENTITIES ONLY (normative, spec-135): fixtures carry ed25519
//     seeds for stand-in identities minted for the fixture. We never have a
//     real user's private key, so captured real-world failures are re-signed
//     by these stand-ins; doctor bundles never contain bodies, so the body is
//     a synthetic reproduction supplied by the operator.
//   - Deterministic: message_id / trace_id / created_at / expires_at come from
//     the fixture; sender keys derive from the fixture seed; no network, no
//     test-controlled randomness. (The one wall-clock dependency is envelope
//     expiry — fixtures pin a far-future expires_at.)
//   - Assertions check BOTH the per-step outcome (applied / dedup / signature)
//     and the recipient's event-log entries, matched by trace_id.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookDialoutClient } from "../../src/dialout.ts";
import { EdgeBookStore } from "../../src/edge-book.ts";
import type { AgentCard, LocalIdentity, MessageEnvelope, RelationshipState } from "../../src/edge-book.ts";
import { readEvents } from "../../src/event-log.ts";
import type { ProtocolEvent } from "../../src/event-log.ts";
import { canonicalize, relationshipId, signPayload, stableIdFromPublicKey } from "../../src/crypto.ts";
import { deliverViaMailboxRecorded } from "../../src/cli-shared.ts";
import { readOutbox } from "../../src/store-outbox.ts";

export const REPLAY_FIXTURE_SCHEMA = "edge-book-replay-fixture/0.2";

const ENVELOPE_TYPES = new Set<MessageEnvelope["type"]>([
  "friend_request", "friend_response", "privileged_message", "ack", "error",
  "object_share", "object_revoke", "post_publish", "profile_share",
  "escalation", "escalation_response", "support_bundle",
]);
const OUTCOMES = new Set(["accepted", "dedup_hit", "signature_failed", "rejected"]);
const LOCAL_ACTIONS = new Set(["accept_friend", "reject_friend", "send_friend_request"]);
// Provenance vocabulary — spec-0044/spec-0045, verbatim. The fixture validator
// is the deterministic in-repo backstop for the standing rule.
const PROVENANCE_ORIGINS = new Set(["real", "synthetic", "synthetic-promoted"]);
const PROVENANCE_SOURCE_TYPES = new Set(["capa", "judge-log", "trace", "incident-note", "manual-craft"]);
// Card-bootstrap envelope kinds: the only ones that carry the sender's card in
// the body, so the only ones where card_expires_at is meaningful.
const CARD_BOOTSTRAP_TYPES = new Set(["friend_request", "friend_response", "support_bundle"]);
// Determinism floor for envelope expiry (spec-135 §B.5): anything between
// "authoring time" and "far future" can flip mid-suite-lifetime.
const EXPIRES_AT_FLOOR = Date.parse("2090-01-01T00:00:00.000Z");

export interface SyntheticIdentitySpec {
  seed: string;          // 64 hex chars (32-byte ed25519 seed) — SYNTHETIC only
  handle: string;
  display_name?: string;
}

export interface ExpectedEvent {
  kind: string;
  trace_id?: string;     // deliver steps default to the step's trace_id
  fields?: Record<string, string | number | boolean>;
}

export interface StepExpect {
  outcome?: "accepted" | "dedup_hit" | "signature_failed" | "rejected";
  error?: string;        // substring of the apply error (rejected outcomes)
  events?: ExpectedEvent[];
  relationship_state?: RelationshipState | "none"; // "none" = no contact may exist
  outbox?: { envelope_type: string; recipient_live?: boolean }; // spec-097 ledger entry
}

export interface DeliverStep {
  deliver: {
    from: string;        // identity ref
    type: MessageEnvelope["type"];
    message_id: string;
    trace_id: string;
    created_at: string;
    expires_at: string;  // pin far-future so replays stay deterministic
    body?: Record<string, unknown>; // synthetic body; card auto-embedded for bootstrap kinds
    tamper?: "signature"; // mutate the payload AFTER signing → signature_failed
    // Override the auto-embedded card's expires_at (card-bootstrap kinds only);
    // the card is re-hashed and re-signed by the synthetic sender, so a PAST
    // value reproduces a stale-but-validly-signed card (spec-096 §C shape).
    card_expires_at?: string;
  };
  expect: StepExpect;
}

export interface LocalStep {
  local: {
    action: "accept_friend" | "reject_friend" | "send_friend_request";
    peer: string;
    // send_friend_request only: liveness the relay reports in mailbox_send_ok
    // (spec-097). false = the June-9 "queued to a DID no channel claims" shape;
    // omitted = pre-receipts host (no recipient_live in the ack).
    recipient_live?: boolean;
  };
  expect?: StepExpect;
}

export interface ProvenanceSpec {
  origin: "real" | "synthetic" | "synthetic-promoted";
  source_type: "capa" | "judge-log" | "trace" | "incident-note" | "manual-craft";
  source_ref?: string;   // required iff origin is real | synthetic-promoted
}

export type ReplayStep = DeliverStep | LocalStep;

export interface ReplayFixture {
  schema: typeof REPLAY_FIXTURE_SCHEMA;
  title: string;
  description?: string;
  // Mandatory provenance (spec-0045 rule 2): where this fixture came from,
  // in spec-0044's controlled vocabulary. Enforced by validateFixture.
  provenance: ProvenanceSpec;
  // Free-form capture context (doctor bundle reference, original trace_id).
  // Informational only — never used to reconstruct real keys.
  source?: { doctor_bundle?: string; trace_id?: string; note?: string };
  identities: Record<string, SyntheticIdentitySpec>;
  recipient?: { handle?: string; display_name?: string; config?: Record<string, unknown> };
  steps: ReplayStep[];
}

export interface ReplayStepResult {
  index: number;
  kind: string;          // envelope type or local action
  outcome: string;
  error?: string;
}

export interface ReplayResult {
  title: string;
  steps: ReplayStepResult[];
  events: ProtocolEvent[]; // recipient event log after the full sequence
}

function fail(name: string, message: string): never {
  throw new Error(`replay fixture ${name}: ${message}`);
}

// spec-0045 rule 2 (vocabulary verbatim from spec-0044): every fixture carries
// provenance; real/synthetic-promoted need a resolvable source_ref and can
// never be manual-craft (a real incident has a source class).
function validateProvenance(raw: unknown, name: string): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(name, "provenance (object with origin/source_type) is required — spec-0045: every fixture is tagged with where it came from");
  }
  const p = raw as Record<string, unknown>;
  if (!PROVENANCE_ORIGINS.has(String(p.origin))) {
    fail(name, `provenance.origin must be one of ${[...PROVENANCE_ORIGINS].join(" | ")} (got ${JSON.stringify(p.origin)})`);
  }
  if (!PROVENANCE_SOURCE_TYPES.has(String(p.source_type))) {
    fail(name, `provenance.source_type must be one of ${[...PROVENANCE_SOURCE_TYPES].join(" | ")} (got ${JSON.stringify(p.source_type)})`);
  }
  const needsRef = p.origin === "real" || p.origin === "synthetic-promoted";
  if (p.source_ref !== undefined && (typeof p.source_ref !== "string" || !p.source_ref)) {
    fail(name, "provenance.source_ref must be a non-empty string when present");
  }
  if (needsRef && typeof p.source_ref !== "string") {
    fail(name, `provenance.source_ref (trace id, doctor-bundle id, or EA task id) is required when origin is "${String(p.origin)}"`);
  }
  if (needsRef && p.source_type === "manual-craft") {
    fail(name, `provenance.source_type "manual-craft" pairs only with origin "synthetic" — a ${String(p.origin)} fixture has a source class (spec-0044 rule 3)`);
  }
}

// Strict structural validation with errors that name the offending field —
// a fixture is hand-edited by an operator, so "bad fixture" must be obvious.
export function validateFixture(raw: unknown, name = "(inline)"): ReplayFixture {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(name, "fixture must be a JSON object");
  const f = raw as Record<string, unknown>;
  if (f.schema !== REPLAY_FIXTURE_SCHEMA) fail(name, `schema must be "${REPLAY_FIXTURE_SCHEMA}" (got ${JSON.stringify(f.schema)})`);
  if (typeof f.title !== "string" || !f.title) fail(name, "title (string) is required");
  validateProvenance(f.provenance, name);
  if (!f.identities || typeof f.identities !== "object" || Array.isArray(f.identities)) fail(name, "identities must be an object map");
  for (const [id, spec] of Object.entries(f.identities as Record<string, unknown>)) {
    const s = spec as Record<string, unknown>;
    if (!s || typeof s !== "object") fail(name, `identities.${id} must be an object`);
    if (typeof s.seed !== "string" || !/^[0-9a-f]{64}$/.test(s.seed)) {
      fail(name, `identities.${id}.seed must be 64 hex chars (32-byte synthetic ed25519 seed)`);
    }
    if (typeof s.handle !== "string" || !s.handle) fail(name, `identities.${id}.handle (string) is required`);
  }
  if (!Array.isArray(f.steps) || f.steps.length === 0) fail(name, "steps must be a non-empty array");
  const identityNames = new Set(Object.keys(f.identities as object));
  (f.steps as unknown[]).forEach((rawStep, i) => {
    const step = rawStep as Record<string, unknown>;
    if (!step || typeof step !== "object") fail(name, `steps[${i}] must be an object`);
    if (step.deliver) {
      const d = step.deliver as Record<string, unknown>;
      if (!identityNames.has(String(d.from))) fail(name, `steps[${i}].deliver.from "${String(d.from)}" is not in identities`);
      if (!ENVELOPE_TYPES.has(d.type as MessageEnvelope["type"])) fail(name, `steps[${i}].deliver.type "${String(d.type)}" is not a known envelope type`);
      for (const field of ["message_id", "trace_id", "created_at", "expires_at"] as const) {
        if (typeof d[field] !== "string" || !d[field]) fail(name, `steps[${i}].deliver.${field} (string) is required`);
      }
      // ea-claude-141 follow-up: timestamps must parse, and expires_at must be
      // pinned far-future — a near-term expiry flips the fixture's outcome the
      // day it passes, which is exactly the flake quarantine exists to prevent.
      for (const field of ["created_at", "expires_at"] as const) {
        if (!Number.isFinite(Date.parse(String(d[field])))) fail(name, `steps[${i}].deliver.${field} "${String(d[field])}" is not a parseable date`);
      }
      if (Date.parse(String(d.expires_at)) < EXPIRES_AT_FLOOR) {
        fail(name, `steps[${i}].deliver.expires_at must be pinned far-future (>= 2090-01-01) so replays stay deterministic — got "${String(d.expires_at)}"`);
      }
      if (d.card_expires_at !== undefined) {
        if (typeof d.card_expires_at !== "string" || !Number.isFinite(Date.parse(d.card_expires_at))) {
          fail(name, `steps[${i}].deliver.card_expires_at must be a parseable date string`);
        }
        if (!CARD_BOOTSTRAP_TYPES.has(String(d.type))) {
          fail(name, `steps[${i}].deliver.card_expires_at only applies to card-bootstrap kinds (${[...CARD_BOOTSTRAP_TYPES].join(" | ")})`);
        }
      }
      if (d.tamper !== undefined && d.tamper !== "signature") fail(name, `steps[${i}].deliver.tamper must be "signature" when present`);
      const expect = step.expect as Record<string, unknown> | undefined;
      if (!expect || typeof expect !== "object") fail(name, `steps[${i}].expect is required for deliver steps`);
      if (typeof expect.outcome !== "string" || !OUTCOMES.has(expect.outcome)) {
        fail(name, `steps[${i}].expect.outcome must be one of ${[...OUTCOMES].join(" | ")}`);
      }
      validateExpectOutbox(expect, name, i);
    } else if (step.local) {
      const l = step.local as Record<string, unknown>;
      if (!LOCAL_ACTIONS.has(String(l.action))) fail(name, `steps[${i}].local.action must be one of ${[...LOCAL_ACTIONS].join(" | ")}`);
      if (!identityNames.has(String(l.peer))) fail(name, `steps[${i}].local.peer "${String(l.peer)}" is not in identities`);
      if (l.recipient_live !== undefined && (typeof l.recipient_live !== "boolean" || l.action !== "send_friend_request")) {
        fail(name, `steps[${i}].local.recipient_live must be a boolean and only applies to send_friend_request`);
      }
      validateExpectOutbox(step.expect as Record<string, unknown> | undefined, name, i);
    } else {
      fail(name, `steps[${i}] must have either "deliver" or "local"`);
    }
  });
  // Fixtures are data, not code (review hardening, PR #15): recipient.config
  // may only carry behavior toggles. notify_cmd is a shell command (notify.ts
  // runs it via sh -c) and must never arrive via a committed fixture.
  const recipient = f.recipient as Record<string, unknown> | undefined;
  if (recipient && recipient.config && typeof recipient.config === "object") {
    const allowed = new Set(["open_friend_requests", "notify_on_friend_request", "support_inbox"]);
    for (const key of Object.keys(recipient.config as Record<string, unknown>)) {
      if (!allowed.has(key)) fail(name, `recipient.config.${key} is not an allowed fixture config key (fixtures are data, not code)`);
    }
  }
  return raw as ReplayFixture;
}

function validateExpectOutbox(expect: Record<string, unknown> | undefined, name: string, i: number): void {
  if (!expect || expect.outbox === undefined) return;
  const o = expect.outbox as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.envelope_type !== "string" || !o.envelope_type) {
    fail(name, `steps[${i}].expect.outbox must be an object with envelope_type (string)`);
  }
  if (o.recipient_live !== undefined && typeof o.recipient_live !== "boolean") {
    fail(name, `steps[${i}].expect.outbox.recipient_live must be a boolean when present`);
  }
}

// Deterministic ed25519 keypair from a 32-byte seed: PKCS8 DER for ed25519 is
// a fixed 16-byte prefix + the raw seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export function keyPairFromSeed(seedHex: string): { public_key_pem: string; private_key_pem: string } {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, "hex")]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

// FakeSocket relay seam (pattern: test/dialout-friend-relay.test.ts) — acks
// hello + mailbox_send, and lets the harness inject mailbox_deliver frames.
export class FakeSocket {
  sent: Record<string, unknown>[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};
  readyState = 1;
  // recipientLive controls the spec-097 receipts field on mailbox_send acks:
  // undefined reproduces a pre-receipts host (field absent from the ack).
  private recipientLive?: boolean;
  constructor(recipientLive?: boolean) { this.recipientLive = recipientLive; }
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.receive({ type: "hello_ok", channel_id: "replay-ch", server_time: new Date().toISOString() }));
    if (frame.type === "mailbox_send") {
      queueMicrotask(() => this.receive({
        type: "mailbox_send_ok", request_id: frame.request_id, id: `replay-relay-${this.sent.length}`,
        ...(this.recipientLive === undefined ? {} : { recipient_live: this.recipientLive }),
      }));
    }
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (event?: unknown) => void): void { (this.listeners[event] ||= []).push(handler); }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

interface MaterializedSender { store: EdgeBookStore; identity: LocalIdentity; }

// Mint a synthetic sender: seed-derived keys imported into a real store so the
// real builders (writeCard) produce valid, verifiable cards for the envelopes.
async function materializeSender(root: string, name: string, spec: SyntheticIdentitySpec): Promise<MaterializedSender> {
  const keys = keyPairFromSeed(spec.seed);
  const stamp = "2026-01-01T00:00:00.000Z"; // fixed — identity content is fixture-determined
  const identity: LocalIdentity = {
    agent_id: stableIdFromPublicKey(keys.public_key_pem),
    handle: spec.handle,
    display_name: spec.display_name ?? `${name} (synthetic)`,
    owner_label: "",
    public_key_pem: keys.public_key_pem,
    private_key_pem: keys.private_key_pem,
    created_at: stamp,
    updated_at: stamp,
  };
  const store = new EdgeBookStore({ home: path.join(root, `sender-${name}`) });
  await store.importIdentity({ identity });
  return { store, identity };
}

// Re-stamp a synthetic card's expires_at and re-hash + re-sign it with the
// synthetic sender key (mirrors buildCard's hash/sign order). Produces a
// STALE but validly-signed card — the June-9 frozen-invite-snapshot shape.
function restampCardExpiry(card: AgentCard, expiresAt: string, privateKeyPem: string): AgentCard {
  const { card_hash: _hash, signature: _sig, ...unsigned } = card;
  const stale = { ...unsigned, expires_at: expiresAt };
  const card_hash = crypto.createHash("sha256").update(canonicalize(stale)).digest("base64url");
  const withHash = { ...stale, card_hash };
  return { ...withHash, signature: signPayload(withHash, privateKeyPem) } as AgentCard;
}

async function buildStepEnvelope(step: DeliverStep, sender: MaterializedSender, recipientId: string): Promise<MessageEnvelope> {
  const d = step.deliver;
  let body: Record<string, unknown> = { ...(d.body ?? {}) };
  // Stranger-bootstrap kinds must carry the sender's card (verifyEnvelope
  // resolves the key from it before any contact exists). Auto-embed the
  // synthetic card; fixtures only supply the human-meaningful body fields.
  if (CARD_BOOTSTRAP_TYPES.has(d.type) && !("card" in body)) {
    let card = await sender.store.writeCard();
    if (d.card_expires_at) card = restampCardExpiry(card, d.card_expires_at, sender.identity.private_key_pem);
    body = { note: "", ...body, card };
  }
  const unsigned: Omit<MessageEnvelope, "signature"> = {
    message_id: d.message_id,
    type: d.type,
    from_agent_id: sender.identity.agent_id,
    to_agent_id: recipientId,
    relationship_id: relationshipId(sender.identity.agent_id, recipientId),
    capability_id: "",
    ref: "",
    transport: "relay",
    created_at: d.created_at,
    expires_at: d.expires_at,
    body,
    trace_id: d.trace_id,
  };
  const envelope: MessageEnvelope = { ...unsigned, signature: signPayload(unsigned, sender.identity.private_key_pem) };
  // Tamper AFTER signing: the payload no longer matches the signature, exactly
  // like a modified-in-transit envelope.
  if (d.tamper === "signature") return { ...envelope, body: { ...envelope.body, tampered_in_transit: true } };
  return envelope;
}

function classifyOutcome(result: { applied: boolean; error?: string }, events: ProtocolEvent[], messageId: string): string {
  if (result.applied) return "accepted";
  const forStep = events.filter((e) => e.dedup_key === messageId);
  if (forStep.some((e) => e.kind === "envelope.dedup_hit")) return "dedup_hit";
  if (forStep.some((e) => e.kind === "envelope.signature_failed")) return "signature_failed";
  return "rejected";
}

function assertExpectedEvents(title: string, index: number, expected: ExpectedEvent[], events: ProtocolEvent[], defaultTraceId?: string): void {
  for (const want of expected) {
    const traceId = want.trace_id ?? defaultTraceId;
    const match = events.find((e) =>
      e.kind === want.kind &&
      (traceId === undefined || e.trace_id === traceId) &&
      Object.entries(want.fields ?? {}).every(([k, v]) => e[k] === v));
    if (!match) {
      const seen = events.map((e) => `${e.kind}${e.trace_id ? `(${String(e.trace_id)})` : ""}`).join(", ") || "(none)";
      throw new Error(`${title} steps[${index}]: expected event kind=${want.kind} trace_id=${String(traceId)} not found in recipient event log; saw: ${seen}`);
    }
  }
}

// Run one fixture end to end. Throws (with fixture title + step index) on the
// first expectation mismatch; resolves with a per-step transcript otherwise.
export async function runReplayFixture(fixture: ReplayFixture): Promise<ReplayResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-replay-"));
  const recipient = new EdgeBookStore({ home: path.join(root, "recipient") });
  await recipient.init({
    handle: fixture.recipient?.handle ?? "replay-user.openclaw.local",
    displayName: fixture.recipient?.display_name ?? "Replay Recipient",
  });
  if (fixture.recipient?.config) await recipient.updateConfig(fixture.recipient.config);
  const recipientId = (await recipient.identity()).agent_id;

  const senders = new Map<string, MaterializedSender>();
  for (const [name, spec] of Object.entries(fixture.identities)) {
    senders.set(name, await materializeSender(root, name, spec));
  }

  // Per-delivery waiter: armed right before each mailbox_deliver so duplicate
  // message_ids (dedup fixtures) resolve their own delivery, not a stale one.
  let waiter: { resolve: (r: { applied: boolean; error?: string }) => void } | undefined;
  let socket: FakeSocket | undefined;
  const client = new EdgeBookDialoutClient({
    home: recipient.home,
    host: "ws://replay.fixture.test/agent",
    socketFactory: (() => { socket = new FakeSocket(); queueMicrotask(() => socket!.emit("open")); return socket!; }) as never,
    openLocalApi: false,
    reconnect: false,
    heartbeatMs: 600_000,
    onEnvelope: (_envelope, result) => { waiter?.resolve(result); },
  });
  await client.start();

  const transcript: ReplayStepResult[] = [];
  try {
    for (const [index, step] of fixture.steps.entries()) {
      if ("deliver" in step && step.deliver) {
        const sender = senders.get(step.deliver.from)!;
        const envelope = await buildStepEnvelope(step, sender, recipientId);
        const applied = new Promise<{ applied: boolean; error?: string }>((resolve) => { waiter = { resolve }; });
        socket!.receive({
          type: "mailbox_deliver",
          id: `replay-host-${index}`,
          from: envelope.from_agent_id,
          blob_b64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
          ts: Date.parse(step.deliver.created_at),
        });
        const result = await applied;
        waiter = undefined;
        const events = await readEvents(recipient);
        const outcome = classifyOutcome(result, events, envelope.message_id);
        transcript.push({ index, kind: step.deliver.type, outcome, ...(result.error ? { error: result.error } : {}) });
        if (step.expect.outcome && outcome !== step.expect.outcome) {
          throw new Error(`${fixture.title} steps[${index}]: expected outcome=${step.expect.outcome}, got ${outcome}${result.error ? ` (${result.error})` : ""}`);
        }
        if (step.expect.error && !(result.error ?? "").includes(step.expect.error)) {
          throw new Error(`${fixture.title} steps[${index}]: expected error containing "${step.expect.error}", got ${JSON.stringify(result.error)}`);
        }
        assertExpectedEvents(fixture.title, index, step.expect.events ?? [], events, step.deliver.trace_id);
        await assertRelationship(fixture.title, index, recipient, sender.identity.agent_id, step.expect.relationship_state);
        await assertOutbox(fixture.title, index, recipient, step.expect.outbox);
      } else if ("local" in step && step.local) {
        const peer = senders.get(step.local.peer)!;
        if (step.local.action === "accept_friend") {
          await recipient.acceptFriend(peer.identity.agent_id);
        } else if (step.local.action === "reject_friend") {
          await recipient.rejectFriend(peer.identity.agent_id);
        } else {
          // send_friend_request: the OUTBOUND half of the production path —
          // createFriendRequest → transient dial-out → mailbox_send → spec-097
          // outbox ledger recording. The fixture controls the relay's
          // recipient_live answer (false = June-9 stale-DID shape).
          const live = step.local.recipient_live;
          await deliverViaMailboxRecorded(
            await recipient.createFriendRequest(await peer.store.writeCard(), "synthetic reproduction"),
            {
              home: recipient.home,
              host: "ws://replay.fixture.test/agent",
              socketFactory: (() => { const s = new FakeSocket(live); queueMicrotask(() => s.emit("open")); return s; }) as never,
            },
            (id) => `legacy ack ${id}`,
          );
        }
        transcript.push({ index, kind: step.local.action, outcome: "applied" });
        const events = await readEvents(recipient);
        assertExpectedEvents(fixture.title, index, step.expect?.events ?? [], events);
        await assertRelationship(fixture.title, index, recipient, peer.identity.agent_id, step.expect?.relationship_state);
        await assertOutbox(fixture.title, index, recipient, step.expect?.outbox);
      }
    }
    return { title: fixture.title, steps: transcript, events: await readEvents(recipient) };
  } finally {
    await client.stop();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertRelationship(title: string, index: number, recipient: EdgeBookStore, peerAgentId: string, expected?: RelationshipState | "none"): Promise<void> {
  if (!expected) return;
  const state = (await recipient.contacts())[peerAgentId]?.relationship_state;
  if (expected === "none") {
    // A rejected envelope must leave no trace: no contact record at all.
    if (state !== undefined) throw new Error(`${title} steps[${index}]: expected NO contact for peer, got relationship_state=${String(state)}`);
    return;
  }
  if (state !== expected) {
    throw new Error(`${title} steps[${index}]: expected relationship_state=${expected} for peer, got ${String(state)}`);
  }
}

async function assertOutbox(title: string, index: number, recipient: EdgeBookStore, expected?: StepExpect["outbox"]): Promise<void> {
  if (!expected) return;
  const entries = await readOutbox(recipient.home);
  const match = entries.find((e) =>
    e.envelope_type === expected.envelope_type &&
    (expected.recipient_live === undefined || e.recipient_live === expected.recipient_live));
  if (!match) {
    const seen = entries.map((e) => `${e.envelope_type}(recipient_live=${String(e.recipient_live)})`).join(", ") || "(empty)";
    throw new Error(`${title} steps[${index}]: expected outbox entry ${JSON.stringify(expected)} not found; ledger: ${seen}`);
  }
}

// Fixture discovery: every *.json in test/replay/fixtures/ runs in npm test
// (test/replay.test.ts iterates this list) — dropping a file in IS the wiring.
export const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");

export async function discoverFixtures(dir = FIXTURES_DIR): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
}

export async function loadFixture(file: string): Promise<ReplayFixture> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`replay fixture ${path.basename(file)}: unreadable or invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateFixture(raw, path.basename(file));
}
