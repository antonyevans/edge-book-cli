import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// All shared type definitions (and EdgeBookError) live in types.ts; this file
// re-exports them so existing importers of "./edge-book.ts" keep working.
export * from "./types.ts";
export { resolveHome, randomId, readJson, writeJson } from "./fs-json.ts";
export { isValidHandle, slugifyHandle } from "./handles.ts";
export { contentHash } from "./crypto.ts";
export { defaultProfile, resolveFieldVisibility, resolveSocialVisibility } from "./profile.ts";
import { resolveHome, randomId, readJson, writeJson, now, ensureHome, chmodBestEffort, appendJsonl, readJsonl } from "./fs-json.ts";
import { isValidHandle, slugifyHandle } from "./handles.ts";
import { contentHash, stableIdFromPublicKey, canonicalize, withoutSignature, signPayload, verifyPayload, relationshipId } from "./crypto.ts";
import { defaultProfile, resolveFieldVisibility, resolveSocialVisibility, projectProfileFields } from "./profile.ts";
export { validateCard, validateFriendProfile, loadCard } from "./cards.ts";
export { runTwoAgentHarness, runFeedPrivacyHarness } from "./harness.ts";
import { validateCard, validateFriendProfile, loadCard } from "./cards.ts";
import { attestations, saveAttestations, saveEndorsements, saveSignals, saveCapabilities, createAttestation, verifyAttestation, verifyCapability, verifyEphemeral, verifyAnswer, verifySignal, verifyEndorsement, endorsements, createEndorsement, signals, createSignal, expireSignals, saveEphemeral, ephemeralPosts, createEphemeral, expireEphemeral, cancelEphemeral, saveAnswers, answers, createAnswer, deleteQuery, capabilities, advertiseCapability, deprecateCapability, receivedPosts, saveReceivedPosts, receivedByCategory, receivePostPublish, signPostPublishEnvelope } from "./store-taxonomy.ts";
import { objects, saveObjects, getObject, createObject, issueObjectGrant, canReadObject, readObject, readAttachmentBytes, sharedObjectsFor, shareObjectEnvelope, receiveObjectShare, revokeObjectGrant, revokeObjectEnvelope, receiveObjectRevoke } from "./store-objects.ts";
import { posts, savePosts, feedItems, saveFeedItems, approvals, saveApprovals, contactMutes, saveContactMutes, createApproval, resolveApproval, createPost, approvePost, editPost, removePost, expirePost, ensureLocalFeedItem, visiblePostsForPeer, importFeedPosts, markFeedItemRead, hideFeedItem, muteContact, unmuteContact } from "./store-posts.ts";
import { escalations, saveEscalations, raiseEscalation, receiveEscalation, answerEscalation, applyEscalationResponse, expireEscalations } from "./store-escalations.ts";
import { upsertContactFromCard, setRelationship, createFriendRequest, receiveFriendRequest, pendingFriendRequests, markFriendRequestNotified, acceptFriend, rejectFriend, applyFriendResponse, buildProfileShareEnvelope, receiveProfileShare, broadcastProfileEnvelopes, revoke, block, reports, inviteCodes, mintInviteCode, reportPeer } from "./store-friends.ts";
import { IDENTITY_FILE, CONTACTS_FILE, GRANTS_FILE, OBJECTS_FILE, ATTACHMENTS_DIR, SEEN_MESSAGES_FILE, CONFIG_FILE, RELATIONSHIP_EVENTS_FILE, MESSAGES_FILE, AUDIT_FILE, INBOX_FILE, CARD_FILE, SESSIONS_FILE, POSTS_FILE, FEED_FILE, APPROVALS_FILE, NOTIFIED_FILE, ESCALATIONS_FILE, CONTACT_MUTES_FILE, REPORTS_FILE, INVITE_CODES_FILE, INBOUND_RATE_FILE, ATTESTATIONS_FILE, ENDORSEMENTS_FILE, SIGNALS_FILE, CAPABILITIES_FILE, EPHEMERAL_FILE, ANSWERS_FILE, RECEIVED_POSTS_FILE, DEFAULT_SIGNAL_TTL_MS, DEFAULT_EPHEMERAL_TTL_MS } from "./store-files.ts";
import { EPHEMERAL_TTL_POLICY, EdgeBookError, POST_TAXONOMY, classOf } from "./types.ts";
import type { RelationshipState, TransportMode, EdgeBookOptions, EdgeBookConfig, LocalIdentity, FieldVisibility, SocialLink, IdentityProfile, FriendProfile, AgentCard, AgentContactRecord, RelationshipEvent, CapabilityGrant, SharedObjectAttachment, SharedObject, ObjectShareBody, ResultAttestation, StrongRef, Endorsement, Signal, EphemeralType, EphemeralPost, Answer, ReceivedPost, CapabilityAdvertisement, ObjectRevokeBody, MessageEnvelope, FriendRequestBody, NotificationIntent, ReportRecord, InviteCode, FriendResponseBody, ProfileShareBody, EdgeBookVisibility, EdgeBookPostStatus, EdgeBookPostKind, LocalUserSession, EdgeBookPost, FeedItem, ApprovalRequest, EscalationKind, EscalationStatus, Escalation, EscalationBody, EscalationResponseBody, ContactMute, PostType } from "./types.ts";


type NotifyPolicy = (
  env: MessageEnvelope,
  store: EdgeBookStore,
) => Promise<NotificationIntent | null>; // null = silent

// Resolve a peer's display name from local contacts, falling back to the agent id.
async function peerName(store: EdgeBookStore, agentId: string): Promise<string | undefined> {
  return (await store.contacts())[agentId]?.display_name || undefined;
}

const NOTIFY_POLICIES: Partial<Record<MessageEnvelope["type"], NotifyPolicy>> = {
  friend_request: async (env, store) => {
    // Honour the per-type opt-out (default ON: treat undefined as enabled).
    if ((await store.config()).notify_on_friend_request === false) return null;
    const body = env.body as unknown as FriendRequestBody;
    const name = body.card?.display_name || env.from_agent_id;
    const note = body.note ? ` — “${body.note}”` : "";
    return {
      kind: "friend_request",
      from_id: env.from_agent_id,
      from_name: body.card?.display_name,
      message: `${name} wants to connect on Edge Book${note}. Reply “yes” to connect, or ignore to leave it pending.`,
      dedup_key: env.message_id,
    };
  },
  privileged_message: async (env, store) => {
    const body = env.body as { text?: unknown };
    const name = (await peerName(store, env.from_agent_id)) || env.from_agent_id;
    const text = typeof body.text === "string" ? body.text : "";
    const preview = text.length > 280 ? `${text.slice(0, 279)}…` : text;
    return {
      kind: "privileged_message",
      from_id: env.from_agent_id,
      from_name: await peerName(store, env.from_agent_id),
      message: `${name}: ${preview}`,
      dedup_key: env.message_id,
    };
  },
  friend_response: async (env) => {
    const body = env.body as unknown as FriendResponseBody;
    const name = body.card?.display_name || env.from_agent_id;
    const verb = body.accepted ? "accepted" : "declined";
    return {
      kind: "friend_response",
      from_id: env.from_agent_id,
      from_name: body.card?.display_name,
      message: `${name} ${verb} your friend request on Edge Book.`,
      dedup_key: env.message_id,
    };
  },
  object_share: async (env, store) => {
    const body = env.body as unknown as ObjectShareBody;
    const name = (await peerName(store, env.from_agent_id)) || env.from_agent_id;
    const title = body.object?.request?.title || "an item";
    return {
      kind: "object_share",
      from_id: env.from_agent_id,
      from_name: await peerName(store, env.from_agent_id),
      message: `${name} shared a request: “${title}”.`,
      dedup_key: env.message_id,
    };
  },
  escalation: async (env) => {
    const body = env.body as unknown as EscalationBody;
    const esc = body.escalation;
    const opts = esc?.options?.length ? ` (options: ${esc.options.join(" / ")})` : "";
    return {
      kind: "escalation",
      from_id: env.from_agent_id,
      message: `${esc?.subject ?? "A decision is needed"} — ${esc?.body ?? ""}${opts}`,
      dedup_key: env.message_id,
    };
  },
};



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

  // Set a user-chosen unique handle. Re-signs the card; does NOT rotate keys.
  async setHandle(handle: string): Promise<LocalIdentity> {
    if (!isValidHandle(handle)) {
      throw new EdgeBookError("invalid_handle", `invalid_handle: must be 3-30 chars [a-z0-9-], not reserved: ${handle}`);
    }
    const identity = await this.identity();
    identity.handle = handle;
    identity.updated_at = now();
    await writeJson(this.file(IDENTITY_FILE), identity, 0o600);
    await this.writeCard();
    await this.audit("identity.set_handle", identity.agent_id, { handle });
    return identity;
  }

  // Portable identity bundle (the DID keypair + chosen handle). Carry to a new
  // device → same DID → relay handle keeps resolving to you (spec-096).
  async exportIdentity(): Promise<{ schema: "edge-book-identity-export/0.1"; identity: LocalIdentity }> {
    return { schema: "edge-book-identity-export/0.1", identity: await this.identity() };
  }

  async importIdentity(bundle: { identity: LocalIdentity }, opts: { force?: boolean } = {}): Promise<LocalIdentity> {
    await ensureHome(this.home);
    const existing = await readJson<LocalIdentity | null>(this.file(IDENTITY_FILE), null);
    if (existing && !opts.force) throw new EdgeBookError("identity_exists", `identity_exists: an identity already exists at ${this.home} (use --force to overwrite)`);
    const id = bundle.identity;
    if (!id?.public_key_pem || id.agent_id !== stableIdFromPublicKey(id.public_key_pem)) {
      throw new EdgeBookError("invalid_import", "Bundle agent_id does not match its public key");
    }
    await writeJson(this.file(IDENTITY_FILE), id, 0o600);
    if (!(await readJson<unknown | null>(this.file(CONTACTS_FILE), null))) await writeJson(this.file(CONTACTS_FILE), {});
    if (!(await readJson<unknown | null>(this.file(GRANTS_FILE), null))) await writeJson(this.file(GRANTS_FILE), {});
    if (!(await readJson<unknown | null>(this.file(SEEN_MESSAGES_FILE), null))) await writeJson(this.file(SEEN_MESSAGES_FILE), []);
    await this.writeCard();
    await this.audit("identity.import", id.agent_id, { handle: id.handle });
    return id;
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
    if (input.notify_cmd !== undefined) next.notify_cmd = input.notify_cmd;
    if (input.notify_types !== undefined) next.notify_types = input.notify_types;
    if (input.open_friend_requests !== undefined) next.open_friend_requests = input.open_friend_requests;
    if (input.inbound_max_per_peer !== undefined) next.inbound_max_per_peer = input.inbound_max_per_peer;
    if (input.inbound_max_global !== undefined) next.inbound_max_global = input.inbound_max_global;
    if (input.inbound_window_ms !== undefined) next.inbound_window_ms = input.inbound_window_ms;
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
    const publicFields = projectProfileFields(prof, (v) => v === "public");
    const publicProfile: NonNullable<AgentCard["public_profile"]> = { ...publicFields };
    const publicName = publicFields.name;
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

  // Build a signed handle claim for the relay registry (spec-096). The relay
  // verifies claim_sig + the card against the identity key before binding.
  async buildHandleClaim(): Promise<{ handle: string; agent_did: string; card: AgentCard; claimed_at: number; claim_sig: string }> {
    const identity = await this.identity();
    if (!isValidHandle(identity.handle)) {
      throw new EdgeBookError("invalid_handle", `invalid_handle: set a handle first (current: ${identity.handle})`);
    }
    const card = await loadCard(this.file(CARD_FILE)); // current signed card
    const claimed_at = Date.now();
    const claim_sig = signPayload({ handle: identity.handle, agent_did: identity.agent_id, claimed_at }, identity.private_key_pem);
    return { handle: identity.handle, agent_did: identity.agent_id, card, claimed_at, claim_sig };
  }

  // The friend-only profile: every field whose visibility resolves to "friends"
  // or "public". Signed; shared only with confirmed friends.
  async buildFriendProfile(): Promise<FriendProfile> {
    const identity = await this.identity();
    const profile = defaultProfile(identity);
    const friendFields = projectProfileFields(profile, (v) => v !== "off");
    const unsigned: Omit<FriendProfile, "signature"> = {
      schema: "openclaw-friend-profile/0.1",
      agent_id: identity.agent_id,
      profile_version: profile.profile_version ?? 1,
      ...friendFields,
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
    return upsertContactFromCard(this, card, state);
  }

  async setRelationship(peerAgentId: string, nextState: RelationshipState, type: RelationshipEvent["type"], reason = ""): Promise<RelationshipEvent> {
    return setRelationship(this, peerAgentId, nextState, type, reason);
  }

  async createFriendRequest(targetCard: AgentCard, note = "", inviteCode = ""): Promise<MessageEnvelope> {
    return createFriendRequest(this, targetCard, note, inviteCode);
  }

  // NOTE — concurrency + sybil-defense assumptions (v1):
  // The GLOBAL cap (inbound_max_global) is the real sybil defense: it limits total
  // inbound load regardless of how many distinct identities an attacker mints.
  // The per-peer cap only slows a single persistent identity; it provides weaker
  // protection because `from_agent_id` is attacker-mintable (any key can be generated).
  //
  // The rate file is read-modify-write.  This is safe under the assumption that the
  // receive loop is effectively serial for a single-owner edge agent (one active
  // session at a time).  Concurrent receives — e.g. two simultaneous HTTP deliveries
  // on a multi-machine deployment — could undercount hits, allowing bursts past the
  // cap.  A shared atomic lock or external counter store is the follow-up (ea-claude-090).
  // Internal — not part of the public store API. Non-private only so the
  // extracted store-* feature modules (which receive `store` as a parameter)
  // can apply the same inbound throttle as the in-class friend-request path.
  async enforceInboundRate(peerAgentId: string): Promise<void> {
    const config = await this.config();
    const windowMs = config.inbound_window_ms ?? 3_600_000;
    const maxPeer = config.inbound_max_per_peer ?? 5;
    const maxGlobal = config.inbound_max_global ?? 60;
    const cutoff = Date.now() - windowMs;
    const all = await readJson<Record<string, number[]>>(this.file(INBOUND_RATE_FILE), {});
    for (const k of Object.keys(all)) {
      all[k] = all[k].filter((t) => t > cutoff);
      if (!all[k].length) delete all[k];
    }
    const peerCount = (all[peerAgentId] ?? []).length;
    const globalCount = Object.values(all).reduce((n, arr) => n + arr.length, 0);
    if (peerCount >= maxPeer || globalCount >= maxGlobal) {
      await this.audit("inbound.rate_limited", peerAgentId, { peerCount, globalCount });
      throw new EdgeBookError("rate_limited", "Inbound request rate limit exceeded");
    }
    all[peerAgentId] = [...(all[peerAgentId] ?? []), Date.now()];
    await writeJson(this.file(INBOUND_RATE_FILE), all);
  }

  async receiveFriendRequest(envelope: MessageEnvelope): Promise<AgentContactRecord> {
    return receiveFriendRequest(this, envelope);
  }

  // Inbound friend requests the human hasn't been told about yet. Empty when the
  // agent has notifications disabled. Read-only — the notifier cron consumes this.
  async pendingFriendRequests(): Promise<AgentContactRecord[]> {
    return pendingFriendRequests(this);
  }

  // Stamp a request as notified so it won't surface again (idempotent sweep,
  // mirrors expireEscalations).
  async markFriendRequestNotified(peerAgentId: string): Promise<void> {
    return markFriendRequestNotified(this, peerAgentId);
  }

  async acceptFriend(peerAgentId: string, reason = "accepted"): Promise<MessageEnvelope> {
    return acceptFriend(this, peerAgentId, reason);
  }

  async rejectFriend(peerAgentId: string, reason = "rejected"): Promise<MessageEnvelope> {
    return rejectFriend(this, peerAgentId, reason);
  }

  async applyFriendResponse(envelope: MessageEnvelope): Promise<MessageEnvelope | null> {
    return applyFriendResponse(this, envelope);
  }

  // Persist a received FriendProfile onto the peer contact (last-writer-wins by
  // profile_version). Returns true if applied, false if stale.


  // Build a signed profile_share envelope carrying our current FriendProfile to a
  // confirmed friend.
  async buildProfileShareEnvelope(peerAgentId: string): Promise<MessageEnvelope> {
    return buildProfileShareEnvelope(this, peerAgentId);
  }

  async receiveProfileShare(envelope: MessageEnvelope): Promise<void> {
    return receiveProfileShare(this, envelope);
  }

  // Build a profile_share for every current friend (caller delivers them).
  async broadcastProfileEnvelopes(): Promise<MessageEnvelope[]> {
    return broadcastProfileEnvelopes(this);
  }

  async revoke(peerAgentId: string): Promise<void> {
    return revoke(this, peerAgentId);
  }

  async block(peerAgentId: string): Promise<void> {
    return block(this, peerAgentId);
  }

  async reports(): Promise<ReportRecord[]> {
    return reports(this);
  }

  async inviteCodes(): Promise<InviteCode[]> {
    return inviteCodes(this);
  }

  async mintInviteCode(opts: { ttlMs?: number; maxUses?: number } = {}): Promise<InviteCode> {
    return mintInviteCode(this, opts);
  }

  // NOTE — serial-receive assumption (v1):
  // consumeInviteCode is read-modify-write.  Under concurrent receives, two requests
  // carrying the same single-use code could both read uses=0, both pass the max_uses
  // check, and both increment — effectively spending the code twice.  This is safe for
  // a single-owner serial receive loop; a locking primitive is needed for concurrent
  // multi-machine deployments (ties to the same ea-claude-090 follow-up).


  async reportPeer(peerAgentId: string, reason = "", opts: { block?: boolean } = {}): Promise<ReportRecord> {
    return reportPeer(this, peerAgentId, reason, opts);
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
    return objects(this);
  }

  async saveObjects(objects: Record<string, SharedObject>): Promise<void> {
    return saveObjects(this, objects);
  }

  async getObject(objectId: string): Promise<SharedObject | undefined> {
    return getObject(this, objectId);
  }

  // Create one shared object (a request + at most one attachment). Signed and
  // stored locally; writes an `object.create` audit event.
  async createObject(input: {
    title: string;
    body: string;
    attachment?: { filename: string; mime: string; bytes: Buffer };
  }): Promise<SharedObject> {
    return createObject(this, input);
  }

  // ─── spec-0021 post-type store methods ──────────────────────────────────

  // Class 4: Result Attestation — content-addressed, write-once (R6)
  async attestations(): Promise<Record<string, ResultAttestation>> {
    return attestations(this);
  }

  async saveAttestations(attestations: Record<string, ResultAttestation>): Promise<void> {
    return saveAttestations(this, attestations);
  }

  async saveEndorsements(endorsements: Record<string, Endorsement>): Promise<void> {
    return saveEndorsements(this, endorsements);
  }

  async saveSignals(signals: Record<string, Signal>): Promise<void> {
    return saveSignals(this, signals);
  }

  async saveCapabilities(capabilities: Record<string, CapabilityAdvertisement>): Promise<void> {
    return saveCapabilities(this, capabilities);
  }

  async createAttestation(input: {
    subject_agent_id: string; task_ref: string;
    outcome: ResultAttestation["outcome"]; summary: string;
    evidence?: Record<string, unknown>; created_at?: string;
  }): Promise<ResultAttestation> {
    return createAttestation(this, input);
  }

  async verifyAttestation(att: ResultAttestation): Promise<boolean> {
    return verifyAttestation(this, att);
  }

  async verifyCapability(cap: CapabilityAdvertisement): Promise<boolean> {
    return verifyCapability(this, cap);
  }

  // Verify an EphemeralPost signature. lifecycle is NOT part of the signed payload
  // (it is mutable local metadata), so strip both signature and lifecycle before verify.
  async verifyEphemeral(post: EphemeralPost): Promise<boolean> {
    return verifyEphemeral(this, post);
  }

  // Verify an Answer signature. lifecycle is NOT part of the signed payload.
  async verifyAnswer(ans: Answer): Promise<boolean> {
    return verifyAnswer(this, ans);
  }

  // Verify a Signal signature. lifecycle is NOT part of the signed payload.
  async verifySignal(sig: Signal): Promise<boolean> {
    return verifySignal(this, sig);
  }

  // Verify an Endorsement signature. Endorsements have no lifecycle field.
  async verifyEndorsement(e: Endorsement): Promise<boolean> {
    return verifyEndorsement(this, e);
  }

  // Class 3: Endorse — actor-owned reified edge, strongRef parent, evidence link (R5, R8)
  async endorsements(): Promise<Record<string, Endorsement>> {
    return endorsements(this);
  }

  async createEndorsement(input: {
    subject_agent_id: string; parent: StrongRef; statement: string;
    evidence_ref?: StrongRef; evidence_task_id?: string;
  }): Promise<Endorsement> {
    return createEndorsement(this, input);
  }

  // Class 2: Signal — ephemeral, lifecycle + TTL (R4)


  async signals(): Promise<Record<string, Signal>> {
    return signals(this);
  }

  async createSignal(input: { body: string; ttlMs?: number }): Promise<Signal> {
    return createSignal(this, input);
  }

  async expireSignals(): Promise<void> {
    return expireSignals(this);
  }

  // Generic Class-2 ephemeral store (query/share/coordinate/delegation_request, R2/R4)
  async saveEphemeral(posts: Record<string, EphemeralPost>): Promise<void> {
    return saveEphemeral(this, posts);
  }

  async ephemeralPosts(): Promise<Record<string, EphemeralPost>> {
    return ephemeralPosts(this);
  }

  async createEphemeral(type: EphemeralType, input: { body: string; subject_agent_id?: string; ref?: string; ttlMs?: number }): Promise<EphemeralPost> {
    return createEphemeral(this, type, input);
  }

  async expireEphemeral(): Promise<void> {
    return expireEphemeral(this);
  }

  async cancelEphemeral(postId: string): Promise<EphemeralPost> {
    return cancelEphemeral(this, postId);
  }

  // Class 3: Answer — actor-owned, strongRef to a Query (R5)
  async saveAnswers(answers: Record<string, Answer>): Promise<void> {
    return saveAnswers(this, answers);
  }

  async answers(): Promise<Record<string, Answer>> {
    return answers(this);
  }

  async createAnswer(input: { parent: StrongRef; body: string }): Promise<Answer> {
    return createAnswer(this, input);
  }

  // R7: deleting a Query tombstones (archives) it AND its Answers — never hard-drops.
  async deleteQuery(queryId: string): Promise<void> {
    return deleteQuery(this, queryId);
  }

  // Class 1: Capability Advertisement — versioned, deprecate-not-delete (R3)
  async capabilities(): Promise<Record<string, CapabilityAdvertisement>> {
    return capabilities(this);
  }

  async advertiseCapability(input: { name: string; version: string; summary: string }): Promise<CapabilityAdvertisement> {
    return advertiseCapability(this, input);
  }

  async deprecateCapability(capabilityId: string): Promise<CapabilityAdvertisement> {
    return deprecateCapability(this, capabilityId);
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
    return issueObjectGrant(this, subjectAgentId, objectId, expiresAt);
  }

  // Fail-closed predicate (spec-0020 R3): readable IFF an active, unexpired
  // `object.read` grant exists for (object_id, subject). Does NOT audit — use
  // readObject() for an audited access. The object's owner may always read it.
  async canReadObject(objectId: string, subjectAgentId: string, at = Date.now()): Promise<boolean> {
    return canReadObject(this, objectId, subjectAgentId, at);
  }

  // Audited read. Returns the object iff canReadObject; else fails closed.
  async readObject(objectId: string, subjectAgentId: string): Promise<SharedObject> {
    return readObject(this, objectId, subjectAgentId);
  }

  // Raw bytes of an object's (single) attachment, agent-held under attachments/.
  // Caller is responsible for the access check (readObject) first.
  async readAttachmentBytes(objectId: string): Promise<Buffer> {
    return readAttachmentBytes(this, objectId);
  }

  // Objects the given subject (default: me) may currently read — the data behind
  // the reader's "Shared with me" surface. Read-through is unaudited (listing);
  // readObject() audits the actual open.
  async sharedObjectsFor(subjectAgentId?: string): Promise<SharedObject[]> {
    return sharedObjectsFor(this, subjectAgentId);
  }

  // Build a signed `object_share` envelope (object + grant + inline attachment)
  // to deliver to a friend over the mailbox transport (ea-claude-065).
  async shareObjectEnvelope(peerAgentId: string, objectId: string, expiresAt = ""): Promise<MessageEnvelope> {
    return shareObjectEnvelope(this, peerAgentId, objectId, expiresAt);
  }

  // Apply a received `object_share`: store the object (+ attachment) and grant,
  // after verifying the envelope signature and that the grant matches.
  async receiveObjectShare(envelope: MessageEnvelope): Promise<SharedObject> {
    return receiveObjectShare(this, envelope);
  }

  // Revoke an object.read grant (forward-looking; does not claw back delivered
  // data). Writes a `grant.revoke` audit event. Returns the revoked grant_ids.
  async revokeObjectGrant(objectId: string, subjectAgentId: string): Promise<string[]> {
    return revokeObjectGrant(this, objectId, subjectAgentId);
  }

  // Build a signed `object_revoke` envelope to forward the revoke to the peer.
  async revokeObjectEnvelope(peerAgentId: string, objectId: string): Promise<MessageEnvelope> {
    return revokeObjectEnvelope(this, peerAgentId, objectId);
  }

  // Apply a received `object_revoke`: mark the matching grant revoked locally.
  async receiveObjectRevoke(envelope: MessageEnvelope): Promise<void> {
    return receiveObjectRevoke(this, envelope);
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
    return receivedPosts(this);
  }

  async saveReceivedPosts(posts: Record<string, ReceivedPost>): Promise<void> {
    return saveReceivedPosts(this, posts);
  }

  /** Grouped view for `/api/received` and the reader. */
  async receivedByCategory(): Promise<{ signals: Record<string, Signal>; ephemeral: Record<string, EphemeralPost>; answers: Record<string, Answer>; endorsements: Record<string, Endorsement> }> {
    return receivedByCategory(this);
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
    return receivePostPublish(this, envelope);
  }

  /** Build a signed `post_publish` envelope wrapping any post type. */
  async signPostPublishEnvelope(input: { to_agent_id: string; post: ReceivedPost }): Promise<MessageEnvelope> {
    return signPostPublishEnvelope(this, input);
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

  // Compute the transport-free notification intent for an applied inbound envelope,
  // or null when the type is silent / unregistered. Delivery (invoking the host
  // notify command) is the entry point's job — this stays transport-free.
  async notificationIntent(envelope: MessageEnvelope): Promise<NotificationIntent | null> {
    const policy = NOTIFY_POLICIES[envelope.type];
    if (!policy) return null;
    const intent = await policy(envelope, this);
    if (!intent) return null;
    // Optional whitelist: when notify_types is set, only those kinds notify.
    const types = (await this.config()).notify_types;
    if (Array.isArray(types) && !types.includes(intent.kind)) return null;
    return intent;
  }

  // Notification dedup ledger (keyed by NotificationIntent.dedup_key). Guards
  // against double-notify across entry points, hook+cron, and mailbox redelivery.
  async wasNotified(dedupKey: string): Promise<boolean> {
    const ledger = await readJson<string[]>(this.file(NOTIFIED_FILE), []);
    return ledger.includes(dedupKey);
  }

  async recordNotified(dedupKey: string): Promise<void> {
    const ledger = await readJson<string[]>(this.file(NOTIFIED_FILE), []);
    if (ledger.includes(dedupKey)) return;
    ledger.push(dedupKey);
    await writeJson(this.file(NOTIFIED_FILE), ledger);
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
    return posts(this);
  }

  async savePosts(posts: Record<string, EdgeBookPost>): Promise<void> {
    return savePosts(this, posts);
  }

  async feedItems(): Promise<Record<string, FeedItem>> {
    return feedItems(this);
  }

  async saveFeedItems(items: Record<string, FeedItem>): Promise<void> {
    return saveFeedItems(this, items);
  }

  async approvals(): Promise<Record<string, ApprovalRequest>> {
    return approvals(this);
  }

  async saveApprovals(approvals: Record<string, ApprovalRequest>): Promise<void> {
    return saveApprovals(this, approvals);
  }

  async contactMutes(): Promise<Record<string, ContactMute>> {
    return contactMutes(this);
  }

  async saveContactMutes(mutes: Record<string, ContactMute>): Promise<void> {
    return saveContactMutes(this, mutes);
  }

  async createApproval(input: {
    type: ApprovalRequest["type"];
    objectType: ApprovalRequest["object_type"];
    objectId: string;
    summary: string;
    riskLevel?: ApprovalRequest["risk_level"];
    requestedByAgentId?: string;
  }): Promise<ApprovalRequest> {
    return createApproval(this, input);
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRequest> {
    return resolveApproval(this, approvalId, approved);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Agent → human escalation (ea-claude-094). Raise → surface → answer →
  // route-back, mirroring the friend-request loop. Remote raises are gated on
  // friend-state + an `escalation.raise` grant (fail closed), exactly like
  // sendPrivilegedMessage. Local raises (asking your own human) need no grant.
  // ──────────────────────────────────────────────────────────────────────

  async escalations(): Promise<Record<string, Escalation>> {
    return escalations(this);
  }

  async saveEscalations(escalations: Record<string, Escalation>): Promise<void> {
    return saveEscalations(this, escalations);
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
    return raiseEscalation(this, input);
  }

  // Receive a remote escalation, materialise it for this agent's human.
  async receiveEscalation(envelope: MessageEnvelope): Promise<Escalation> {
    return receiveEscalation(this, envelope);
  }

  // The human answers. For a remote-origin escalation, returns an
  // `escalation_response` envelope to route back to the requesting agent.
  async answerEscalation(escalationId: string, input: { text?: string; choice?: string }): Promise<Escalation & { envelope?: MessageEnvelope }> {
    return answerEscalation(this, escalationId, input);
  }

  // The requesting agent applies a routed-back answer to its own copy.
  async applyEscalationResponse(envelope: MessageEnvelope): Promise<Escalation> {
    return applyEscalationResponse(this, envelope);
  }

  // Sweep: pending escalations past their expiry become `expired`.
  async expireEscalations(): Promise<void> {
    return expireEscalations(this);
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
    return createPost(this, input);
  }

  async approvePost(postId: string): Promise<EdgeBookPost> {
    return approvePost(this, postId);
  }

  async editPost(postId: string, input: { title?: string; body?: string; tags?: string[]; visibility?: EdgeBookVisibility }): Promise<EdgeBookPost> {
    return editPost(this, postId, input);
  }

  async removePost(postId: string, reason = "removed by local owner"): Promise<EdgeBookPost> {
    return removePost(this, postId, reason);
  }

  async expirePost(postId: string, reason = "expired"): Promise<EdgeBookPost> {
    return expirePost(this, postId, reason);
  }

  async ensureLocalFeedItem(post: EdgeBookPost): Promise<FeedItem> {
    return ensureLocalFeedItem(this, post);
  }

  async visiblePostsForPeer(peerAgentId: string): Promise<EdgeBookPost[]> {
    return visiblePostsForPeer(this, peerAgentId);
  }

  async importFeedPosts(peerAgentId: string, posts: EdgeBookPost[], route: FeedItem["delivery_route"] = "local"): Promise<FeedItem[]> {
    return importFeedPosts(this, peerAgentId, posts, route);
  }

  async markFeedItemRead(feedItemId: string): Promise<FeedItem> {
    return markFeedItemRead(this, feedItemId);
  }

  async hideFeedItem(feedItemId: string, reason = ""): Promise<FeedItem> {
    return hideFeedItem(this, feedItemId, reason);
  }

  async muteContact(peerAgentId: string, reason = ""): Promise<ContactMute> {
    return muteContact(this, peerAgentId, reason);
  }

  async unmuteContact(peerAgentId: string): Promise<void> {
    return unmuteContact(this, peerAgentId);
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

