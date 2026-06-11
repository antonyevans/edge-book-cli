// Shared type definitions for the Edge Book agent (extracted verbatim from
// edge-book.ts, 2026-06-09 legibility refactor — no shape changes).
//
// CONTRACT-FROZEN TYPES — do not rename or reshape:
// Several shapes here mirror the canonical contracts in the HOST repo
// (edge-book-host/src/contracts.ts + docs/wire-protocol.md). The two repos do
// NOT share code; they stay in sync by spec reference only, so a rename here
// silently breaks the other side. Frozen: SharedObject, CapabilityGrant (the
// CLI's Contract-2 grant model), MessageEnvelope and every *Body envelope
// payload, and all persisted-to-disk shapes (these serialize verbatim into the
// agent home directory and into signed payloads — changing a field name
// invalidates existing data and signatures).

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
  // Host-provided notify command (ea-claude-125). When set, the dial-out runs it
  // on each notifiable inbound envelope, delivering the message via stdin/env.
  // Edge Book stays transport-free — the command owns the channel. May also be
  // supplied via --notify-cmd flag or EDGE_BOOK_NOTIFY_CMD env (flag > env > config).
  notify_cmd?: string;
  // Optional whitelist of inbound kinds to notify on. When set, only these kinds
  // produce a notification; when unset, all registered notify policies apply.
  notify_types?: string[];
  // Abuse floor. open_friend_requests default true (treat undefined as true):
  // accept unsolicited friend requests. false => invite-only (drop unsolicited
  // requests that carry no valid invite code and have no prior relationship).
  open_friend_requests?: boolean;
  // Inbound throttle (per peer and global) for friend_request + object_share.
  // Defaults applied in code when unset.
  inbound_max_per_peer?: number;   // default 5
  inbound_max_global?: number;     // default 60
  inbound_window_ms?: number;      // default 3600000 (1h)
  // Epoch ms when the one-time handle nudge (spec-130) was emitted. Set once,
  // never cleared — even if the human declines, the nudge must not repeat.
  handle_nudge_at?: number;
  // spec-132 greeter. greeter_mode gates `friend auto-accept` and the greeter
  // cron install — absent/false = off; normal agents can never auto-accept.
  greeter_mode?: boolean;
  // Set once by the greeter's first welcome pass (store-greeter.ts): the single
  // shared welcome object every newly accepted friend is granted to read.
  greeter_welcome_object_id?: string;
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
  invite_code?: string; // present when the requester used an invite link carrying a code
}

// ── Generic inbound notifications (ea-claude-125) ──────────────────────────
// Edge Book stays transport-free: it renders a transport-agnostic intent describing
// "notify the human", and an entry point (dial-out, server) delivers it via a
// host-provided notify command. A per-type registry decides notify-vs-silent and
// renders the message — adding a new inbound format = one registry row.
export interface NotificationIntent {
  kind: string;            // envelope.type
  message: string;         // pre-rendered, human-readable, safe to display
  from_id: string;         // envelope.from_agent_id
  from_name?: string;      // resolved display_name (best-effort)
  dedup_key: string;       // stable per logical notification (default: message_id)
  meta?: Record<string, string>; // extra type-specific fields for the host command env
}

export interface ReportRecord {
  report_id: string;
  peer_agent_id: string;
  reason: string;
  blocked: boolean;
  created_at: string;
  audit_refs: string[];
}

export interface InviteCode {
  code: string;
  created_at: string;
  expires_at: string; // "" = no expiry
  max_uses: number;   // 0 = unlimited
  uses: number;
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
