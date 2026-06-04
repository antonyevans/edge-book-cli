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
}

export interface LocalIdentity {
  agent_id: string;
  handle: string;
  display_name: string;
  owner_label: string;
  public_key_pem: string;
  private_key_pem: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCard {
  schema: "openclaw-agent-card/0.1";
  agent_id: string;
  handle: string;
  display_name: string;
  card_url: string;
  card_version: number;
  card_hash: string;
  public_keys: Array<{ id: string; type: "ed25519"; public_key_pem: string }>;
  capabilities: string[];
  transports: Array<{ mode: TransportMode; endpoint: string }>;
  refresh_after: string;
  expires_at: string;
  signature: string;
}

export interface AgentContactRecord {
  peer_agent_id: string;
  aliases: string[];
  display_name: string;
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

export interface ObjectRevokeBody {
  object_id: string;
  grant_id: string;
}

export interface MessageEnvelope {
  message_id: string;
  type: "friend_request" | "friend_response" | "privileged_message" | "ack" | "error" | "object_share" | "object_revoke";
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
  reason: string;
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
const CONTACT_MUTES_FILE = "contact-mutes.json";

export function resolveHome(home?: string): string {
  if (home?.trim()) return path.resolve(home.trim());
  if (process.env.EDGE_BOOK_HOME?.trim()) return path.resolve(process.env.EDGE_BOOK_HOME.trim());
  return path.join(os.homedir(), ".openclaw", "edge-book");
}

function now(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

function stableIdFromPublicKey(publicKeyPem: string): string {
  const digest = crypto.createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 32);
  return `did:openclaw:${digest}`;
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

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
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

async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (mode !== undefined) await chmodBestEffort(file, mode);
}

async function appendJsonl(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function relationshipId(a: string, b: string): string {
  return `rel_${crypto.createHash("sha256").update([a, b].sort().join("|")).digest("base64url").slice(0, 24)}`;
}

export class EdgeBookStore {
  home: string;

  constructor(options: EdgeBookOptions = {}) {
    this.home = resolveHome(options.home);
  }

  file(name: string): string {
    return path.join(this.home, name);
  }

  async init(input: { handle?: string; displayName?: string; ownerLabel?: string; cardUrl?: string; directUrl?: string; relayUrl?: string } = {}): Promise<LocalIdentity> {
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

  async config(): Promise<EdgeBookConfig> {
    return readJson<EdgeBookConfig>(this.file(CONFIG_FILE), {});
  }

  async updateConfig(input: EdgeBookConfig): Promise<EdgeBookConfig> {
    const current = await this.config();
    const next: EdgeBookConfig = { ...current };
    if (input.direct_url !== undefined) next.direct_url = input.direct_url;
    if (input.relay_url !== undefined) next.relay_url = input.relay_url;
    await writeJson(this.file(CONFIG_FILE), next);
    return next;
  }

  async buildCard(cardUrl?: string): Promise<AgentCard> {
    const identity = await this.identity();
    const config = await this.config();
    const transports: AgentCard["transports"] = [{ mode: "local", endpoint: this.home }];
    if (config.direct_url) transports.push({ mode: "direct", endpoint: config.direct_url });
    if (config.relay_url) transports.push({ mode: "relay", endpoint: config.relay_url });
    const unsigned: Omit<AgentCard, "card_hash" | "signature"> = {
      schema: "openclaw-agent-card/0.1",
      agent_id: identity.agent_id,
      handle: identity.handle,
      display_name: identity.display_name,
      card_url: cardUrl || `file://${this.file(CARD_FILE)}`,
      card_version: 1,
      public_keys: [{ id: `${identity.agent_id}#main`, type: "ed25519", public_key_pem: identity.public_key_pem }],
      capabilities: ["friend_request", "friend_gated_message", "feed_read_friends"],
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

  async acceptFriend(peerAgentId: string, reason = "accepted"): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot accept a blocked peer");
    await this.setRelationship(peerAgentId, "friend", "Accept", reason);
    const grant = await this.issueGrant(peerAgentId, ["message.friend", "feed.read.friends"]);
    const card = await this.writeCard();
    return this.signEnvelope({
      type: "friend_response",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: grant.grant_id,
      ref: "",
      transport: "local",
      body: { accepted: true, card, grant, reason } satisfies FriendResponseBody
    });
  }

  async applyFriendResponse(envelope: MessageEnvelope): Promise<void> {
    await this.verifyEnvelope(envelope);
    if (envelope.type !== "friend_response") throw new EdgeBookError("wrong_message_type", "Expected friend_response envelope");
    const body = envelope.body as unknown as FriendResponseBody;
    validateCard(body.card);
    if (body.card.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Friend response card does not match sender");
    await this.upsertContactFromCard(body.card, body.accepted ? "friend" : "rejected");
    await this.setRelationship(envelope.from_agent_id, body.accepted ? "friend" : "rejected", body.accepted ? "Accept" : "Reject", body.reason);
    if (body.grant) await this.storeGrant(body.grant);
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
    if (contact.relationship_state !== "friend") {
      throw new EdgeBookError("not_friend", `Cannot send friend-gated message to relationship_state=${contact.relationship_state}`);
    }
    const grant = await this.findUsableGrant(peerAgentId, scope);
    if (!grant) throw new EdgeBookError("missing_grant", `No active grant for ${scope}`);
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
    return Object.values(grants).some((grant) =>
      grant.object_id === objectId &&
      grant.subject_agent_id === subjectAgentId &&
      grant.scopes.includes("object.read") &&
      grant.status === "active" &&
      (!grant.expires_at || Date.parse(grant.expires_at) > at)
    );
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

  async receiveEnvelope(envelope: MessageEnvelope): Promise<void | AgentContactRecord> {
    if (envelope.type === "friend_request") return this.receiveFriendRequest(envelope);
    if (envelope.type === "friend_response") return this.applyFriendResponse(envelope);
    if (envelope.type === "privileged_message") return this.receivePrivilegedMessage(envelope);
    if (envelope.type === "object_share") { await this.receiveObjectShare(envelope); return; }
    if (envelope.type === "object_revoke") { await this.receiveObjectRevoke(envelope); return; }
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

export async function loadCard(cardPathOrUrl: string): Promise<AgentCard> {
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
  await alice.applyFriendResponse(accept);
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

  const assertions = {
    deniedBeforeAccept,
    replayDenied,
    revokedDenied,
    blockedDenied,
    aliceHasBobContact: Boolean(aliceContacts[bobCard.agent_id]),
    bobAuditWritten: bobAudit.length > 0
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
    blockedFeedDenied = blockedFeedCode === "not_friend";
  }

  let blockedMessageDenied = false;
  let blockedMessageCode = "";
  try {
    await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "blocked message" });
  } catch (error) {
    blockedMessageCode = (error as EdgeBookError).code;
    blockedMessageDenied = blockedMessageCode === "not_friend";
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
