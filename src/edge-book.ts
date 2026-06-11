// EdgeBookStore — the agent's trust core and the package's public facade.
//
// FACADE: everything this package historically exported from "edge-book.ts"
// is still exported here (types, helpers, validators, harnesses, and the
// feature-module functions via the class delegates below), so importers and
// tests never need to know the module layout.
//
// MODULE MAP (each store-*.ts holds free functions taking `store` as first
// argument; the class keeps same-named one-line delegate methods):
//   types.ts             all shared types (contract-frozen shapes flagged there)
//   store-files.ts       persisted file names of the agent home (frozen format)
//   fs-json.ts           atomic JSON/JSONL persistence helpers
//   crypto.ts            canonical-JSON ed25519 signing/verification (frozen)
//   handles.ts           human-handle slug rules (must match host)
//   profile.ts           two-tier profile projection (spec-098)
//   cards.ts             AgentCard/FriendProfile validation + loading
//   store-identity.ts    identity lifecycle: init, profile, card building,
//                        doctor, import/export, deregister
//   store-trust.ts       grant trust kernel, privileged messages, envelope
//                        sign/verify/receive routing, audit, web sessions
//   store-notify.ts      notification policies + dedup ledger
//   store-friends.ts     friend-graph lifecycle, invites, reports
//   store-objects.ts     shared objects + object.read grants (spec-0020)
//   store-taxonomy.ts    spec-0021 post types (signals/ephemeral/answers/...)
//   store-posts.ts       owner posts, feed, approvals, contact mutes
//   store-escalations.ts agent->human escalations (spec-094)
//   harness.ts           two-agent smoke harnesses
//
// WHAT STAYS IN THIS FILE: the EdgeBookStore class (delegates + the tiny
// readers every module shares: identity/config/contacts/grants/sessions/
// inbox/auditEvents) and the facade re-exports. Add new behavior in a
// store-*.ts feature module, not inline here.
import path from "node:path";

// All shared type definitions (and EdgeBookError) live in types.ts; this file
// re-exports them so existing importers of "./edge-book.ts" keep working.
export * from "./types.ts";
export { resolveHome, randomId, readJson, writeJson } from "./fs-json.ts";
export { isValidHandle, slugifyHandle } from "./handles.ts";
export { contentHash } from "./crypto.ts";
export { defaultProfile, resolveFieldVisibility, resolveSocialVisibility } from "./profile.ts";
import { resolveHome, randomId, readJson, writeJson, now, appendJsonl, readJsonl } from "./fs-json.ts";
import { isValidHandle, slugifyHandle } from "./handles.ts";
import { defaultProfile, resolveFieldVisibility, resolveSocialVisibility } from "./profile.ts";
export { validateCard, validateFriendProfile, loadCard } from "./cards.ts";
export { runTwoAgentHarness, runFeedPrivacyHarness } from "./harness.ts";
import { validateCard, validateFriendProfile, loadCard } from "./cards.ts";
import { attestations, saveAttestations, saveEndorsements, saveSignals, saveCapabilities, createAttestation, verifyAttestation, verifyCapability, verifyEphemeral, verifyAnswer, verifySignal, verifyEndorsement, endorsements, createEndorsement, signals, createSignal, expireSignals, saveEphemeral, ephemeralPosts, createEphemeral, expireEphemeral, cancelEphemeral, saveAnswers, answers, createAnswer, deleteQuery, capabilities, advertiseCapability, deprecateCapability, receivedPosts, saveReceivedPosts, receivedByCategory, receivePostPublish, signPostPublishEnvelope } from "./store-taxonomy.ts";
import { objects, saveObjects, getObject, createObject, issueObjectGrant, canReadObject, readObject, readAttachmentBytes, sharedObjectsFor, shareObjectEnvelope, receiveObjectShare, revokeObjectGrant, revokeObjectEnvelope, receiveObjectRevoke } from "./store-objects.ts";
import { posts, savePosts, feedItems, saveFeedItems, approvals, saveApprovals, contactMutes, saveContactMutes, createApproval, resolveApproval, createPost, approvePost, editPost, removePost, expirePost, ensureLocalFeedItem, visiblePostsForPeer, importFeedPosts, markFeedItemRead, hideFeedItem, muteContact, unmuteContact } from "./store-posts.ts";
import { escalations, saveEscalations, raiseEscalation, receiveEscalation, answerEscalation, applyEscalationResponse, expireEscalations } from "./store-escalations.ts";
import { upsertContactFromCard, setRelationship, createFriendRequest, receiveFriendRequest, pendingFriendRequests, markFriendRequestNotified, acceptFriend, rejectFriend, applyFriendResponse, buildProfileShareEnvelope, receiveProfileShare, broadcastProfileEnvelopes, revoke, block, reports, inviteCodes, mintInviteCode, reportPeer } from "./store-friends.ts";
import { init, setProfile, setHandle, exportIdentity, importIdentity, updateConfig, buildCard, writeCard, buildHandleClaim, buildFriendProfile, doctor, deregister, reviewLocalDataImport, exportLocalData } from "./store-identity.ts";
import { enforceInboundRate, issueGrant, storeGrant, sendPrivilegedMessage, receivePrivilegedMessage, findUsableGrant, verifyGrantSignature, assertGrantSignature, signEnvelope, verifyEnvelope, receiveEnvelope, audit, createSession, requireSession, revokeSession } from "./store-trust.ts";
import { notificationIntent, wasNotified, recordNotified } from "./store-notify.ts";
import { IDENTITY_FILE, CONTACTS_FILE, GRANTS_FILE, CONFIG_FILE, AUDIT_FILE, INBOX_FILE, SESSIONS_FILE } from "./store-files.ts";
import { EdgeBookError } from "./types.ts";
import type { RelationshipState, TransportMode, EdgeBookOptions, EdgeBookConfig, LocalIdentity, FieldVisibility, SocialLink, IdentityProfile, FriendProfile, AgentCard, AgentContactRecord, RelationshipEvent, CapabilityGrant, SharedObjectAttachment, SharedObject, ObjectShareBody, ResultAttestation, StrongRef, Endorsement, Signal, EphemeralType, EphemeralPost, Answer, ReceivedPost, CapabilityAdvertisement, ObjectRevokeBody, MessageEnvelope, FriendRequestBody, NotificationIntent, ReportRecord, InviteCode, FriendResponseBody, ProfileShareBody, EdgeBookVisibility, EdgeBookPostStatus, EdgeBookPostKind, LocalUserSession, EdgeBookPost, FeedItem, ApprovalRequest, EscalationKind, EscalationStatus, Escalation, EscalationBody, EscalationResponseBody, ContactMute, PostType } from "./types.ts";

export { computeLifecycle } from "./store-taxonomy.ts";

export class EdgeBookStore {
  home: string;

  constructor(options: EdgeBookOptions = {}) {
    this.home = resolveHome(options.home);
  }

  file(name: string): string {
    return path.join(this.home, name);
  }

  async init(input: { handle?: string; displayName?: string; ownerLabel?: string; shareOwnerLabel?: boolean; cardUrl?: string; directUrl?: string; relayUrl?: string } = {}): Promise<LocalIdentity> {
    return init(this, input);
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
    return setProfile(this, input);
  }

  // Set a user-chosen unique handle. Re-signs the card; does NOT rotate keys.
  async setHandle(handle: string, opts?: { discoverable?: boolean }): Promise<LocalIdentity> {
    return setHandle(this, handle, opts);
  }

  // Portable identity bundle (the DID keypair + chosen handle). Carry to a new
  // device → same DID → relay handle keeps resolving to you (spec-096).
  async exportIdentity(): Promise<{ schema: "edge-book-identity-export/0.1"; identity: LocalIdentity }> {
    return exportIdentity(this);
  }

  async importIdentity(bundle: { identity: LocalIdentity }, opts: { force?: boolean } = {}): Promise<LocalIdentity> {
    return importIdentity(this, bundle, opts);
  }

  async config(): Promise<EdgeBookConfig> {
    return readJson<EdgeBookConfig>(this.file(CONFIG_FILE), {});
  }

  async updateConfig(input: EdgeBookConfig): Promise<EdgeBookConfig> {
    return updateConfig(this, input);
  }

  async buildCard(cardUrl?: string): Promise<AgentCard> {
    return buildCard(this, cardUrl);
  }

  async writeCard(cardUrl?: string): Promise<AgentCard> {
    return writeCard(this, cardUrl);
  }

  // Build a signed handle claim for the relay registry (spec-096). The relay
  // verifies claim_sig + the card against the identity key before binding.
  async buildHandleClaim(): Promise<{ handle: string; agent_did: string; card: AgentCard; claimed_at: number; claim_sig: string; discoverable: boolean }> {
    return buildHandleClaim(this);
  }

  // The friend-only profile: every field whose visibility resolves to "friends"
  // or "public". Signed; shared only with confirmed friends.
  async buildFriendProfile(): Promise<FriendProfile> {
    return buildFriendProfile(this);
  }

  async doctor(): Promise<Record<string, unknown>> {
    return doctor(this);
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

  // Internal — not part of the public store API. Non-private only so the
  // extracted store-* feature modules (which receive `store` as a parameter)
  // can apply the same inbound throttle as the in-class friend-request path.
  // Concurrency/sybil-defense notes live with the implementation in store-trust.ts.
  async enforceInboundRate(peerAgentId: string): Promise<void> {
    return enforceInboundRate(this, peerAgentId);
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
    return issueGrant(this, subjectAgentId, scopes, expiresAt);
  }

  async storeGrant(grant: CapabilityGrant): Promise<void> {
    return storeGrant(this, grant);
  }

  async sendPrivilegedMessage(peerAgentId: string, body: Record<string, unknown>, scope = "message.friend"): Promise<MessageEnvelope> {
    return sendPrivilegedMessage(this, peerAgentId, body, scope);
  }

  async receivePrivilegedMessage(envelope: MessageEnvelope): Promise<void> {
    return receivePrivilegedMessage(this, envelope);
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
    return deregister(this);
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
    return findUsableGrant(this, peerAgentId, scope);
  }

  // ea-openclaw-030 access check #6: a grant authorizes access only if its
  // issuer signature verifies against the issuer's accepted public key
  // (re-verified on use, failing closed — see store-trust.ts).
  async verifyGrantSignature(grant: CapabilityGrant): Promise<boolean> {
    return verifyGrantSignature(this, grant);
  }

  // Throwing guard used by every friend-gated access path so the signature
  // check lives in exactly one place (ea-openclaw-031).
  async assertGrantSignature(grant: CapabilityGrant): Promise<void> {
    return assertGrantSignature(this, grant);
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
    return signEnvelope(this, input);
  }

  async verifyEnvelope(envelope: MessageEnvelope): Promise<void> {
    return verifyEnvelope(this, envelope);
  }

  async inbox(): Promise<MessageEnvelope[]> {
    return readJsonl<MessageEnvelope>(this.file(INBOX_FILE));
  }

  async receiveEnvelope(envelope: MessageEnvelope): Promise<void | AgentContactRecord | MessageEnvelope | Escalation | null> {
    return receiveEnvelope(this, envelope);
  }

  // Compute the transport-free notification intent for an applied inbound envelope,
  // or null when the type is silent / unregistered (policies: store-notify.ts).
  async notificationIntent(envelope: MessageEnvelope): Promise<NotificationIntent | null> {
    return notificationIntent(this, envelope);
  }

  // Notification dedup ledger (keyed by NotificationIntent.dedup_key).
  async wasNotified(dedupKey: string): Promise<boolean> {
    return wasNotified(this, dedupKey);
  }

  async recordNotified(dedupKey: string): Promise<void> {
    return recordNotified(this, dedupKey);
  }

  async audit(action: string, peerAgentId: string, details: Record<string, unknown>): Promise<string> {
    return audit(this, action, peerAgentId, details);
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
    return createSession(this, input);
  }

  async requireSession(sessionId: string): Promise<LocalUserSession> {
    return requireSession(this, sessionId);
  }

  async revokeSession(sessionId: string): Promise<void> {
    return revokeSession(this, sessionId);
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
    return reviewLocalDataImport(this, data);
  }

  async exportLocalData(): Promise<Record<string, unknown>> {
    return exportLocalData(this);
  }
}
