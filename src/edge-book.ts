import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RelationshipState =
  | "none"
  | "request_sent"
  | "request_received"
  | "friend"
  | "rejected"
  | "revoked"
  | "blocked";

export type TransportMode = "direct" | "relay" | "local";

export interface EdgeBookOptions {
  home?: string;
}

export interface EdgeBookConfig {
  direct_url?: string;
  relay_url?: string;
  // Default ON (treat undefined as true). When false, pendingFriendRequests()
  // returns [] so the notifier cron stays silent.
  notify_on_friend_request?: boolean;
}

export interface LocalIdentity {
  agent_id: string;
  handle: string;
  display_name: string;
  owner_label: string;
  // Opt-in (default off): when true, the human owner_label rides the published
  // Agent Card so contacts can see it. Off = the agent acts as a privacy buffer
  // and contacts only ever see the agent's display_name.
  share_owner_label?: boolean;
  // Two-tier profile. Absent on legacy identities (migrated on read via
  // defaultProfile()). owner_label/share_owner_label remain for migration only.
  profile?: IdentityProfile;
  public_key_pem: string;
  private_key_pem: string;
  created_at: string;
  updated_at: string;
}

export type FieldVisibility = "friends" | "public" | "off";

export interface SocialLink {
  label: string; // open vocabulary: telegram | twitter | linkedin | facebook | github | website | ...
  value: string; // handle or URL
}

export interface IdentityProfile {
  name?: string;
  bio?: string;
  location?: string;
  socials?: SocialLink[];
  // Per-field visibility. Field keys: "name" | "bio" | "location" and per-social
  // by its label, plus "*" as the socials default. Absent => "friends".
  // Reserved field names (name/bio/location) must not be used as social labels.
  visibility?: Record<string, FieldVisibility>;
  // Bumped on every edit; receivers apply the newest profile (last-writer-wins).
  profile_version?: number;
}

// A friend-only, separately-signed profile payload. Shared only between confirmed
// friends (never on the public card / friend_request).
export interface FriendProfile {
  schema: "openclaw-friend-profile/0.1";
  agent_id: string; // MUST equal the sharer's card agent_id
  profile_version: number;
  name?: string;
  bio?: string;
  location?: string;
  socials?: SocialLink[];
  issued_at: string;
  signature: string; // ed25519 over withoutSignature(profile)
}

export interface AgentCard {
  schema: "openclaw-agent-card/0.1";
  agent_id: string;
  handle: string;
  display_name: string;
  // Present only when the owner opted in to sharing (share_owner_label). Absent
  // cards mean "agent name only" — the default.
  owner_label?: string;
  // Profile fields the owner promoted to public visibility (rides the card).
  // name is ALSO mirrored to owner_label above for back-compat with older readers.
  public_profile?: { name?: string; bio?: string; location?: string; socials?: SocialLink[] };
  card_url: string;
  card_version: number;
  card_hash: string;
  public_keys: Array<{ id: string; type: "ed25519"; public_key_pem: string }>;
  capabilities: string[];
  // spec-0021 R3: the agent's structured Capability Advertisements, carried on the
  // card so contacts can discover them. Public by design. Absent on older cards.
  advertised_capabilities?: Array<{ name: string; version: string; summary: string; status: "active" | "deprecated" }>;
  transports: Array<{ mode: TransportMode; endpoint: string }>;
  refresh_after: string;
  expires_at: string;
  signature: string;
}

export interface AgentContactRecord {
  peer_agent_id: string;
  aliases: string[];
  display_name: string;
  // The peer's human owner name, if their card shared it (opt-in on their side).
  owner_label?: string;
  // The latest FriendProfile this peer shared with us (only present once friends).
  friend_profile?: FriendProfile;
  // ISO timestamp the human was last notified of this inbound request ("" = not
  // yet notified). Drives friend-request notification dedup.
  notified_at?: string;
  // The peer's advertised capabilities (from their card; absent if none / older card).
  advertised_capabilities?: Array<{ name: string; version: string; summary: string; status: "active" | "deprecated" }>;
  card_url: string;
  known_endpoints: Array<{ mode: TransportMode; endpoint: string }>;
  public_keys: Array<{ id: string; type: "ed25519"; public_key_pem: string }>;
  relationship_state: RelationshipState;
  capability_grants: string[];
  last_card_hash: string;
  last_card_version: number;
  last_card_refresh_at: string;
  last_successful_delivery_at: string;
  audit_refs: string[];
  created_at: string;
  updated_at: string;
}

export interface RelationshipEvent {
  event_id: string;
  type: "FriendRequest" | "Accept" | "Reject" | "Revoke" | "Block" | "Unblock" | "CardRefresh";
  from_agent_id: string;
  to_agent_id: string;
  relationship_id: string;
  previous_state: RelationshipState | "";
  next_state: RelationshipState;
  human_approval_ref: string;
  reason: string;
  created_at: string;
  signature: string;
}

export interface CapabilityGrant {
  grant_id: string;
  issuer_agent_id: string;
  subject_agent_id: string;
  relationship_id: string;
  scopes: string[];
  status: "active" | "revoked" | "expired";
  issued_at: string;
  expires_at: string;
  revoked_at: string;
  audit_refs: string[];
  signature: string;
  // Edge Book MVP (spec-0020 R3): an `object.read` grant binds to exactly one
  // shared object. Absent for the legacy relationship-wide scopes.
  object_id?: string;
}

// Edge Book MVP shared object (spec-0020 R2). ONE type ("request"), at most ONE
// attachment, gated by ONE `object.read` grant. NO status/state/verification/
// payment field — that execution lane is Shodai's (R4).
export interface SharedObjectAttachment {
  filename: string;
  mime: string;
  size: number;
  ref: string; // local content ref (a file under attachments/), agent-held
}

export interface SharedObject {
  object_id: string;
  type: "request";
  from_agent: string;
  request: { title: string; body: string };
  attachment?: SharedObjectAttachment;
  created_at: string;
  signature: string;
}

export interface ObjectShareBody {
  object: SharedObject;
  grant: CapabilityGrant;
  attachment_b64?: string; // inline attachment bytes for delivery (recipient stores locally)
}

// ─── spec-0021 post-type interfaces ─────────────────────────────────────────

export interface ResultAttestation {
  attestation_id: string;           // == contentHash(content); the proof (R6)
  post_type: "result_attestation";
  schema: "edge-book/result-attestation/0.1";
  attestor_agent_id: string;
  subject_agent_id: string;
  task_ref: string;
  outcome: "success" | "failure" | "partial";
  summary: string;
  evidence: Record<string, unknown>;
  created_at: string;               // part of the addressed content; immutable
  signature: string;                // over { ...content, attestation_id }
}

export interface StrongRef { uri: string; hash: string; } // AT Protocol-style reified ref

export interface Endorsement {
  endorse_id: string;
  post_type: "endorse";
  schema: "edge-book/endorse/0.1";
  endorser_agent_id: string;        // actor-owned: always self (R5)
  subject_agent_id: string;
  parent: StrongRef;                // strongRef to the endorsed object (R5)
  evidence_ref?: StrongRef;         // R8: link to a Result Attestation
  evidence_task_id?: string;        // R8: or a task id + outcome
  statement: string;
  created_at: string;
  signature: string;
}

export interface Signal {
  signal_id: string;
  post_type: "signal";
  schema: "edge-book/signal/0.1";
  from_agent: string;
  body: string;
  lifecycle: "active" | "stale" | "expired";  // R4
  created_at: string;
  expires_at: string;                          // soft TTL -> stale (R4)
  signature: string;
}

export type EphemeralType = "query" | "share" | "coordinate" | "delegation_request";

export interface EphemeralPost {
  post_id: string;
  post_type: EphemeralType;
  schema: "edge-book/ephemeral/0.1";
  from_agent: string;
  body: string;
  subject_agent_id?: string;   // delegation_request target / coordinate counterpart
  ref?: string;                // share reference
  lifecycle: "active" | "stale" | "expired" | "cancelled" | "tombstoned";
  created_at: string;
  expires_at: string;
  signature: string;
}

// Per-type TTL policy: hard => past-expiry is terminal "expired"; soft => "stale".
export const EPHEMERAL_TTL_POLICY: Record<EphemeralType, { hard: boolean }> = {
  query: { hard: true },
  delegation_request: { hard: true },
  share: { hard: false },
  coordinate: { hard: false },
};

export interface Answer {
  answer_id: string;
  post_type: "answer";
  schema: "edge-book/answer/0.1";
  answerer_agent_id: string;   // actor-owned (R5)
  parent: StrongRef;           // strongRef to the parent Query (R5)
  body: string;
  lifecycle: "active" | "tombstoned";
  created_at: string;
  signature: string;
}

// Received posts (from friends) — stored separately; never mutated by lifecycle/deregister.
export type ReceivedPost = Signal | EphemeralPost | Answer | Endorsement;

export interface CapabilityAdvertisement {
  capability_id: string;
  post_type: "capability_advertisement";
  schema: "edge-book/capability/0.1";
  agent_id: string;
  name: string;
  version: string;                   // semantic version (R3)
  summary: string;
  status: "active" | "deprecated";   // deprecate, never hard-delete (R3)
  created_at: string;
  updated_at: string;
  signature: string;
}

export interface ObjectRevokeBody {
  object_id: string;
  grant_id: string;
}

export interface MessageEnvelope {
  message_id: string;
  type: "friend_request" | "friend_response" | "privileged_message" | "ack" | "error" | "object_share" | "object_revoke" | "post_publish" | "profile_share" | "escalation" | "escalation_response";
  from_agent_id: string;
  to_agent_id: string;
  relationship_id: string;
  capability_id: string;
  ref: string;
  transport: TransportMode;
  created_at: string;
  expires_at: string;
  body: Record<string, unknown>;
  signature: string;
}

export interface FriendRequestBody {
  card: AgentCard;
  note: string;
}

export interface FriendResponseBody {
  accepted: boolean;
  card: AgentCard;
  grant?: CapabilityGrant;
  profile?: FriendProfile; // accepter's friend profile (only when accepted)
  reason: string;
}

export interface ProfileShareBody {
  profile: FriendProfile;
}

export type EdgeBookVisibility = "private" | "friends" | "public_if_enabled";
export type EdgeBookPostStatus = "draft" | "pending_approval" | "published" | "edited" | "removed" | "expired";
export type EdgeBookPostKind = "activity" | "working_on" | "help_request" | "offer" | "context" | "note";

export interface LocalUserSession {
  session_id: string;
  owner_agent_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  auth_method: "local-owner-token" | "dev-bypass" | "future-remote-auth";
  csrf_token_hash: string;
  revoked_at: string;
}

export interface EdgeBookPost {
  post_id: string;
  author_agent_id: string;
  human_owner_id: string;
  kind: EdgeBookPostKind;
  title: string;
  body: string;
  tags: string[];
  visibility: EdgeBookVisibility;
  source_basis: "human-authored" | "agent-authored" | "human-approved" | "imported";
  status: EdgeBookPostStatus;
  created_at: string;
  updated_at: string;
  published_at: string;
  expires_at: string;
  approval_ref: string;
  permissions_used: string[];
  audit_refs: string[];
  reply_or_help_channel: string;
}

export interface FeedItem {
  feed_item_id: string;
  post_id: string;
  origin_agent_id: string;
  origin_home: "local" | "direct" | "relay" | "imported";
  relationship_id: string;
  visibility_checked_at: string;
  delivery_route: "local" | "direct" | "relay";
  read_state: "unread" | "read";
  hidden: boolean;
  muted_reason: string;
  received_at: string;
  audit_refs: string[];
}

export interface ApprovalRequest {
  approval_id: string;
  type: "friend_accept" | "grant_scope" | "publish_post" | "edit_post" | "remove_post" | "enable_relay" | "publish_remote" | "send_private_context";
  requested_by_agent_id: string;
  object_type: "contact" | "grant" | "post" | "message" | "config";
  object_id: string;
  summary: string;
  risk_level: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  resolved_at: string;
  resolved_by: "local-owner" | "";
  audit_refs: string[];
}

// Agent → human escalation (ea-claude-094). A free-form ask raised by an agent
// (local: its own owner; remote: a friend's owner, gated by an escalation.raise
// grant) that surfaces in the human's reader and whose answer routes back to the
// requesting agent. Sibling to ApprovalRequest — approvals are gate decisions on
// the local agent's own actions; an escalation carries a question and an answer
// payload and may originate from a remote collaborating agent.
export type EscalationKind = "question" | "decision" | "approval" | "input";
export type EscalationStatus = "pending" | "answered" | "expired" | "cancelled";

export interface Escalation {
  escalation_id: string;
  raised_by_agent_id: string;        // the requesting agent
  collaborators: string[];           // other agent_ids working the task (multi-agent)
  to_human_owner_id: string;         // owner of the agent whose human is being asked
  kind: EscalationKind;
  subject: string;
  body: string;
  options: string[];                 // for decision/approval — the human picks one
  context_refs: string[];            // post_ids / object_ids / audit_refs to inspect
  status: EscalationStatus;
  risk_level: "low" | "medium" | "high";
  created_at: string;
  expires_at: string;
  answer_text: string;               // "" until answered
  answer_choice: string;             // "" or one of options[]
  answered_at: string;
  answered_by: "local-owner" | "";
  audit_refs: string[];
}

// Envelope body for a remote escalation (carries the full record so the receiver
// can materialise an identical copy keyed by the same escalation_id).
export interface EscalationBody {
  escalation: Escalation;
}

// Envelope body routing a resolved escalation back to the requesting agent.
export interface EscalationResponseBody {
  escalation_id: string;
  status: EscalationStatus;
  answer_text: string;
  answer_choice: string;
  answered_at: string;
}

export interface ContactMute {
  peer_agent_id: string;
  muted_at: string;
  muted_reason: string;
  audit_refs: string[];
}

export class EdgeBookError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeBookError";
    this.code = code;
  }
}

const IDENTITY_FILE = "identity.json";
const CONTACTS_FILE = "contacts.json";
const GRANTS_FILE = "grants.json";
const OBJECTS_FILE = "objects.json";
const ATTACHMENTS_DIR = "attachments";
const SEEN_MESSAGES_FILE = "seen-messages.json";
const CONFIG_FILE = "config.json";
const RELATIONSHIP_EVENTS_FILE = "relationship-events.jsonl";
const MESSAGES_FILE = "messages.jsonl";
const AUDIT_FILE = "audit.jsonl";
const INBOX_FILE = "inbox.jsonl";
const CARD_FILE = "openclaw-agent.json";
const SESSIONS_FILE = "web-sessions.json";
const POSTS_FILE = "posts.json";
const FEED_FILE = "feed-items.json";
const APPROVALS_FILE = "approvals.json";
const ESCALATIONS_FILE = "escalations.json";
const CONTACT_MUTES_FILE = "contact-mutes.json";

// spec-0021 new post-type storage files
const ATTESTATIONS_FILE = "attestations.json";
const ENDORSEMENTS_FILE = "endorsements.json";
const SIGNALS_FILE = "signals.json";
const CAPABILITIES_FILE = "capabilities.json";
const EPHEMERAL_FILE = "ephemeral-posts.json";
const ANSWERS_FILE = "answers.json";
const RECEIVED_POSTS_FILE = "received-posts.json";

const DEFAULT_SIGNAL_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;

export function resolveHome(home?: string): string {
  if (home?.trim()) return path.resolve(home.trim());
  if (process.env.EDGE_BOOK_HOME?.trim()) return path.resolve(process.env.EDGE_BOOK_HOME.trim());
  return path.join(os.homedir(), ".openclaw", "edge-book");
}

function now(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

function stableIdFromPublicKey(publicKeyPem: string): string {
  const digest = crypto.createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 32);
  return `did:openclaw:${digest}`;
}

// Content address: sha256 over the canonical (key-sorted) JSON, base64url.
export function contentHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("base64url");
}

// spec-0021 closed taxonomy: the 10 post types -> their fixed structural class.
export type PostType =
  | "signal" | "query" | "answer" | "share" | "endorse" | "coordinate"
  | "capability_advertisement" | "delegation_request" | "result_attestation" | "transaction";

export const POST_TAXONOMY: Record<PostType, 1 | 2 | 3 | 4> = {
  capability_advertisement: 1,
  signal: 2, query: 2, share: 2, coordinate: 2, delegation_request: 2,
  answer: 3, endorse: 3,
  result_attestation: 4,
  transaction: 3, // relational pre-settlement; settles to 4 (R-table hybrid)
};

export function classOf(type: PostType): 1 | 2 | 3 | 4 {
  const c = POST_TAXONOMY[type];
  if (!c) throw new EdgeBookError("unknown_post_type", `Not in closed taxonomy: ${type}`);
  return c;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(",")}}`;
}

function withoutSignature<T extends { signature?: string }>(value: T): Omit<T, "signature"> {
  const clone = { ...value };
  delete clone.signature;
  return clone;
}

function signPayload(payload: unknown, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(canonicalize(payload)), privateKeyPem).toString("base64url");
}

function verifyPayload(payload: unknown, signature: string, publicKeyPem: string): boolean {
  return crypto.verify(null, Buffer.from(canonicalize(payload)), publicKeyPem, Buffer.from(signature, "base64url"));
}

async function ensureHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  await chmodBestEffort(home, 0o700);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    // Belt-and-suspenders: a read that raced a (now atomic) write could, on some
    // filesystems, briefly observe a partial file. Retry once before failing.
    if (error instanceof SyntaxError) {
      try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { /* fall through */ }
    }
    throw error;
  }
}

async function chmodBestEffort(file: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(file, mode);
  } catch {
    // Non-POSIX filesystems may not support chmod; doctor reports this separately.
  }
}

export async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic write: a concurrent reader (the host proxies many /api/* calls at
  // once) must never observe a half-written file. Write a unique temp then
  // rename — rename is atomic on POSIX, so readers see the old or new file whole,
  // never a truncation ("Unexpected end of JSON input"). Unique suffix avoids two
  // concurrent writers clobbering the same temp.
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (mode !== undefined) await chmodBestEffort(tmp, mode);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendJsonl(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    const out: T[] = [];
    for (const line of text.split(/\n/)) {
      if (!line) continue;
      // Tolerate a partial trailing line from a concurrent append — skip it
      // rather than failing the whole read.
      try { out.push(JSON.parse(line) as T); } catch { /* partial/corrupt line */ }
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function relationshipId(a: string, b: string): string {
  return `rel_${crypto.createHash("sha256").update([a, b].sort().join("|")).digest("base64url").slice(0, 24)}`;
}

// Resolve the effective profile for an identity, migrating legacy
// owner_label/share_owner_label when identity.profile is absent. Pure: callers
// persist the result via setProfile when the user next edits (no write-on-read).
export function defaultProfile(identity: LocalIdentity): IdentityProfile {
  if (identity.profile) return identity.profile;
  const visibility: Record<string, FieldVisibility> = {
    // Migration (apply-new-default-to-all): legacy share on => name public;
    // legacy share off/absent => name resolves to the new default "friends".
    name: identity.share_owner_label ? "public" : "friends",
  };
  return {
    name: identity.owner_label || undefined,
    visibility,
    profile_version: 1,
  };
}

export function resolveFieldVisibility(profile: IdentityProfile, field: string): FieldVisibility {
  return profile.visibility?.[field] ?? "friends";
}

export function resolveSocialVisibility(profile: IdentityProfile, label: string): FieldVisibility {
  return profile.visibility?.[label] ?? profile.visibility?.["*"] ?? "friends";
}

// Shared Class-2 lifecycle: terminal states are preserved; otherwise past-expiry
// becomes "expired" for hard-TTL types or "stale" for soft ones.
export function computeLifecycle(
  expiresAt: string,
  hard: boolean,
  current: string,
): "active" | "stale" | "expired" | "cancelled" | "tombstoned" {
  if (current === "expired" || current === "cancelled" || current === "tombstoned") {
    return current as "expired" | "cancelled" | "tombstoned";
  }
  if (Date.parse(expiresAt) <= Date.now()) return hard ? "expired" : "stale";
  return "active";
}

export class EdgeBookStore {
  home: string;

  constructor(options: EdgeBookOptions = {}) {
    this.home = resolveHome(options.home);
  }

  file(name: string): string {
    return path.join(this.home, name);
  }

  async init(input: { handle?: string; displayName?: string; ownerLabel?: string; shareOwnerLabel?: boolean; cardUrl?: string; directUrl?: string; relayUrl?: string } = {}): Promise<LocalIdentity> {
    await ensureHome(this.home);
    const existing = await readJson<LocalIdentity | null>(this.file(IDENTITY_FILE), null);
    if (existing) {
      await this.updateConfig({ direct_url: input.directUrl, relay_url: input.relayUrl });
      return existing;
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const public_key_pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const private_key_pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const identity: LocalIdentity = {
      agent_id: stableIdFromPublicKey(public_key_pem),
      handle: input.handle || "agent.openclaw.local",
      display_name: input.displayName || "OpenClaw Agent",
      owner_label: input.ownerLabel || "",
      ...(input.shareOwnerLabel ? { share_owner_label: true } : {}),
      public_key_pem,
      private_key_pem,
      created_at: now(),
      updated_at: now()
    };
    await writeJson(this.file(IDENTITY_FILE), identity, 0o600);
    await writeJson(this.file(CONTACTS_FILE), {});
    await writeJson(this.file(GRANTS_FILE), {});
    await writeJson(this.file(SEEN_MESSAGES_FILE), []);
    await this.updateConfig({ direct_url: input.directUrl, relay_url: input.relayUrl });
    await this.audit("identity.init", identity.agent_id, { handle: identity.handle });
    await this.writeCard(input.cardUrl);
    return identity;
  }

  async identity(): Promise<LocalIdentity> {
    const identity = await readJson<LocalIdentity | null>(this.file(IDENTITY_FILE), null);
    if (!identity) throw new EdgeBookError("not_initialized", `Edge Book is not initialized at ${this.home}`);
    return identity;
  }

  // Update profile fields on an existing identity without rotating keys, so the
  // agent_id survives. display_name is the agent's own name (public, on the card).
  // name/bio/location/socials are the human profile, governed by per-field
  // visibility (default "friends"). Legacy ownerLabel/shareOwnerLabel map onto
  // profile.name + visibility.name for back-compat.
  async setProfile(input: {
    displayName?: string;
    ownerLabel?: string;
    shareOwnerLabel?: boolean;
    name?: string;
    bio?: string;
    location?: string;
    socials?: SocialLink[];
    visibility?: Record<string, FieldVisibility>;
  }): Promise<LocalIdentity> {
    const identity = await this.identity();
    const profile: IdentityProfile = { ...defaultProfile(identity) };
    profile.visibility = { ...(profile.visibility ?? {}) };

    if (input.displayName !== undefined && input.displayName !== "") identity.display_name = input.displayName;

    // Legacy shims: ownerLabel -> profile.name; shareOwnerLabel -> name visibility.
    if (input.ownerLabel !== undefined) {
      identity.owner_label = input.ownerLabel;
      profile.name = input.ownerLabel || undefined;
    }
    if (input.shareOwnerLabel !== undefined) {
      identity.share_owner_label = input.shareOwnerLabel;
      profile.visibility.name = input.shareOwnerLabel ? "public" : "friends";
    }

    if (input.name !== undefined) profile.name = input.name || undefined;
    if (input.bio !== undefined) profile.bio = input.bio || undefined;
    if (input.location !== undefined) profile.location = input.location || undefined;
    if (input.socials !== undefined) {
      const RESERVED = new Set(["name", "bio", "location"]);
      for (const s of input.socials) {
        if (RESERVED.has(s.label.toLowerCase())) {
          throw new EdgeBookError(
            "reserved_social_label",
            `Social label '${s.label}' is reserved; choose another (e.g. telegram, twitter)`,
          );
        }
      }
      profile.socials = input.socials;
    }
    if (input.visibility) profile.visibility = { ...profile.visibility, ...input.visibility };

    profile.profile_version = (profile.profile_version ?? 1) + 1;
    identity.profile = profile;
    identity.updated_at = now();
    await writeJson(this.file(IDENTITY_FILE), identity, 0o600);
    await this.writeCard();
    await this.audit("identity.update", identity.agent_id, { display_name: identity.display_name, profile_version: profile.profile_version });
    return identity;
  }

  async config(): Promise<EdgeBookConfig> {
    return readJson<EdgeBookConfig>(this.file(CONFIG_FILE), {});
  }

  async updateConfig(input: EdgeBookConfig): Promise<EdgeBookConfig> {
    const current = await this.config();
    const next: EdgeBookConfig = { ...current };
    if (input.direct_url !== undefined) next.direct_url = input.direct_url;
    if (input.relay_url !== undefined) next.relay_url = input.relay_url;
    if (input.notify_on_friend_request !== undefined) next.notify_on_friend_request = input.notify_on_friend_request;
    await writeJson(this.file(CONFIG_FILE), next);
    return next;
  }

  async buildCard(cardUrl?: string): Promise<AgentCard> {
    const identity = await this.identity();
    const config = await this.config();
    const transports: AgentCard["transports"] = [{ mode: "local", endpoint: this.home }];
    if (config.direct_url) transports.push({ mode: "direct", endpoint: config.direct_url });
    if (config.relay_url) transports.push({ mode: "relay", endpoint: config.relay_url });
    const caps = Object.values(await this.capabilities())
      .map((c) => ({ name: c.name, version: c.version, summary: c.summary, status: c.status }));
    const prof = defaultProfile(identity);
    const pubInclude = (field: string) => resolveFieldVisibility(prof, field) === "public";
    const pubSocials = (prof.socials ?? []).filter((s) => resolveSocialVisibility(prof, s.label) === "public");
    const publicProfile: NonNullable<AgentCard["public_profile"]> = {
      ...(prof.name && pubInclude("name") ? { name: prof.name } : {}),
      ...(prof.bio && pubInclude("bio") ? { bio: prof.bio } : {}),
      ...(prof.location && pubInclude("location") ? { location: prof.location } : {}),
      ...(pubSocials.length ? { socials: pubSocials } : {}),
    };
    const publicName = prof.name && pubInclude("name") ? prof.name : undefined;
    const unsigned: Omit<AgentCard, "card_hash" | "signature"> = {
      schema: "openclaw-agent-card/0.1",
      agent_id: identity.agent_id,
      handle: identity.handle,
      display_name: identity.display_name,
      ...(publicName ? { owner_label: publicName } : {}),
      ...(Object.keys(publicProfile).length ? { public_profile: publicProfile } : {}),
      card_url: cardUrl || `file://${this.file(CARD_FILE)}`,
      card_version: 1,
      public_keys: [{ id: `${identity.agent_id}#main`, type: "ed25519", public_key_pem: identity.public_key_pem }],
      capabilities: ["friend_request", "friend_gated_message", "feed_read_friends"],
      ...(caps.length ? { advertised_capabilities: caps } : {}),
      transports,
      refresh_after: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    const card_hash = crypto.createHash("sha256").update(canonicalize(unsigned)).digest("base64url");
    const withHash = { ...unsigned, card_hash };
    return { ...withHash, signature: signPayload(withHash, identity.private_key_pem) };
  }

  async writeCard(cardUrl?: string): Promise<AgentCard> {
    const card = await this.buildCard(cardUrl);
    await writeJson(this.file(CARD_FILE), card);
    return card;
  }

  // The friend-only profile: every field whose visibility resolves to "friends"
  // or "public". Signed; shared only with confirmed friends.
  async buildFriendProfile(): Promise<FriendProfile> {
    const identity = await this.identity();
    const profile = defaultProfile(identity);
    const include = (field: string): boolean => resolveFieldVisibility(profile, field) !== "off";
    const socials = (profile.socials ?? []).filter(
      (s) => resolveSocialVisibility(profile, s.label) !== "off",
    );
    const unsigned: Omit<FriendProfile, "signature"> = {
      schema: "openclaw-friend-profile/0.1",
      agent_id: identity.agent_id,
      profile_version: profile.profile_version ?? 1,
      ...(profile.name && include("name") ? { name: profile.name } : {}),
      ...(profile.bio && include("bio") ? { bio: profile.bio } : {}),
      ...(profile.location && include("location") ? { location: profile.location } : {}),
      ...(socials.length ? { socials } : {}),
      issued_at: now(),
    };
    return { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  }

  async doctor(): Promise<Record<string, unknown>> {
    const identity = await readJson<LocalIdentity | null>(this.file(IDENTITY_FILE), null);
    const config = await this.config();
    const checks: Record<string, unknown> = {
      home: this.home,
      initialized: Boolean(identity),
      config,
      files: {}
    };
    const requiredFiles = [IDENTITY_FILE, CONTACTS_FILE, GRANTS_FILE, SEEN_MESSAGES_FILE, CARD_FILE];
    const files: Record<string, unknown> = {};
    for (const name of requiredFiles) {
      try {
        const stat = await fs.stat(this.file(name));
        files[name] = {
          exists: true,
          mode: `0${(stat.mode & 0o777).toString(8)}`
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          files[name] = { exists: false };
        } else {
          throw error;
        }
      }
    }
    checks.files = files;
    let cardValid = false;
    try {
      const card = await loadCard(this.file(CARD_FILE));
      cardValid = Boolean(identity && card.agent_id === identity.agent_id);
    } catch {
      cardValid = false;
    }
    const identityMode = (files[IDENTITY_FILE] as { mode?: string }).mode;
    const privateKeyModeOk = process.platform === "win32" || identityMode === "0600";
    checks.card_valid = cardValid;
    checks.private_key_mode_ok = privateKeyModeOk;
    checks.pass = Boolean(identity) && cardValid && privateKeyModeOk;
    return checks;
  }

  async contacts(): Promise<Record<string, AgentContactRecord>> {
    return readJson<Record<string, AgentContactRecord>>(this.file(CONTACTS_FILE), {});
  }

  async saveContacts(contacts: Record<string, AgentContactRecord>): Promise<void> {
    await writeJson(this.file(CONTACTS_FILE), contacts);
  }

  async grants(): Promise<Record<string, CapabilityGrant>> {
    return readJson<Record<string, CapabilityGrant>>(this.file(GRANTS_FILE), {});
  }

  async saveGrants(grants: Record<string, CapabilityGrant>): Promise<void> {
    await writeJson(this.file(GRANTS_FILE), grants);
  }

  async upsertContactFromCard(card: AgentCard, state?: RelationshipState): Promise<AgentContactRecord> {
    validateCard(card);
    const contacts = await this.contacts();
    const existing = contacts[card.agent_id];
    if (existing?.relationship_state === "blocked" && state !== "blocked") {
      throw new EdgeBookError("blocked_peer", "Blocked peer cannot refresh privileged contact state");
    }
    const stamp = now();
    const next: AgentContactRecord = {
      peer_agent_id: card.agent_id,
      aliases: Array.from(new Set([...(existing?.aliases ?? []), card.handle].filter(Boolean))),
      display_name: card.display_name,
      // Carry the peer's shared human name (undefined if they didn't opt in, or
      // dropped on refresh if they turned sharing off).
      owner_label: card.owner_label,
      // Preserve a previously-received friend profile across card refreshes.
      ...(existing?.friend_profile ? { friend_profile: existing.friend_profile } : {}),
      ...(existing?.notified_at ? { notified_at: existing.notified_at } : {}),
      advertised_capabilities: card.advertised_capabilities,
      card_url: card.card_url,
      known_endpoints: card.transports,
      public_keys: card.public_keys,
      relationship_state: state ?? existing?.relationship_state ?? "none",
      capability_grants: existing?.capability_grants ?? [],
      last_card_hash: card.card_hash,
      last_card_version: card.card_version,
      last_card_refresh_at: stamp,
      last_successful_delivery_at: existing?.last_successful_delivery_at ?? "",
      audit_refs: existing?.audit_refs ?? [],
      created_at: existing?.created_at ?? stamp,
      updated_at: stamp
    };
    contacts[card.agent_id] = next;
    await this.saveContacts(contacts);
    await this.audit("contact.upsert", card.agent_id, { state: next.relationship_state });
    return next;
  }

  async setRelationship(peerAgentId: string, nextState: RelationshipState, type: RelationshipEvent["type"], reason = ""): Promise<RelationshipEvent> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    const previous = contact.relationship_state;
    contact.relationship_state = nextState;
    contact.updated_at = now();
    contacts[peerAgentId] = contact;
    await this.saveContacts(contacts);

    const unsigned: Omit<RelationshipEvent, "signature"> = {
      event_id: randomId("evt"),
      type,
      from_agent_id: identity.agent_id,
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      previous_state: previous,
      next_state: nextState,
      human_approval_ref: "local-test-harness-or-cli",
      reason,
      created_at: now()
    };
    const event = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
    await appendJsonl(this.file(RELATIONSHIP_EVENTS_FILE), event);
    await this.audit(`relationship.${type}`, peerAgentId, { previous, next: nextState, reason });
    return event;
  }

  async createFriendRequest(targetCard: AgentCard, note = ""): Promise<MessageEnvelope> {
    const identity = await this.identity();
    validateCard(targetCard);
    const existing = (await this.contacts())[targetCard.agent_id];
    if (existing?.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot request a blocked peer");
    await this.upsertContactFromCard(targetCard, "request_sent");
    await this.setRelationship(targetCard.agent_id, "request_sent", "FriendRequest", note);
    const card = await this.writeCard();
    return this.signEnvelope({
      type: "friend_request",
      to_agent_id: targetCard.agent_id,
      relationship_id: relationshipId(identity.agent_id, targetCard.agent_id),
      capability_id: "",
      ref: "",
      transport: "local",
      body: { card, note } satisfies FriendRequestBody
    });
  }

  async receiveFriendRequest(envelope: MessageEnvelope): Promise<AgentContactRecord> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "friend_request") throw new EdgeBookError("wrong_message_type", "Expected friend_request envelope");
    const body = envelope.body as unknown as FriendRequestBody;
    validateCard(body.card);
    if (body.card.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Friend request card does not match sender");
    const contact = await this.upsertContactFromCard(body.card, "request_received");
    await this.setRelationship(envelope.from_agent_id, "request_received", "FriendRequest", body.note);
    await appendJsonl(this.file(INBOX_FILE), envelope);
    return contact;
  }

  // Inbound friend requests the human hasn't been told about yet. Empty when the
  // agent has notifications disabled. Read-only — the notifier cron consumes this.
  async pendingFriendRequests(): Promise<AgentContactRecord[]> {
    const config = await this.config();
    if (config.notify_on_friend_request === false) return [];
    const contacts = await this.contacts();
    return Object.values(contacts).filter(
      (c) => c.relationship_state === "request_received" && !c.notified_at,
    );
  }

  // Stamp a request as notified so it won't surface again (idempotent sweep,
  // mirrors expireEscalations).
  async markFriendRequestNotified(peerAgentId: string): Promise<void> {
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.notified_at) return;
    contact.notified_at = now();
    contact.updated_at = now();
    contacts[peerAgentId] = contact;
    await this.saveContacts(contacts);
    await this.audit("friend.notified", peerAgentId, {});
  }

  async acceptFriend(peerAgentId: string, reason = "accepted"): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot accept a blocked peer");
    await this.setRelationship(peerAgentId, "friend", "Accept", reason);
    // `profile.read.friend` is minted now but intentionally NOT enforced in this
    // phase: the push exchange (profile_share) gates on relationship_state ===
    // "friend", not on the grant. The scope is reserved so a future pull-based
    // profile-read path (the reader `friend_accept` wiring, Plan C) can enforce
    // it without re-granting existing friendships. Until that consumer lands it
    // is a forward-compat token, not a live access check.
    // `escalation.raise` lets a confirmed friend raise an escalation to this
    // agent's human (ea-claude-094) — friending is the authorization to ask.
    const grant = await this.issueGrant(peerAgentId, ["message.friend", "feed.read.friends", "profile.read.friend", "escalation.raise"]);
    const card = await this.writeCard();
    const profile = await this.buildFriendProfile();
    return this.signEnvelope({
      type: "friend_response",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: grant.grant_id,
      ref: "",
      transport: "local",
      body: { accepted: true, card, grant, profile, reason } satisfies FriendResponseBody
    });
  }

  async applyFriendResponse(envelope: MessageEnvelope): Promise<MessageEnvelope | null> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "friend_response") throw new EdgeBookError("wrong_message_type", "Expected friend_response envelope");
    const body = envelope.body as unknown as FriendResponseBody;
    validateCard(body.card);
    if (body.card.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Friend response card does not match sender");
    await this.upsertContactFromCard(body.card, body.accepted ? "friend" : "rejected");
    await this.setRelationship(envelope.from_agent_id, body.accepted ? "friend" : "rejected", body.accepted ? "Accept" : "Reject", body.reason);
    if (body.grant) await this.storeGrant(body.grant);
    if (body.accepted && body.profile) {
      const publicKey = body.card.public_keys?.[0]?.public_key_pem;
      if (!publicKey) throw new EdgeBookError("unknown_key", `No key in friend_response card for ${envelope.from_agent_id}`);
      if (body.profile.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "friend_response profile agent_id does not match sender");
      validateFriendProfile(body.profile, publicKey);
      await this.storeFriendProfile(envelope.from_agent_id, body.profile);
    }
    // Now that both sides are friends, send our own profile back.
    if (body.accepted) return this.buildProfileShareEnvelope(envelope.from_agent_id);
    return null;
  }

  // Persist a received FriendProfile onto the peer contact (last-writer-wins by
  // profile_version). Returns true if applied, false if stale.
  private async storeFriendProfile(peerAgentId: string, profile: FriendProfile): Promise<boolean> {
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    const current = contact.friend_profile?.profile_version ?? -1;
    if (profile.profile_version <= current) return false;
    contact.friend_profile = profile;
    contact.updated_at = now();
    contacts[peerAgentId] = contact;
    await this.saveContacts(contacts);
    await this.audit("profile.received", peerAgentId, { profile_version: profile.profile_version });
    return true;
  }

  // Build a signed profile_share envelope carrying our current FriendProfile to a
  // confirmed friend.
  async buildProfileShareEnvelope(peerAgentId: string): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact || contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Not friends with ${peerAgentId}; cannot share profile`);
    }
    const profile = await this.buildFriendProfile();
    return this.signEnvelope({
      type: "profile_share",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: "",
      ref: "",
      transport: "local",
      body: { profile } satisfies ProfileShareBody,
    });
  }

  async receiveProfileShare(envelope: MessageEnvelope): Promise<void> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "profile_share") throw new EdgeBookError("wrong_message_type", "Expected profile_share envelope");
    const contacts = await this.contacts();
    const contact = contacts[envelope.from_agent_id];
    if (!contact || contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", "profile_share from a non-friend");
    }
    const body = envelope.body as unknown as ProfileShareBody;
    if (body.profile.agent_id !== envelope.from_agent_id) {
      throw new EdgeBookError("agent_id_mismatch", "FriendProfile agent_id does not match sender");
    }
    const publicKey = contact.public_keys?.[0]?.public_key_pem;
    if (!publicKey) throw new EdgeBookError("unknown_key", `No key for ${envelope.from_agent_id}`);
    validateFriendProfile(body.profile, publicKey);
    await this.storeFriendProfile(envelope.from_agent_id, body.profile);
  }

  // Build a profile_share for every current friend (caller delivers them).
  async broadcastProfileEnvelopes(): Promise<MessageEnvelope[]> {
    const contacts = await this.contacts();
    const friends = Object.values(contacts).filter((c) => c.relationship_state === "friend");
    const out: MessageEnvelope[] = [];
    for (const friend of friends) {
      out.push(await this.buildProfileShareEnvelope(friend.peer_agent_id));
    }
    return out;
  }

  async revoke(peerAgentId: string): Promise<void> {
    await this.setRelationship(peerAgentId, "revoked", "Revoke", "revoked");
    const grants = await this.grants();
    for (const grant of Object.values(grants)) {
      if (grant.subject_agent_id === peerAgentId || grant.issuer_agent_id === peerAgentId) {
        grant.status = "revoked";
        grant.revoked_at = now();
      }
    }
    await this.saveGrants(grants);
  }

  async block(peerAgentId: string): Promise<void> {
    await this.setRelationship(peerAgentId, "blocked", "Block", "blocked");
  }

  async issueGrant(subjectAgentId: string, scopes: string[], expiresAt = ""): Promise<CapabilityGrant> {
    const identity = await this.identity();
    const unsigned: Omit<CapabilityGrant, "signature"> = {
      grant_id: randomId("grant"),
      issuer_agent_id: identity.agent_id,
      subject_agent_id: subjectAgentId,
      relationship_id: relationshipId(identity.agent_id, subjectAgentId),
      scopes,
      status: "active",
      issued_at: now(),
      expires_at: expiresAt,
      revoked_at: "",
      audit_refs: []
    };
    const grant = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
    await this.storeGrant(grant);
    await this.audit("grant.issue", subjectAgentId, { grant_id: grant.grant_id, scopes });
    return grant;
  }

  async storeGrant(grant: CapabilityGrant): Promise<void> {
    const grants = await this.grants();
    grants[grant.grant_id] = grant;
    await this.saveGrants(grants);
    const contacts = await this.contacts();
    const peer = grant.issuer_agent_id === (await this.identity()).agent_id ? grant.subject_agent_id : grant.issuer_agent_id;
    const contact = contacts[peer];
    if (contact && !contact.capability_grants.includes(grant.grant_id)) {
      contact.capability_grants.push(grant.grant_id);
      contact.updated_at = now();
      contacts[peer] = contact;
      await this.saveContacts(contacts);
    }
  }

  async sendPrivilegedMessage(peerAgentId: string, body: Record<string, unknown>, scope = "message.friend"): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked", `Peer ${peerAgentId} is blocked`);
    if (contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Cannot send friend-gated message to relationship_state=${contact.relationship_state}`);
    }
    const grant = await this.findUsableGrant(peerAgentId, scope);
    if (!grant) throw new EdgeBookError("missing_grant", `No active grant for ${scope}`);
    await this.assertGrantSignature(grant);
    const envelope = await this.signEnvelope({
      type: "privileged_message",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: grant.grant_id,
      ref: "",
      transport: "local",
      body
    });
    await appendJsonl(this.file(MESSAGES_FILE), envelope);
    await this.audit("message.send", peerAgentId, { message_id: envelope.message_id, scope });
    return envelope;
  }

  async receivePrivilegedMessage(envelope: MessageEnvelope): Promise<void> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "privileged_message") throw new EdgeBookError("wrong_message_type", "Expected privileged_message envelope");
    const contacts = await this.contacts();
    const contact = contacts[envelope.from_agent_id];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${envelope.from_agent_id}`);
    if (contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Cannot receive friend-gated message from relationship_state=${contact.relationship_state}`);
    }
    const grants = await this.grants();
    const grant = grants[envelope.capability_id];
    if (!grant || grant.status !== "active" || grant.subject_agent_id !== envelope.from_agent_id || !grant.scopes.includes("message.friend")) {
      throw new EdgeBookError("missing_grant", "Message does not carry an active grant issued to sender");
    }
    await this.assertGrantSignature(grant);
    await appendJsonl(this.file(INBOX_FILE), envelope);
    await this.audit("message.receive", envelope.from_agent_id, { message_id: envelope.message_id });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Edge Book MVP: single shared object + object.read grant (spec-0020 R2/R3)
  // ea-claude-066. One object type ("request"), ≤1 attachment, fail-closed
  // access, append-only audit on create/grant/access/revoke. No R4 fields.
  // ──────────────────────────────────────────────────────────────────────

  async objects(): Promise<Record<string, SharedObject>> {
    return readJson<Record<string, SharedObject>>(this.file(OBJECTS_FILE), {});
  }

  async saveObjects(objects: Record<string, SharedObject>): Promise<void> {
    await writeJson(this.file(OBJECTS_FILE), objects);
  }

  async getObject(objectId: string): Promise<SharedObject | undefined> {
    return (await this.objects())[objectId];
  }

  // Create one shared object (a request + at most one attachment). Signed and
  // stored locally; writes an `object.create` audit event.
  async createObject(input: {
    title: string;
    body: string;
    attachment?: { filename: string; mime: string; bytes: Buffer };
  }): Promise<SharedObject> {
    const identity = await this.identity();
    const object_id = randomId("obj");
    let attachment: SharedObjectAttachment | undefined;
    if (input.attachment) {
      const ref = path.join(ATTACHMENTS_DIR, `${object_id}-${input.attachment.filename}`);
      await fs.mkdir(this.file(ATTACHMENTS_DIR), { recursive: true });
      await fs.writeFile(this.file(ref), input.attachment.bytes);
      attachment = {
        filename: input.attachment.filename,
        mime: input.attachment.mime,
        size: input.attachment.bytes.length,
        ref
      };
    }
    const unsigned: Omit<SharedObject, "signature"> = {
      object_id,
      type: "request",
      from_agent: identity.agent_id,
      request: { title: input.title, body: input.body },
      ...(attachment ? { attachment } : {}),
      created_at: now()
    };
    const object: SharedObject = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
    const objects = await this.objects();
    objects[object_id] = object;
    await this.saveObjects(objects);
    await this.audit("object.create", identity.agent_id, { object_id, has_attachment: Boolean(attachment) });
    return object;
  }

  // ─── spec-0021 post-type store methods ──────────────────────────────────

  // Class 4: Result Attestation — content-addressed, write-once (R6)
  async attestations(): Promise<Record<string, ResultAttestation>> {
    return readJson<Record<string, ResultAttestation>>(this.file(ATTESTATIONS_FILE), {});
  }

  async saveAttestations(attestations: Record<string, ResultAttestation>): Promise<void> {
    await writeJson(this.file(ATTESTATIONS_FILE), attestations);
  }

  async saveEndorsements(endorsements: Record<string, Endorsement>): Promise<void> {
    await writeJson(this.file(ENDORSEMENTS_FILE), endorsements);
  }

  async saveSignals(signals: Record<string, Signal>): Promise<void> {
    await writeJson(this.file(SIGNALS_FILE), signals);
  }

  async saveCapabilities(capabilities: Record<string, CapabilityAdvertisement>): Promise<void> {
    await writeJson(this.file(CAPABILITIES_FILE), capabilities);
  }

  async createAttestation(input: {
    subject_agent_id: string; task_ref: string;
    outcome: ResultAttestation["outcome"]; summary: string;
    evidence?: Record<string, unknown>; created_at?: string;
  }): Promise<ResultAttestation> {
    const identity = await this.identity();
    const content = {
      post_type: "result_attestation" as const,
      schema: "edge-book/result-attestation/0.1" as const,
      attestor_agent_id: identity.agent_id,
      subject_agent_id: input.subject_agent_id,
      task_ref: input.task_ref,
      outcome: input.outcome,
      summary: input.summary,
      evidence: input.evidence ?? {},
      created_at: input.created_at ?? now(),
    };
    const attestation_id = contentHash(content);
    const attestation: ResultAttestation = {
      ...content, attestation_id,
      signature: signPayload({ ...content, attestation_id }, identity.private_key_pem),
    };
    const all = await this.attestations();
    if (!all[attestation_id]) {           // write-once: never rewrite in place (R6)
      all[attestation_id] = attestation;
      await this.saveAttestations(all);
      await this.audit("attestation.create", input.subject_agent_id, { attestation_id, task_ref: input.task_ref });
    }
    return all[attestation_id];
  }

  async verifyAttestation(att: ResultAttestation): Promise<boolean> {
    const identity = await this.identity();
    let pub = identity.agent_id === att.attestor_agent_id ? identity.public_key_pem : undefined;
    if (!pub) {
      const c = (await this.contacts())[att.attestor_agent_id];
      pub = c?.public_keys?.[0]?.public_key_pem;
    }
    if (!pub) return false;
    const { signature, ...signedPayload } = att;
    // integrity: id must equal hash of content (content excludes id+signature)
    const { attestation_id, ...content } = signedPayload;
    if (contentHash(content) !== attestation_id) return false;
    return verifyPayload(signedPayload, signature, pub);
  }

  async verifyCapability(cap: CapabilityAdvertisement): Promise<boolean> {
    const identity = await this.identity();
    let pub = identity.agent_id === cap.agent_id ? identity.public_key_pem : undefined;
    if (!pub) {
      const c = (await this.contacts())[cap.agent_id];
      pub = c?.public_keys?.[0]?.public_key_pem;
    }
    if (!pub) return false;
    const { signature, ...rest } = cap;
    return verifyPayload(rest, signature, pub);
  }

  // Verify an EphemeralPost signature. lifecycle is NOT part of the signed payload
  // (it is mutable local metadata), so strip both signature and lifecycle before verify.
  async verifyEphemeral(post: EphemeralPost): Promise<boolean> {
    const identity = await this.identity();
    let pub = identity.agent_id === post.from_agent ? identity.public_key_pem : undefined;
    if (!pub) {
      const c = (await this.contacts())[post.from_agent];
      pub = c?.public_keys?.[0]?.public_key_pem;
    }
    if (!pub) return false;
    const { signature, lifecycle: _lc, ...signedPayload } = post;
    return verifyPayload(signedPayload, signature, pub);
  }

  // Verify an Answer signature. lifecycle is NOT part of the signed payload.
  async verifyAnswer(ans: Answer): Promise<boolean> {
    const identity = await this.identity();
    let pub = identity.agent_id === ans.answerer_agent_id ? identity.public_key_pem : undefined;
    if (!pub) {
      const c = (await this.contacts())[ans.answerer_agent_id];
      pub = c?.public_keys?.[0]?.public_key_pem;
    }
    if (!pub) return false;
    const { signature, lifecycle: _lc, ...signedPayload } = ans;
    return verifyPayload(signedPayload, signature, pub);
  }

  // Verify a Signal signature. lifecycle is NOT part of the signed payload.
  async verifySignal(sig: Signal): Promise<boolean> {
    const identity = await this.identity();
    let pub = identity.agent_id === sig.from_agent ? identity.public_key_pem : undefined;
    if (!pub) {
      const c = (await this.contacts())[sig.from_agent];
      pub = c?.public_keys?.[0]?.public_key_pem;
    }
    if (!pub) return false;
    const { signature, lifecycle: _lc, ...signedPayload } = sig;
    return verifyPayload(signedPayload, signature, pub);
  }

  // Verify an Endorsement signature. Endorsements have no lifecycle field.
  async verifyEndorsement(e: Endorsement): Promise<boolean> {
    const identity = await this.identity();
    let pub = identity.agent_id === e.endorser_agent_id ? identity.public_key_pem : undefined;
    if (!pub) {
      const c = (await this.contacts())[e.endorser_agent_id];
      pub = c?.public_keys?.[0]?.public_key_pem;
    }
    if (!pub) return false;
    const { signature, ...rest } = e;
    return verifyPayload(rest, signature, pub);
  }

  // Class 3: Endorse — actor-owned reified edge, strongRef parent, evidence link (R5, R8)
  async endorsements(): Promise<Record<string, Endorsement>> {
    return readJson<Record<string, Endorsement>>(this.file(ENDORSEMENTS_FILE), {});
  }

  async createEndorsement(input: {
    subject_agent_id: string; parent: StrongRef; statement: string;
    evidence_ref?: StrongRef; evidence_task_id?: string;
  }): Promise<Endorsement> {
    if (!input.evidence_ref && !input.evidence_task_id) {
      throw new EdgeBookError("missing_evidence", "Endorse requires an evidence link (Result Attestation ref or task id) — R8");
    }
    if (!input.parent?.uri || !input.parent?.hash) {
      throw new EdgeBookError("missing_parent", "Endorse requires a strongRef parent (uri + hash) — R5");
    }
    const identity = await this.identity();
    const endorse_id = randomId("end");
    const stamp = now();
    const unsigned = {
      endorse_id,
      post_type: "endorse" as const,
      schema: "edge-book/endorse/0.1" as const,
      endorser_agent_id: identity.agent_id,   // actor-owned (R5)
      subject_agent_id: input.subject_agent_id,
      parent: input.parent,
      ...(input.evidence_ref ? { evidence_ref: input.evidence_ref } : {}),
      ...(input.evidence_task_id ? { evidence_task_id: input.evidence_task_id } : {}),
      statement: input.statement,
      created_at: stamp,
    };
    const endorsement: Endorsement = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
    const all = await this.endorsements();
    all[endorse_id] = endorsement;
    // evidence_ref/evidence_task_id is an open-world link — no referential-integrity check that the attestation exists locally.
    await this.saveEndorsements(all);
    await this.audit("endorse.create", input.subject_agent_id, { endorse_id, parent: input.parent.uri });
    return endorsement;
  }

  // Class 2: Signal — ephemeral, lifecycle + TTL (R4)
  private signalLifecycle(sig: Signal): Signal["lifecycle"] {
    return computeLifecycle(sig.expires_at, false, sig.lifecycle) as Signal["lifecycle"];
  }

  async signals(): Promise<Record<string, Signal>> {
    const raw = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
    for (const id of Object.keys(raw)) raw[id].lifecycle = this.signalLifecycle(raw[id]);
    return raw;
  }

  async createSignal(input: { body: string; ttlMs?: number }): Promise<Signal> {
    const identity = await this.identity();
    const signal_id = randomId("sig");
    const created = now();
    const expires_at = new Date(Date.now() + (input.ttlMs ?? DEFAULT_SIGNAL_TTL_MS)).toISOString();
    // lifecycle is mutable local metadata — excluded from the signed payload so
    // expireSignals() can advance it without invalidating the signature.
    const unsigned = {
      signal_id, post_type: "signal" as const, schema: "edge-book/signal/0.1" as const,
      from_agent: identity.agent_id, body: input.body,
      created_at: created, expires_at,
    };
    const signal: Signal = { ...unsigned, lifecycle: "active" as const, signature: signPayload(unsigned, identity.private_key_pem) };
    const all = await this.signals();
    all[signal_id] = signal;
    await this.saveSignals(all);
    await this.audit("signal.create", identity.agent_id, { signal_id });
    return signal;
  }

  async expireSignals(): Promise<void> {
    const all = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
    let changed = false;
    for (const id of Object.keys(all)) {
      if (all[id].lifecycle !== "expired" && Date.parse(all[id].expires_at) <= Date.now()) {
        all[id].lifecycle = "expired"; changed = true;
      }
    }
    if (changed) await this.saveSignals(all);
  }

  // Generic Class-2 ephemeral store (query/share/coordinate/delegation_request, R2/R4)
  async saveEphemeral(posts: Record<string, EphemeralPost>): Promise<void> {
    await writeJson(this.file(EPHEMERAL_FILE), posts);
  }

  async ephemeralPosts(): Promise<Record<string, EphemeralPost>> {
    const raw = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
    for (const id of Object.keys(raw)) {
      raw[id].lifecycle = computeLifecycle(raw[id].expires_at, EPHEMERAL_TTL_POLICY[raw[id].post_type].hard, raw[id].lifecycle);
    }
    return raw;
  }

  async createEphemeral(type: EphemeralType, input: { body: string; subject_agent_id?: string; ref?: string; ttlMs?: number }): Promise<EphemeralPost> {
    if (!EPHEMERAL_TTL_POLICY[type]) throw new EdgeBookError("unknown_post_type", `Not an ephemeral Class-2 type: ${type}`);
    const identity = await this.identity();
    const post_id = randomId("eph");
    const created = now();
    const expires_at = new Date(Date.now() + (input.ttlMs ?? DEFAULT_EPHEMERAL_TTL_MS)).toISOString();
    // lifecycle is mutable local metadata — excluded from the signed payload so
    // cancel/expire transitions do not invalidate the signature.
    const unsigned = {
      post_id, post_type: type, schema: "edge-book/ephemeral/0.1" as const,
      from_agent: identity.agent_id, body: input.body,
      ...(input.subject_agent_id ? { subject_agent_id: input.subject_agent_id } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
      created_at: created, expires_at,
    };
    const post: EphemeralPost = { ...unsigned, lifecycle: "active" as const, signature: signPayload(unsigned, identity.private_key_pem) };
    const all = await this.ephemeralPosts();
    all[post_id] = post;
    await this.saveEphemeral(all);
    // actor is always identity.agent_id; subject_agent_id goes in details if relevant
    await this.audit(type + ".create", identity.agent_id, { post_id, ...(input.subject_agent_id ? { subject_agent_id: input.subject_agent_id } : {}) });
    return post;
  }

  async expireEphemeral(): Promise<void> {
    const all = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
    let changed = false;
    for (const id of Object.keys(all)) {
      const next = computeLifecycle(all[id].expires_at, EPHEMERAL_TTL_POLICY[all[id].post_type].hard, all[id].lifecycle);
      if (next !== all[id].lifecycle) { all[id].lifecycle = next; changed = true; }
    }
    if (changed) await this.saveEphemeral(all);
  }

  async cancelEphemeral(postId: string): Promise<EphemeralPost> {
    const all = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
    const post = all[postId];
    if (!post) throw new EdgeBookError("not_found", `No ephemeral post ${postId}`);
    post.lifecycle = "cancelled";
    await this.saveEphemeral(all);
    await this.audit("ephemeral.cancel", post.from_agent, { post_id: postId });
    return post;
  }

  // Class 3: Answer — actor-owned, strongRef to a Query (R5)
  async saveAnswers(answers: Record<string, Answer>): Promise<void> {
    await writeJson(this.file(ANSWERS_FILE), answers);
  }

  async answers(): Promise<Record<string, Answer>> {
    return readJson<Record<string, Answer>>(this.file(ANSWERS_FILE), {});
  }

  async createAnswer(input: { parent: StrongRef; body: string }): Promise<Answer> {
    if (!input.parent?.uri || !input.parent?.hash) {
      throw new EdgeBookError("missing_parent", "Answer requires a strongRef parent (uri + hash) — R5");
    }
    const identity = await this.identity();
    const answer_id = randomId("ans");
    // lifecycle is mutable local metadata — excluded from the signed payload so
    // deleteQuery tombstone transitions do not invalidate the signature.
    const unsigned = {
      answer_id, post_type: "answer" as const, schema: "edge-book/answer/0.1" as const,
      answerer_agent_id: identity.agent_id,   // actor-owned (R5)
      parent: input.parent, body: input.body,
      created_at: now(),
    };
    const answer: Answer = { ...unsigned, lifecycle: "active" as const, signature: signPayload(unsigned, identity.private_key_pem) };
    const all = await this.answers();
    all[answer_id] = answer;
    await this.saveAnswers(all);
    await this.audit("answer.create", identity.agent_id, { answer_id, parent: input.parent.uri });
    return answer;
  }

  // R7: deleting a Query tombstones (archives) it AND its Answers — never hard-drops.
  async deleteQuery(queryId: string): Promise<void> {
    const eph = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
    const q = eph[queryId];
    if (!q || q.post_type !== "query") throw new EdgeBookError("not_found", `No query ${queryId}`);
    q.lifecycle = "tombstoned";
    await this.saveEphemeral(eph);
    const parentUri = "edgebook:query:" + queryId;
    const ans = await this.answers();
    let changed = false;
    for (const id of Object.keys(ans)) {
      if (ans[id].parent.uri === parentUri && ans[id].lifecycle !== "tombstoned") { ans[id].lifecycle = "tombstoned"; changed = true; }
    }
    if (changed) await this.saveAnswers(ans);
    await this.audit("query.delete", q.from_agent, { query_id: queryId });
  }

  // Class 1: Capability Advertisement — versioned, deprecate-not-delete (R3)
  async capabilities(): Promise<Record<string, CapabilityAdvertisement>> {
    return readJson<Record<string, CapabilityAdvertisement>>(this.file(CAPABILITIES_FILE), {});
  }

  async advertiseCapability(input: { name: string; version: string; summary: string }): Promise<CapabilityAdvertisement> {
    const identity = await this.identity();
    const capability_id = randomId("cap");
    const stamp = now();
    const unsigned = {
      capability_id, post_type: "capability_advertisement" as const,
      schema: "edge-book/capability/0.1" as const, agent_id: identity.agent_id,
      name: input.name, version: input.version, summary: input.summary,
      status: "active" as const, created_at: stamp, updated_at: stamp,
    };
    const cap: CapabilityAdvertisement = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
    const all = await this.capabilities();
    all[capability_id] = cap;
    await this.saveCapabilities(all);
    await this.audit("capability.advertise", identity.agent_id, { capability_id, name: input.name });
    return cap;
  }

  async deprecateCapability(capabilityId: string): Promise<CapabilityAdvertisement> {
    const identity = await this.identity();
    const all = await this.capabilities();
    const cap = all[capabilityId];
    if (!cap) throw new EdgeBookError("not_found", `No capability ${capabilityId}`);
    cap.status = "deprecated";        // never delete (R3)
    cap.updated_at = now();
    const { signature: _sig, ...rest } = cap;
    cap.signature = signPayload(rest, identity.private_key_pem);
    await this.saveCapabilities(all);
    await this.audit("capability.deprecate", identity.agent_id, { capability_id: capabilityId });
    return cap;
  }

  // R7 cascade: deprecate Class 1, terminate open Class 2, RETAIN Class 3 + Class 4.
  async deregister(): Promise<void> {
    const identity = await this.identity();
    const caps = await this.capabilities();
    for (const id of Object.keys(caps)) {
      if (caps[id].status === "active") {
        caps[id].status = "deprecated";
        caps[id].updated_at = now();
        const { signature: _sig, ...rest } = caps[id];
        caps[id].signature = signPayload(rest, identity.private_key_pem);
      }
    }
    await this.saveCapabilities(caps);
    const sigs = await readJson<Record<string, Signal>>(this.file(SIGNALS_FILE), {});
    for (const id of Object.keys(sigs)) {
      if (sigs[id].lifecycle !== "expired") sigs[id].lifecycle = "expired";
    }
    await this.saveSignals(sigs);
    const eph = await readJson<Record<string, EphemeralPost>>(this.file(EPHEMERAL_FILE), {});
    for (const id of Object.keys(eph)) {
      const lc = eph[id].lifecycle;
      if (lc === "expired" || lc === "cancelled" || lc === "tombstoned") continue;
      const t = eph[id].post_type;
      eph[id].lifecycle = (t === "query" || t === "delegation_request") ? "cancelled" : "expired";
    }
    await this.saveEphemeral(eph);
    const ans = await readJson<Record<string, Answer>>(this.file(ANSWERS_FILE), {});
    for (const id of Object.keys(ans)) if (ans[id].lifecycle !== "tombstoned") ans[id].lifecycle = "tombstoned";
    await this.saveAnswers(ans);
    // Endorsements (Class 3 evidence) + Attestations (Class 4) remain retained (untouched).
    await this.audit("agent.deregister", (await this.identity()).agent_id, {});
  }

  // Issue an `object.read` grant binding ONE object to ONE subject (revocable).
  async issueObjectGrant(subjectAgentId: string, objectId: string, expiresAt = ""): Promise<CapabilityGrant> {
    const identity = await this.identity();
    if (!(await this.getObject(objectId))) throw new EdgeBookError("unknown_object", `Unknown object: ${objectId}`);
    const unsigned: Omit<CapabilityGrant, "signature"> = {
      grant_id: randomId("grant"),
      issuer_agent_id: identity.agent_id,
      subject_agent_id: subjectAgentId,
      relationship_id: relationshipId(identity.agent_id, subjectAgentId),
      scopes: ["object.read"],
      status: "active",
      issued_at: now(),
      expires_at: expiresAt,
      revoked_at: "",
      audit_refs: [],
      object_id: objectId
    };
    const grant = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
    await this.storeGrant(grant);
    await this.audit("grant.issue", subjectAgentId, { grant_id: grant.grant_id, object_id: objectId, scope: "object.read" });
    return grant;
  }

  // Fail-closed predicate (spec-0020 R3): readable IFF an active, unexpired
  // `object.read` grant exists for (object_id, subject). Does NOT audit — use
  // readObject() for an audited access. The object's owner may always read it.
  async canReadObject(objectId: string, subjectAgentId: string, at = Date.now()): Promise<boolean> {
    const object = await this.getObject(objectId);
    if (object && object.from_agent === subjectAgentId) return true; // owner
    const grants = await this.grants();
    const candidates = Object.values(grants).filter((grant) =>
      grant.object_id === objectId &&
      grant.subject_agent_id === subjectAgentId &&
      grant.scopes.includes("object.read") &&
      grant.status === "active" &&
      (!grant.expires_at || Date.parse(grant.expires_at) > at)
    );
    // ea-openclaw-030 access check #6: the binding grant must carry a verifiable
    // issuer signature, so a grant tampered after signing fails closed.
    for (const grant of candidates) {
      if (await this.verifyGrantSignature(grant)) return true;
    }
    return false;
  }

  // Audited read. Returns the object iff canReadObject; else fails closed.
  async readObject(objectId: string, subjectAgentId: string): Promise<SharedObject> {
    const object = await this.getObject(objectId);
    if (!object || !(await this.canReadObject(objectId, subjectAgentId))) {
      throw new EdgeBookError("access_denied", `No active object.read grant for (${objectId}, ${subjectAgentId})`);
    }
    await this.audit("object.access", subjectAgentId, { object_id: objectId });
    return object;
  }

  // Raw bytes of an object's (single) attachment, agent-held under attachments/.
  // Caller is responsible for the access check (readObject) first.
  async readAttachmentBytes(objectId: string): Promise<Buffer> {
    const object = await this.getObject(objectId);
    if (!object?.attachment) throw new EdgeBookError("no_attachment", `No attachment for ${objectId}`);
    return fs.readFile(this.file(object.attachment.ref));
  }

  // Objects the given subject (default: me) may currently read — the data behind
  // the reader's "Shared with me" surface. Read-through is unaudited (listing);
  // readObject() audits the actual open.
  async sharedObjectsFor(subjectAgentId?: string): Promise<SharedObject[]> {
    const subject = subjectAgentId ?? (await this.identity()).agent_id;
    const objects = await this.objects();
    const out: SharedObject[] = [];
    for (const object of Object.values(objects)) {
      if (object.from_agent === subject) continue; // own objects aren't "shared with me"
      if (await this.canReadObject(object.object_id, subject)) out.push(object);
    }
    return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }

  // Build a signed `object_share` envelope (object + grant + inline attachment)
  // to deliver to a friend over the mailbox transport (ea-claude-065).
  async shareObjectEnvelope(peerAgentId: string, objectId: string, expiresAt = ""): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contact = (await this.contacts())[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Cannot share to relationship_state=${contact.relationship_state}`);
    }
    const object = await this.getObject(objectId);
    if (!object) throw new EdgeBookError("unknown_object", `Unknown object: ${objectId}`);
    const grant = await this.issueObjectGrant(peerAgentId, objectId, expiresAt);
    let attachment_b64: string | undefined;
    if (object.attachment) {
      attachment_b64 = (await fs.readFile(this.file(object.attachment.ref))).toString("base64");
    }
    return this.signEnvelope({
      type: "object_share",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: grant.grant_id,
      ref: objectId,
      transport: "local",
      body: { object, grant, ...(attachment_b64 ? { attachment_b64 } : {}) } as unknown as Record<string, unknown>
    });
  }

  // Apply a received `object_share`: store the object (+ attachment) and grant,
  // after verifying the envelope signature and that the grant matches.
  async receiveObjectShare(envelope: MessageEnvelope): Promise<SharedObject> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "object_share") throw new EdgeBookError("wrong_message_type", "Expected object_share envelope");
    const identity = await this.identity();
    const body = envelope.body as unknown as ObjectShareBody;
    const { object, grant } = body;
    if (!object || !grant) throw new EdgeBookError("malformed_object_share", "object_share missing object or grant");
    if (object.from_agent !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Shared object author does not match sender");
    if (grant.object_id !== object.object_id || grant.subject_agent_id !== identity.agent_id || !grant.scopes.includes("object.read")) {
      throw new EdgeBookError("grant_mismatch", "Grant does not bind this object to me with object.read");
    }
    if (body.attachment_b64 && object.attachment) {
      await fs.mkdir(this.file(ATTACHMENTS_DIR), { recursive: true });
      await fs.writeFile(this.file(object.attachment.ref), Buffer.from(body.attachment_b64, "base64"));
    }
    const objects = await this.objects();
    objects[object.object_id] = object;
    await this.saveObjects(objects);
    await this.storeGrant(grant);
    await this.audit("object.receive", envelope.from_agent_id, { object_id: object.object_id, grant_id: grant.grant_id });
    return object;
  }

  // Revoke an object.read grant (forward-looking; does not claw back delivered
  // data). Writes a `grant.revoke` audit event. Returns the revoked grant_ids.
  async revokeObjectGrant(objectId: string, subjectAgentId: string): Promise<string[]> {
    const grants = await this.grants();
    const revoked: string[] = [];
    for (const grant of Object.values(grants)) {
      if (grant.object_id === objectId && grant.subject_agent_id === subjectAgentId && grant.status === "active") {
        grant.status = "revoked";
        grant.revoked_at = now();
        revoked.push(grant.grant_id);
      }
    }
    if (revoked.length) {
      await this.saveGrants(grants);
      await this.audit("grant.revoke", subjectAgentId, { object_id: objectId, grant_ids: revoked });
    }
    return revoked;
  }

  // Build a signed `object_revoke` envelope to forward the revoke to the peer.
  async revokeObjectEnvelope(peerAgentId: string, objectId: string): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const revoked = await this.revokeObjectGrant(objectId, peerAgentId);
    return this.signEnvelope({
      type: "object_revoke",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: revoked[0] || "",
      ref: objectId,
      transport: "local",
      body: { object_id: objectId, grant_id: revoked[0] || "" } satisfies ObjectRevokeBody as unknown as Record<string, unknown>
    });
  }

  // Apply a received `object_revoke`: mark the matching grant revoked locally.
  async receiveObjectRevoke(envelope: MessageEnvelope): Promise<void> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "object_revoke") throw new EdgeBookError("wrong_message_type", "Expected object_revoke envelope");
    const body = envelope.body as unknown as ObjectRevokeBody;
    const grants = await this.grants();
    let changed = false;
    for (const grant of Object.values(grants)) {
      if (grant.object_id === body.object_id && grant.issuer_agent_id === envelope.from_agent_id && grant.status === "active") {
        grant.status = "revoked";
        grant.revoked_at = now();
        changed = true;
      }
    }
    if (changed) await this.saveGrants(grants);
    await this.audit("object.revoke.receive", envelope.from_agent_id, { object_id: body.object_id });
  }

  async findUsableGrant(peerAgentId: string, scope: string): Promise<CapabilityGrant | undefined> {
    const identity = await this.identity();
    const grants = await this.grants();
    return Object.values(grants).find((grant) =>
      grant.issuer_agent_id === peerAgentId &&
      grant.subject_agent_id === identity.agent_id &&
      grant.status === "active" &&
      grant.scopes.includes(scope) &&
      (!grant.expires_at || Date.parse(grant.expires_at) > Date.now())
    );
  }

  // ea-openclaw-030 access check #6: a grant authorizes access only if its
  // issuer signature verifies against the issuer's accepted public key. Grants
  // are signed on issue (signPayload) but must be re-verified on use so that a
  // grant tampered after signing, or presented independently of its issuing
  // envelope, fails closed. Resolves the issuer key from local identity when
  // self-issued, else from the issuer's contact record.
  async verifyGrantSignature(grant: CapabilityGrant): Promise<boolean> {
    if (!grant.signature) return false;
    const identity = await this.identity();
    let publicKey: string | undefined;
    if (grant.issuer_agent_id === identity.agent_id) {
      publicKey = identity.public_key_pem;
    } else {
      const contacts = await this.contacts();
      publicKey = contacts[grant.issuer_agent_id]?.public_keys?.[0]?.public_key_pem;
    }
    if (!publicKey) return false;
    return verifyPayload(withoutSignature(grant), grant.signature, publicKey);
  }

  // Throwing guard used by every friend-gated access path so the signature
  // check lives in exactly one place (ea-openclaw-031: build the grant-check
  // primitive once, have all sites consume it).
  async assertGrantSignature(grant: CapabilityGrant): Promise<void> {
    if (!(await this.verifyGrantSignature(grant))) {
      await this.audit("grant.denied", grant.issuer_agent_id, { grant_id: grant.grant_id, reason: "invalid_grant_signature" });
      throw new EdgeBookError("invalid_grant_signature", "Grant signature does not verify against the issuer key");
    }
  }

  // ─── Received posts (peer posts delivered via mailbox) ──────────────────────

  async receivedPosts(): Promise<Record<string, ReceivedPost>> {
    return readJson<Record<string, ReceivedPost>>(this.file(RECEIVED_POSTS_FILE), {});
  }

  async saveReceivedPosts(posts: Record<string, ReceivedPost>): Promise<void> {
    await writeJson(this.file(RECEIVED_POSTS_FILE), posts);
  }

  /** Grouped view for `/api/received` and the reader. */
  async receivedByCategory(): Promise<{ signals: Record<string, Signal>; ephemeral: Record<string, EphemeralPost>; answers: Record<string, Answer>; endorsements: Record<string, Endorsement> }> {
    const all = await this.receivedPosts();
    const out: { signals: Record<string, Signal>; ephemeral: Record<string, EphemeralPost>; answers: Record<string, Answer>; endorsements: Record<string, Endorsement> } = {
      signals: {},
      ephemeral: {},
      answers: {},
      endorsements: {},
    };
    for (const id of Object.keys(all)) {
      const p: any = all[id];
      if (p.post_type === "signal") out.signals[id] = p;
      else if (p.post_type === "answer") out.answers[id] = p;
      else if (p.post_type === "endorse") out.endorsements[id] = p;
      else out.ephemeral[id] = p; // query / share / coordinate / delegation_request
    }
    return out;
  }

  private async verifyReceivedPost(p: any): Promise<boolean> {
    switch (p.post_type) {
      case "signal": return this.verifySignal(p);
      case "answer": return this.verifyAnswer(p);
      case "endorse": return this.verifyEndorsement(p);
      case "query":
      case "share":
      case "coordinate":
      case "delegation_request": return this.verifyEphemeral(p);
      default: return false;
    }
  }

  private receivedPostId(p: any): string {
    return p.signal_id || p.post_id || p.answer_id || p.endorse_id || "";
  }

  private receivedPostAuthor(p: any): string {
    switch (p.post_type) {
      case "answer": return p.answerer_agent_id ?? "";
      case "endorse": return p.endorser_agent_id ?? "";
      case "signal":
      case "query":
      case "share":
      case "coordinate":
      case "delegation_request": return p.from_agent ?? "";
      default: return "";
    }
  }

  /**
   * Receive a `post_publish` envelope from a friend.
   * Security order:
   *   1. verifyEnvelope (recipient/expiry/replay/sender-key + envelope sig)
   *   2. type guard: must be "post_publish"
   *   3. sender must be a known contact with relationship_state === "friend"
   *   4. inner post author must match envelope.from_agent_id
   *   5. inner post signature must verify
   * Only then store.
   */
  async receivePostPublish(envelope: MessageEnvelope): Promise<ReceivedPost> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "post_publish") {
      throw new EdgeBookError("wrong_message_type", "Expected post_publish envelope");
    }
    const contact = (await this.contacts())[envelope.from_agent_id];
    if (!contact || contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", "post_publish only accepted from friends");
    }
    const post = (envelope.body as any).post;
    if (!post || !post.post_type) {
      throw new EdgeBookError("malformed_post_publish", "missing or malformed post in envelope body");
    }
    if (this.receivedPostAuthor(post) !== envelope.from_agent_id) {
      throw new EdgeBookError("author_mismatch", "post author does not match envelope sender");
    }
    const id = this.receivedPostId(post);
    if (!id) {
      throw new EdgeBookError("malformed_post_publish", "post missing id");
    }
    if (!(await this.verifyReceivedPost(post))) {
      throw new EdgeBookError("invalid_signature", "inner post signature invalid");
    }
    const all = await this.receivedPosts();
    const key = envelope.from_agent_id + ":" + id;
    all[key] = post;
    await this.saveReceivedPosts(all);
    await this.audit("post.receive", envelope.from_agent_id, {
      post_type: post.post_type,
      id,
    });
    return post;
  }

  /** Build a signed `post_publish` envelope wrapping any post type. */
  async signPostPublishEnvelope(input: { to_agent_id: string; post: ReceivedPost }): Promise<MessageEnvelope> {
    const identity = await this.identity();
    return this.signEnvelope({
      type: "post_publish",
      to_agent_id: input.to_agent_id,
      relationship_id: relationshipId(identity.agent_id, input.to_agent_id),
      capability_id: "",
      ref: "",
      transport: "direct",
      body: { post: input.post } as unknown as Record<string, unknown>,
    });
  }

  async signEnvelope(input: Omit<MessageEnvelope, "message_id" | "from_agent_id" | "created_at" | "expires_at" | "signature">): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const unsigned: Omit<MessageEnvelope, "signature"> = {
      message_id: randomId("msg"),
      from_agent_id: identity.agent_id,
      created_at: now(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      ...input
    };
    return { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  }

  async verifyEnvelope(envelope: MessageEnvelope): Promise<void> {
    const identity = await this.identity();
    if (envelope.to_agent_id !== identity.agent_id) throw new EdgeBookError("wrong_recipient", "Envelope recipient does not match local identity");
    if (Date.parse(envelope.expires_at) <= Date.now()) throw new EdgeBookError("expired_message", "Message is expired");
    const seen = await readJson<string[]>(this.file(SEEN_MESSAGES_FILE), []);
    if (seen.includes(envelope.message_id)) throw new EdgeBookError("replay", `Replay detected for ${envelope.message_id}`);
    const contacts = await this.contacts();
    let publicKey = contacts[envelope.from_agent_id]?.public_keys?.[0]?.public_key_pem;
    if (!publicKey && envelope.type === "friend_request") {
      const card = (envelope.body as unknown as FriendRequestBody).card;
      publicKey = card?.public_keys?.[0]?.public_key_pem;
    }
    if (!publicKey && envelope.type === "friend_response") {
      const card = (envelope.body as unknown as FriendResponseBody).card;
      publicKey = card?.public_keys?.[0]?.public_key_pem;
    }
    if (!publicKey) throw new EdgeBookError("unknown_key", `Unknown sender key for ${envelope.from_agent_id}`);
    if (!verifyPayload(withoutSignature(envelope), envelope.signature, publicKey)) {
      throw new EdgeBookError("invalid_signature", "Message signature is invalid");
    }
    seen.push(envelope.message_id);
    await writeJson(this.file(SEEN_MESSAGES_FILE), seen);
  }

  async inbox(): Promise<MessageEnvelope[]> {
    return readJsonl<MessageEnvelope>(this.file(INBOX_FILE));
  }

  async receiveEnvelope(envelope: MessageEnvelope): Promise<void | AgentContactRecord | MessageEnvelope | Escalation | null> {
    if (envelope.type === "friend_request") return this.receiveFriendRequest(envelope);
    if (envelope.type === "friend_response") return this.applyFriendResponse(envelope);
    if (envelope.type === "privileged_message") return this.receivePrivilegedMessage(envelope);
    if (envelope.type === "object_share") { await this.receiveObjectShare(envelope); return; }
    if (envelope.type === "object_revoke") { await this.receiveObjectRevoke(envelope); return; }
    if (envelope.type === "post_publish") { await this.receivePostPublish(envelope); return; }
    if (envelope.type === "profile_share") { await this.receiveProfileShare(envelope); return; }
    if (envelope.type === "escalation") return this.receiveEscalation(envelope);
    if (envelope.type === "escalation_response") return this.applyEscalationResponse(envelope);
    throw new EdgeBookError("unsupported_envelope", `Unsupported envelope type: ${envelope.type}`);
  }

  async audit(action: string, peerAgentId: string, details: Record<string, unknown>): Promise<string> {
    const audit_id = randomId("audit");
    await appendJsonl(this.file(AUDIT_FILE), {
      audit_id,
      created_at: now(),
      action,
      peer_agent_id: peerAgentId,
      details
    });
    return audit_id;
  }

  async auditEvents(): Promise<Array<Record<string, unknown>>> {
    return readJsonl<Record<string, unknown>>(this.file(AUDIT_FILE));
  }

  async sessions(): Promise<Record<string, LocalUserSession>> {
    return readJson<Record<string, LocalUserSession>>(this.file(SESSIONS_FILE), {});
  }

  async saveSessions(sessions: Record<string, LocalUserSession>): Promise<void> {
    await writeJson(this.file(SESSIONS_FILE), sessions);
  }

  async createSession(input: { authMethod?: LocalUserSession["auth_method"]; ttlMs?: number } = {}): Promise<LocalUserSession> {
    const identity = await this.identity();
    const stamp = now();
    const session: LocalUserSession = {
      session_id: randomId("session"),
      owner_agent_id: identity.agent_id,
      created_at: stamp,
      expires_at: new Date(Date.now() + (input.ttlMs ?? 8 * 60 * 60 * 1000)).toISOString(),
      last_seen_at: stamp,
      auth_method: input.authMethod ?? "local-owner-token",
      csrf_token_hash: randomId("csrf"),
      revoked_at: ""
    };
    const sessions = await this.sessions();
    sessions[session.session_id] = session;
    await this.saveSessions(sessions);
    await this.audit("session.create", identity.agent_id, { session_id: session.session_id, auth_method: session.auth_method });
    return session;
  }

  async requireSession(sessionId: string): Promise<LocalUserSession> {
    const sessions = await this.sessions();
    const session = sessions[sessionId];
    if (!session) throw new EdgeBookError("unauthorized", "Missing or unknown web session");
    if (session.revoked_at) throw new EdgeBookError("unauthorized", "Web session was revoked");
    if (Date.parse(session.expires_at) <= Date.now()) throw new EdgeBookError("unauthorized", "Web session expired");
    session.last_seen_at = now();
    sessions[sessionId] = session;
    await this.saveSessions(sessions);
    return session;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const sessions = await this.sessions();
    const session = sessions[sessionId];
    if (!session) return;
    session.revoked_at = now();
    sessions[sessionId] = session;
    await this.saveSessions(sessions);
    await this.audit("session.revoke", session.owner_agent_id, { session_id: sessionId });
  }

  async posts(): Promise<Record<string, EdgeBookPost>> {
    return readJson<Record<string, EdgeBookPost>>(this.file(POSTS_FILE), {});
  }

  async savePosts(posts: Record<string, EdgeBookPost>): Promise<void> {
    await writeJson(this.file(POSTS_FILE), posts);
  }

  async feedItems(): Promise<Record<string, FeedItem>> {
    return readJson<Record<string, FeedItem>>(this.file(FEED_FILE), {});
  }

  async saveFeedItems(items: Record<string, FeedItem>): Promise<void> {
    await writeJson(this.file(FEED_FILE), items);
  }

  async approvals(): Promise<Record<string, ApprovalRequest>> {
    return readJson<Record<string, ApprovalRequest>>(this.file(APPROVALS_FILE), {});
  }

  async saveApprovals(approvals: Record<string, ApprovalRequest>): Promise<void> {
    await writeJson(this.file(APPROVALS_FILE), approvals);
  }

  async contactMutes(): Promise<Record<string, ContactMute>> {
    return readJson<Record<string, ContactMute>>(this.file(CONTACT_MUTES_FILE), {});
  }

  async saveContactMutes(mutes: Record<string, ContactMute>): Promise<void> {
    await writeJson(this.file(CONTACT_MUTES_FILE), mutes);
  }

  async createApproval(input: {
    type: ApprovalRequest["type"];
    objectType: ApprovalRequest["object_type"];
    objectId: string;
    summary: string;
    riskLevel?: ApprovalRequest["risk_level"];
    requestedByAgentId?: string;
  }): Promise<ApprovalRequest> {
    const identity = await this.identity();
    const approval: ApprovalRequest = {
      approval_id: randomId("approval"),
      type: input.type,
      requested_by_agent_id: input.requestedByAgentId || identity.agent_id,
      object_type: input.objectType,
      object_id: input.objectId,
      summary: input.summary,
      risk_level: input.riskLevel || "medium",
      status: "pending",
      created_at: now(),
      resolved_at: "",
      resolved_by: "",
      audit_refs: []
    };
    const approvals = await this.approvals();
    approvals[approval.approval_id] = approval;
    await this.saveApprovals(approvals);
    approval.audit_refs.push(await this.audit("approval.create", approval.requested_by_agent_id, { approval_id: approval.approval_id, type: approval.type }));
    approvals[approval.approval_id] = approval;
    await this.saveApprovals(approvals);
    return approval;
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRequest> {
    const approvals = await this.approvals();
    const approval = approvals[approvalId];
    if (!approval) throw new EdgeBookError("unknown_approval", `Unknown approval: ${approvalId}`);
    if (approval.status !== "pending") throw new EdgeBookError("approval_resolved", `Approval already ${approval.status}`);
    approval.status = approved ? "approved" : "rejected";
    approval.resolved_at = now();
    approval.resolved_by = "local-owner";
    approvals[approvalId] = approval;
    approval.audit_refs.push(await this.audit("approval.resolve", approval.requested_by_agent_id, { approval_id: approvalId, approved }));
    approvals[approvalId] = approval;
    await this.saveApprovals(approvals);
    return approval;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Agent → human escalation (ea-claude-094). Raise → surface → answer →
  // route-back, mirroring the friend-request loop. Remote raises are gated on
  // friend-state + an `escalation.raise` grant (fail closed), exactly like
  // sendPrivilegedMessage. Local raises (asking your own human) need no grant.
  // ──────────────────────────────────────────────────────────────────────

  async escalations(): Promise<Record<string, Escalation>> {
    return readJson<Record<string, Escalation>>(this.file(ESCALATIONS_FILE), {});
  }

  async saveEscalations(escalations: Record<string, Escalation>): Promise<void> {
    await writeJson(this.file(ESCALATIONS_FILE), escalations);
  }

  private async putEscalation(escalation: Escalation): Promise<void> {
    const all = await this.escalations();
    all[escalation.escalation_id] = escalation;
    await this.saveEscalations(all);
  }

  // Raise an escalation. Omit `to` to ask your own human (local — no envelope).
  // Pass `to` (a friend's agent_id) to ask their human — returns a signed
  // `escalation` envelope the caller delivers over the mailbox.
  async raiseEscalation(input: {
    kind: EscalationKind;
    subject: string;
    body: string;
    options?: string[];
    collaborators?: string[];
    contextRefs?: string[];
    riskLevel?: Escalation["risk_level"];
    to?: string;
    ttlMs?: number;
  }): Promise<{ escalation: Escalation; envelope?: MessageEnvelope }> {
    const identity = await this.identity();
    const ttlMs = input.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // default 7d (mailbox TTL)
    const escalation: Escalation = {
      escalation_id: randomId("esc"),
      raised_by_agent_id: identity.agent_id,
      collaborators: input.collaborators ?? [],
      to_human_owner_id: "",
      kind: input.kind,
      subject: input.subject,
      body: input.body,
      options: input.options ?? [],
      context_refs: input.contextRefs ?? [],
      status: "pending",
      risk_level: input.riskLevel ?? "medium",
      created_at: now(),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      answer_text: "",
      answer_choice: "",
      answered_at: "",
      answered_by: "",
      audit_refs: [],
    };

    if (!input.to) {
      // Local: this agent asks its own owner.
      escalation.to_human_owner_id = identity.owner_label || identity.agent_id;
      escalation.audit_refs.push(await this.audit("escalation.raise", identity.agent_id, { escalation_id: escalation.escalation_id, kind: escalation.kind, local: true }));
      await this.putEscalation(escalation);
      return { escalation };
    }

    // Remote: ask a friend's human. Gate on friend-state + escalation.raise grant.
    const contacts = await this.contacts();
    const contact = contacts[input.to];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${input.to}`);
    if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked", `Peer ${input.to} is blocked`);
    if (contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Cannot escalate to relationship_state=${contact.relationship_state}`);
    }
    const grant = await this.findUsableGrant(input.to, "escalation.raise");
    if (!grant) throw new EdgeBookError("missing_grant", `No active escalation.raise grant for ${input.to}`);
    await this.assertGrantSignature(grant);

    const envelope = await this.signEnvelope({
      type: "escalation",
      to_agent_id: input.to,
      relationship_id: relationshipId(identity.agent_id, input.to),
      capability_id: grant.grant_id,
      ref: escalation.escalation_id,
      transport: "local",
      // Clone into the signed body — the local copy below mutates audit_refs,
      // which must not retroactively alter the signed payload.
      body: { escalation: structuredClone(escalation) } satisfies EscalationBody,
    });
    escalation.audit_refs.push(await this.audit("escalation.raise", input.to, { escalation_id: escalation.escalation_id, kind: escalation.kind, message_id: envelope.message_id }));
    await this.putEscalation(escalation); // requester keeps its own copy to track
    return { escalation, envelope };
  }

  // Receive a remote escalation, materialise it for this agent's human.
  async receiveEscalation(envelope: MessageEnvelope): Promise<Escalation> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "escalation") throw new EdgeBookError("wrong_message_type", "Expected escalation envelope");
    const contacts = await this.contacts();
    const contact = contacts[envelope.from_agent_id];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${envelope.from_agent_id}`);
    if (contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Cannot receive escalation from relationship_state=${contact.relationship_state}`);
    }
    const grants = await this.grants();
    const grant = grants[envelope.capability_id];
    if (!grant || grant.status !== "active" || grant.subject_agent_id !== envelope.from_agent_id || !grant.scopes.includes("escalation.raise")) {
      throw new EdgeBookError("missing_grant", "Escalation does not carry an active escalation.raise grant issued to sender");
    }
    await this.assertGrantSignature(grant);

    const identity = await this.identity();
    const body = envelope.body as unknown as EscalationBody;
    const incoming = body.escalation;
    if (incoming.raised_by_agent_id !== envelope.from_agent_id) {
      throw new EdgeBookError("agent_id_mismatch", "Escalation raised_by does not match sender");
    }
    // Re-stamp fields the receiver owns; keep the sender's id/content/options.
    const escalation: Escalation = {
      ...incoming,
      to_human_owner_id: identity.owner_label || identity.agent_id,
      status: "pending",
      answer_text: "",
      answer_choice: "",
      answered_at: "",
      answered_by: "",
      audit_refs: [],
    };
    escalation.audit_refs.push(await this.audit("escalation.receive", envelope.from_agent_id, { escalation_id: escalation.escalation_id, kind: escalation.kind }));
    await this.putEscalation(escalation);
    return escalation;
  }

  // The human answers. For a remote-origin escalation, returns an
  // `escalation_response` envelope to route back to the requesting agent.
  async answerEscalation(escalationId: string, input: { text?: string; choice?: string }): Promise<Escalation & { envelope?: MessageEnvelope }> {
    const identity = await this.identity();
    const all = await this.escalations();
    const escalation = all[escalationId];
    if (!escalation) throw new EdgeBookError("unknown_escalation", `Unknown escalation: ${escalationId}`);
    if (escalation.status !== "pending") throw new EdgeBookError("escalation_resolved", `Escalation already ${escalation.status}`);
    if ((escalation.kind === "decision" || escalation.kind === "approval") && escalation.options.length > 0) {
      if (!input.choice || !escalation.options.includes(input.choice)) {
        throw new EdgeBookError("invalid_option", `Answer must be one of the offered options: ${escalation.options.join(", ")}`);
      }
    }
    escalation.status = "answered";
    escalation.answer_text = input.text ?? "";
    escalation.answer_choice = input.choice ?? "";
    escalation.answered_at = now();
    escalation.answered_by = "local-owner";
    escalation.audit_refs.push(await this.audit("escalation.answer", escalation.raised_by_agent_id, { escalation_id: escalationId }));
    all[escalationId] = escalation;
    await this.saveEscalations(all);

    // Route back only if a *remote* agent raised this (we are answering on behalf
    // of our own human for someone else's request).
    let envelope: MessageEnvelope | undefined;
    if (escalation.raised_by_agent_id !== identity.agent_id) {
      envelope = await this.signEnvelope({
        type: "escalation_response",
        to_agent_id: escalation.raised_by_agent_id,
        relationship_id: relationshipId(identity.agent_id, escalation.raised_by_agent_id),
        capability_id: "",
        ref: escalationId,
        transport: "local",
        body: {
          escalation_id: escalationId,
          status: escalation.status,
          answer_text: escalation.answer_text,
          answer_choice: escalation.answer_choice,
          answered_at: escalation.answered_at,
        } satisfies EscalationResponseBody,
      });
    }
    return { ...escalation, envelope };
  }

  // The requesting agent applies a routed-back answer to its own copy.
  async applyEscalationResponse(envelope: MessageEnvelope): Promise<Escalation> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "escalation_response") throw new EdgeBookError("wrong_message_type", "Expected escalation_response envelope");
    const body = envelope.body as unknown as EscalationResponseBody;
    const all = await this.escalations();
    const escalation = all[body.escalation_id];
    if (!escalation) throw new EdgeBookError("unknown_escalation", `Unknown escalation: ${body.escalation_id}`);
    escalation.status = body.status;
    escalation.answer_text = body.answer_text;
    escalation.answer_choice = body.answer_choice;
    escalation.answered_at = body.answered_at;
    escalation.answered_by = "local-owner";
    escalation.audit_refs.push(await this.audit("escalation.response", envelope.from_agent_id, { escalation_id: body.escalation_id, status: body.status }));
    all[body.escalation_id] = escalation;
    await this.saveEscalations(all);
    return escalation;
  }

  // Sweep: pending escalations past their expiry become `expired`.
  async expireEscalations(): Promise<void> {
    const all = await this.escalations();
    let changed = false;
    for (const escalation of Object.values(all)) {
      if (escalation.status === "pending" && Date.parse(escalation.expires_at) <= Date.now()) {
        escalation.status = "expired";
        changed = true;
      }
    }
    if (changed) await this.saveEscalations(all);
  }

  async createPost(input: {
    kind?: EdgeBookPostKind;
    title: string;
    body: string;
    tags?: string[];
    visibility?: EdgeBookVisibility;
    sourceBasis?: EdgeBookPost["source_basis"];
    status?: EdgeBookPostStatus;
    replyOrHelpChannel?: string;
    expiresAt?: string;
  }): Promise<EdgeBookPost> {
    const identity = await this.identity();
    const stamp = now();
    const sourceBasis = input.sourceBasis || "human-authored";
    const requestedStatus = input.status || (sourceBasis === "agent-authored" ? "pending_approval" : "draft");
    const post: EdgeBookPost = {
      post_id: randomId("post"),
      author_agent_id: identity.agent_id,
      human_owner_id: identity.owner_label || identity.agent_id,
      kind: input.kind || "note",
      title: input.title,
      body: input.body,
      tags: input.tags || [],
      visibility: input.visibility || "private",
      source_basis: sourceBasis,
      status: requestedStatus,
      created_at: stamp,
      updated_at: stamp,
      published_at: requestedStatus === "published" ? stamp : "",
      expires_at: input.expiresAt || "",
      approval_ref: "",
      permissions_used: [],
      audit_refs: [],
      reply_or_help_channel: input.replyOrHelpChannel || ""
    };
    const posts = await this.posts();
    posts[post.post_id] = post;
    await this.savePosts(posts);
    if (post.status === "pending_approval") {
      const approval = await this.createApproval({
        type: "publish_post",
        objectType: "post",
        objectId: post.post_id,
        summary: `Publish ${post.visibility} post: ${post.title}`,
        riskLevel: post.visibility === "public_if_enabled" ? "high" : "medium"
      });
      post.approval_ref = approval.approval_id;
      posts[post.post_id] = post;
      await this.savePosts(posts);
    }
    post.audit_refs.push(await this.audit("post.create", identity.agent_id, { post_id: post.post_id, status: post.status, visibility: post.visibility }));
    posts[post.post_id] = post;
    await this.savePosts(posts);
    if (post.status === "published") await this.ensureLocalFeedItem(post);
    return post;
  }

  async approvePost(postId: string): Promise<EdgeBookPost> {
    const posts = await this.posts();
    const post = posts[postId];
    if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
    if (post.status === "removed") throw new EdgeBookError("removed_post", "Cannot approve a removed post");
    if (post.status === "expired") throw new EdgeBookError("expired_post", "Cannot approve an expired post");
    if (post.approval_ref) await this.resolveApproval(post.approval_ref, true);
    post.status = "published";
    post.source_basis = post.source_basis === "agent-authored" ? "human-approved" : post.source_basis;
    post.updated_at = now();
    post.published_at = post.published_at || post.updated_at;
    posts[postId] = post;
    await this.savePosts(posts);
    await this.ensureLocalFeedItem(post);
    post.audit_refs.push(await this.audit("post.approve", post.author_agent_id, { post_id: postId, visibility: post.visibility }));
    posts[postId] = post;
    await this.savePosts(posts);
    return post;
  }

  async editPost(postId: string, input: { title?: string; body?: string; tags?: string[]; visibility?: EdgeBookVisibility }): Promise<EdgeBookPost> {
    const posts = await this.posts();
    const post = posts[postId];
    if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
    if (post.status === "removed") throw new EdgeBookError("removed_post", "Cannot edit a removed post");
    if (input.title !== undefined) post.title = input.title;
    if (input.body !== undefined) post.body = input.body;
    if (input.tags !== undefined) post.tags = input.tags;
    if (input.visibility !== undefined) post.visibility = input.visibility;
    post.status = post.status === "published" ? "edited" : post.status;
    post.updated_at = now();
    post.audit_refs.push(await this.audit("post.edit", post.author_agent_id, { post_id: postId }));
    posts[postId] = post;
    await this.savePosts(posts);
    return post;
  }

  async removePost(postId: string, reason = "removed by local owner"): Promise<EdgeBookPost> {
    const posts = await this.posts();
    const post = posts[postId];
    if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
    post.status = "removed";
    post.updated_at = now();
    post.audit_refs.push(await this.audit("post.remove", post.author_agent_id, { post_id: postId, reason }));
    posts[postId] = post;
    await this.savePosts(posts);
    return post;
  }

  async expirePost(postId: string, reason = "expired"): Promise<EdgeBookPost> {
    const posts = await this.posts();
    const post = posts[postId];
    if (!post) throw new EdgeBookError("unknown_post", `Unknown post: ${postId}`);
    post.status = "expired";
    post.updated_at = now();
    post.audit_refs.push(await this.audit("post.expire", post.author_agent_id, { post_id: postId, reason }));
    posts[postId] = post;
    await this.savePosts(posts);
    return post;
  }

  async ensureLocalFeedItem(post: EdgeBookPost): Promise<FeedItem> {
    const identity = await this.identity();
    const items = await this.feedItems();
    const existing = Object.values(items).find((item) => item.post_id === post.post_id && item.origin_agent_id === identity.agent_id);
    if (existing) return existing;
    const item: FeedItem = {
      feed_item_id: randomId("feed"),
      post_id: post.post_id,
      origin_agent_id: identity.agent_id,
      origin_home: "local",
      relationship_id: "",
      visibility_checked_at: now(),
      delivery_route: "local",
      read_state: "unread",
      hidden: false,
      muted_reason: "",
      received_at: now(),
      audit_refs: []
    };
    item.audit_refs.push(await this.audit("feed.local_add", identity.agent_id, { feed_item_id: item.feed_item_id, post_id: post.post_id }));
    items[item.feed_item_id] = item;
    await this.saveFeedItems(items);
    return item;
  }

  async visiblePostsForPeer(peerAgentId: string): Promise<EdgeBookPost[]> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked", `Peer ${peerAgentId} is blocked`);
    if (contact.relationship_state !== "friend") throw new EdgeBookError("not_friend", `Feed denied for relationship_state=${contact.relationship_state}`);
    const grants = await this.grants();
    const grant = Object.values(grants).find((candidate) =>
      candidate.issuer_agent_id === identity.agent_id &&
      candidate.subject_agent_id === peerAgentId &&
      candidate.status === "active" &&
      candidate.scopes.includes("feed.read.friends") &&
      (!candidate.expires_at || Date.parse(candidate.expires_at) > Date.now())
    );
    if (!grant) throw new EdgeBookError("missing_grant", "No active feed.read.friends grant for peer");
    await this.assertGrantSignature(grant);
    const posts = Object.values(await this.posts());
    return posts
      .filter((post) => post.visibility === "friends" && ["published", "edited"].includes(post.status))
      .filter((post) => !post.expires_at || Date.parse(post.expires_at) > Date.now())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async importFeedPosts(peerAgentId: string, posts: EdgeBookPost[], route: FeedItem["delivery_route"] = "local"): Promise<FeedItem[]> {
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state !== "friend") throw new EdgeBookError("not_friend", `Cannot import feed from relationship_state=${contact.relationship_state}`);
    const items = await this.feedItems();
    const imported: FeedItem[] = [];
    for (const post of posts) {
      const existing = Object.values(items).find((item) => item.post_id === post.post_id && item.origin_agent_id === peerAgentId);
      if (existing) {
        imported.push(existing);
        continue;
      }
      const item: FeedItem = {
        feed_item_id: randomId("feed"),
        post_id: post.post_id,
        origin_agent_id: peerAgentId,
        origin_home: route === "relay" ? "relay" : "direct",
        relationship_id: relationshipId((await this.identity()).agent_id, peerAgentId),
        visibility_checked_at: now(),
        delivery_route: route,
        read_state: "unread",
        hidden: false,
        muted_reason: "",
        received_at: now(),
        audit_refs: []
      };
      item.audit_refs.push(await this.audit("feed.import_item", peerAgentId, { feed_item_id: item.feed_item_id, post_id: post.post_id, route }));
      items[item.feed_item_id] = item;
      imported.push(item);
    }
    await this.saveFeedItems(items);
    await this.audit("feed.import", peerAgentId, { count: imported.length, route });
    return imported;
  }

  async markFeedItemRead(feedItemId: string): Promise<FeedItem> {
    const items = await this.feedItems();
    const item = items[feedItemId];
    if (!item) throw new EdgeBookError("unknown_feed_item", `Unknown feed item: ${feedItemId}`);
    item.read_state = "read";
    item.audit_refs.push(await this.audit("feed.mark_read", item.origin_agent_id, { feed_item_id: feedItemId }));
    items[feedItemId] = item;
    await this.saveFeedItems(items);
    return item;
  }

  async hideFeedItem(feedItemId: string, reason = ""): Promise<FeedItem> {
    const items = await this.feedItems();
    const item = items[feedItemId];
    if (!item) throw new EdgeBookError("unknown_feed_item", `Unknown feed item: ${feedItemId}`);
    item.hidden = true;
    item.muted_reason = reason;
    item.audit_refs.push(await this.audit("feed.hide", item.origin_agent_id, { feed_item_id: feedItemId, reason }));
    items[feedItemId] = item;
    await this.saveFeedItems(items);
    return item;
  }

  async muteContact(peerAgentId: string, reason = ""): Promise<ContactMute> {
    const contacts = await this.contacts();
    if (!contacts[peerAgentId]) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    const mutes = await this.contactMutes();
    const mute: ContactMute = {
      peer_agent_id: peerAgentId,
      muted_at: now(),
      muted_reason: reason,
      audit_refs: []
    };
    mute.audit_refs.push(await this.audit("contact.mute", peerAgentId, { reason }));
    mutes[peerAgentId] = mute;
    await this.saveContactMutes(mutes);
    return mute;
  }

  async unmuteContact(peerAgentId: string): Promise<void> {
    const mutes = await this.contactMutes();
    if (!mutes[peerAgentId]) return;
    delete mutes[peerAgentId];
    await this.saveContactMutes(mutes);
    await this.audit("contact.unmute", peerAgentId, {});
  }

  async reviewLocalDataImport(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const objectCount = (key: string): number => {
      const value = data[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
      return Object.keys(value as Record<string, unknown>).length;
    };
    const audit = Array.isArray(data.audit) ? data.audit.length : 0;
    return {
      review_only: true,
      activates_remote_endpoints: false,
      counts: {
        contacts: objectCount("contacts"),
        grants: objectCount("grants"),
        sessions: objectCount("sessions"),
        posts: objectCount("posts"),
        feed_items: objectCount("feed_items"),
        approvals: objectCount("approvals"),
        contact_mutes: objectCount("contact_mutes"),
        audit
      }
    };
  }

  async exportLocalData(): Promise<Record<string, unknown>> {
    return {
      identity: await this.identity(),
      contacts: await this.contacts(),
      grants: await this.grants(),
      sessions: await this.sessions(),
      posts: await this.posts(),
      feed_items: await this.feedItems(),
      approvals: await this.approvals(),
      contact_mutes: await this.contactMutes(),
      audit: await this.auditEvents()
    };
  }
}

export function validateCard(card: AgentCard): void {
  if (card.schema !== "openclaw-agent-card/0.1") throw new EdgeBookError("invalid_card", "Unsupported Agent Card schema");
  if (!card.agent_id || !card.public_keys?.[0]?.public_key_pem) throw new EdgeBookError("invalid_card", "Agent Card is missing identity key");
  const expectedId = stableIdFromPublicKey(card.public_keys[0].public_key_pem);
  if (card.agent_id !== expectedId) throw new EdgeBookError("invalid_card", "Agent Card agent_id does not match public key");
  if (!verifyPayload(withoutSignature(card), card.signature, card.public_keys[0].public_key_pem)) {
    throw new EdgeBookError("invalid_card", "Agent Card signature is invalid");
  }
}

// Structural + signature validation against a known public key (the peer's card
// key). Throws EdgeBookError on any failure. The agent_id<->sender match is
// checked by the caller (it has the envelope's from_agent_id).
export function validateFriendProfile(profile: FriendProfile, publicKeyPem: string): void {
  if (profile.schema !== "openclaw-friend-profile/0.1") {
    throw new EdgeBookError("invalid_friend_profile", "Unsupported FriendProfile schema");
  }
  if (!profile.agent_id) throw new EdgeBookError("invalid_friend_profile", "FriendProfile missing agent_id");
  if (typeof profile.profile_version !== "number") {
    throw new EdgeBookError("invalid_friend_profile", "FriendProfile missing profile_version");
  }
  if (!verifyPayload(withoutSignature(profile), profile.signature, publicKeyPem)) {
    throw new EdgeBookError("invalid_friend_profile", "FriendProfile signature is invalid");
  }
}

export async function loadCard(cardPathOrUrl: string): Promise<AgentCard> {
  // "Add me" invite link: edgebook:invite:<base64url(signed Agent Card)>.
  if (cardPathOrUrl.startsWith("edgebook:invite:")) {
    const encoded = cardPathOrUrl.slice("edgebook:invite:".length);
    const card = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AgentCard;
    validateCard(card);
    return card;
  }
  if (/^https?:\/\//.test(cardPathOrUrl)) {
    const response = await fetch(cardPathOrUrl);
    if (!response.ok) throw new EdgeBookError("card_fetch_failed", `Failed to fetch card: ${response.status}`);
    const card = await response.json() as AgentCard;
    validateCard(card);
    return card;
  }
  const filePath = cardPathOrUrl.startsWith("file://") ? new URL(cardPathOrUrl) : path.resolve(cardPathOrUrl);
  const card = JSON.parse(await fs.readFile(filePath, "utf8")) as AgentCard;
  validateCard(card);
  return card;
}

export async function runTwoAgentHarness(baseDir?: string): Promise<Record<string, unknown>> {
  const root = baseDir || await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent", ownerLabel: "Alice" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent", ownerLabel: "Bob" });
  await alice.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.setProfile({ name: "Bob", bio: "Bob bio" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();

  const request = await alice.createFriendRequest(bobCard, "test harness request");

  let deniedBeforeAccept = false;
  try {
    await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "too soon" });
  } catch (error) {
    deniedBeforeAccept = (error as EdgeBookError).code === "not_friend";
  }

  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const aliceFollowUp = await alice.applyFriendResponse(accept);
  if (aliceFollowUp) await bob.receiveProfileShare(aliceFollowUp);
  const message = await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "hello Bob" });
  await bob.receivePrivilegedMessage(message);

  let replayDenied = false;
  try {
    await bob.receivePrivilegedMessage(message);
  } catch (error) {
    replayDenied = (error as EdgeBookError).code === "replay";
  }

  await bob.revoke(aliceCard.agent_id);
  let revokedDenied = false;
  try {
    await bob.receivePrivilegedMessage(await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "after revoke" }));
  } catch (error) {
    revokedDenied = ["not_friend", "replay", "missing_grant"].includes((error as EdgeBookError).code);
  }

  await bob.setRelationship(aliceCard.agent_id, "friend", "Accept", "reset for block test");
  await bob.block(aliceCard.agent_id);
  let blockedDenied = false;
  try {
    await bob.receivePrivilegedMessage(await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "after block" }));
  } catch (error) {
    blockedDenied = (error as EdgeBookError).code === "not_friend";
  }

  const rotatedBobCard = await bob.writeCard();
  await alice.upsertContactFromCard(rotatedBobCard);
  const aliceContacts = await alice.contacts();
  const bobAudit = await bob.auditEvents();

  const aliceSeesBob = (await alice.contacts())[bobCard.agent_id].friend_profile?.name === "Bob";
  const bobSeesAlice = (await bob.contacts())[aliceCard.agent_id].friend_profile?.name === "Alice";

  const assertions = {
    deniedBeforeAccept,
    replayDenied,
    revokedDenied,
    blockedDenied,
    aliceHasBobContact: Boolean(aliceContacts[bobCard.agent_id]),
    bobAuditWritten: bobAudit.length > 0,
    profileExchange: aliceSeesBob && bobSeesAlice,
  };
  const passed = Object.values(assertions).every(Boolean);
  if (!passed) throw new EdgeBookError("harness_failed", `Harness failed: ${JSON.stringify(assertions)}`);
  return { passed, root, assertions };
}

export async function runFeedPrivacyHarness(baseDir?: string): Promise<Record<string, unknown>> {
  const root = baseDir || await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-feed-privacy-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const charlie = new EdgeBookStore({ home: path.join(root, "charlie") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent", ownerLabel: "Alice" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent", ownerLabel: "Bob" });
  await charlie.init({ handle: "charlie.openclaw.local", displayName: "Charlie Agent", ownerLabel: "Charlie" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const charlieCard = await charlie.writeCard();

  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard, "feed privacy harness"));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  await alice.issueGrant(bobCard.agent_id, ["feed.read.friends"]);

  await alice.upsertContactFromCard(charlieCard, "none");
  const friendPost = await alice.createPost({
    kind: "working_on",
    title: "Friend visible update",
    body: "Only accepted friends with feed grants should see this.",
    visibility: "friends",
    status: "published"
  });

  const allowedPosts = await alice.visiblePostsForPeer(bobCard.agent_id);
  const bobImported = await bob.importFeedPosts(aliceCard.agent_id, allowedPosts, "local");
  const friendAllowed = allowedPosts.some((post) => post.post_id === friendPost.post_id) && bobImported.some((item) => item.post_id === friendPost.post_id);

  let nonFriendDenied = false;
  let nonFriendCode = "";
  try {
    await alice.visiblePostsForPeer(charlieCard.agent_id);
  } catch (error) {
    nonFriendCode = (error as EdgeBookError).code;
    nonFriendDenied = nonFriendCode === "not_friend";
  }

  await alice.revoke(bobCard.agent_id);
  let revokedFeedDenied = false;
  let revokedFeedCode = "";
  try {
    await alice.visiblePostsForPeer(bobCard.agent_id);
  } catch (error) {
    revokedFeedCode = (error as EdgeBookError).code;
    revokedFeedDenied = revokedFeedCode === "not_friend";
  }

  await alice.setRelationship(bobCard.agent_id, "friend", "Accept", "reset for block test");
  await alice.issueGrant(bobCard.agent_id, ["feed.read.friends"]);
  await alice.block(bobCard.agent_id);
  let blockedFeedDenied = false;
  let blockedFeedCode = "";
  try {
    await alice.visiblePostsForPeer(bobCard.agent_id);
  } catch (error) {
    blockedFeedCode = (error as EdgeBookError).code;
    blockedFeedDenied = blockedFeedCode === "blocked" || blockedFeedCode === "not_friend";
  }

  let blockedMessageDenied = false;
  let blockedMessageCode = "";
  try {
    await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "blocked message" });
  } catch (error) {
    blockedMessageCode = (error as EdgeBookError).code;
    blockedMessageDenied = blockedMessageCode === "blocked" || blockedMessageCode === "not_friend";
  }

  let blockedRequestDenied = false;
  let blockedRequestCode = "";
  try {
    await alice.createFriendRequest(bobCard, "blocked request");
  } catch (error) {
    blockedRequestCode = (error as EdgeBookError).code;
    blockedRequestDenied = blockedRequestCode === "blocked_peer";
  }

  let blockedRefreshDenied = false;
  let blockedRefreshCode = "";
  try {
    await alice.upsertContactFromCard(bobCard);
  } catch (error) {
    blockedRefreshCode = (error as EdgeBookError).code;
    blockedRefreshDenied = blockedRefreshCode === "blocked_peer";
  }

  const assertions = {
    friendAllowed,
    nonFriendDenied,
    revokedFeedDenied,
    blockedFeedDenied,
    blockedMessageDenied,
    blockedRequestDenied,
    blockedRefreshDenied
  };
  const passed = Object.values(assertions).every(Boolean);
  const denial_codes = {
    nonFriend: nonFriendCode,
    revokedFeed: revokedFeedCode,
    blockedFeed: blockedFeedCode,
    blockedMessage: blockedMessageCode,
    blockedRequest: blockedRequestCode,
    blockedRefresh: blockedRefreshCode
  };
  if (!passed) throw new EdgeBookError("harness_failed", `Feed privacy harness failed: ${JSON.stringify({ assertions, denial_codes })}`);
  return {
    passed,
    root,
    posts_visible_to_bob: allowedPosts.map((post) => post.post_id),
    bob_feed_items: bobImported.map((item) => item.feed_item_id),
    denial_codes,
    assertions
  };
}
