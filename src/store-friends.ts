// Friend-graph lifecycle: contact records, friend request/accept/reject,
// revoke/block/report, invite codes, and the friend-only profile exchange.
//
// Extracted from EdgeBookStore (2026-06-09 legibility refactor); each public
// function is called by a same-named one-line delegate method on EdgeBookStore.
// Invariants:
//   - relationship transitions are recorded as signed RelationshipEvents
//     (append-only) and audited; acceptFriend issues the default friend grants
//     (message.friend, feed.read.friends, escalation.raise);
//   - inbound friend requests honour the abuse floor: open_friend_requests
//     config, invite-code consumption, and the per-peer/global inbound throttle
//     (store.enforceInboundRate), failing closed;
//   - friend profiles are validated against the sender's accepted public key
//     and applied last-writer-wins by profile_version.
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { AgentCard, AgentContactRecord, CapabilityGrant, FriendProfile, FriendRequestBody, FriendResponseBody, InviteCode, MessageEnvelope, ProfileShareBody, RelationshipEvent, RelationshipState, ReportRecord } from "./types.ts";
import { relationshipId, signPayload } from "./crypto.ts";
import { now, randomId, readJson, writeJson, appendJsonl, readJsonl } from "./fs-json.ts";
import { validateCard, validateFriendProfile } from "./cards.ts";
import { INBOX_FILE, INVITE_CODES_FILE, RELATIONSHIP_EVENTS_FILE, REPORTS_FILE } from "./store-files.ts";
import { logEvent } from "./event-log.ts";

export async function upsertContactFromCard(store: EdgeBookStore, card: AgentCard, state?: RelationshipState): Promise<AgentContactRecord> {
  validateCard(card);
  const contacts = await store.contacts();
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
    // When transitioning INTO request_received (a fresh inbound request), clear
    // any stale notified_at so the human is re-notified. For all other state
    // changes (card refreshes, accept, etc.) carry the stamp forward as before.
    ...(state !== "request_received" && existing?.notified_at ? { notified_at: existing.notified_at } : {}),
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
  await store.saveContacts(contacts);
  await store.audit("contact.upsert", card.agent_id, { state: next.relationship_state });
  return next;
}

export async function setRelationship(store: EdgeBookStore, peerAgentId: string, nextState: RelationshipState, type: RelationshipEvent["type"], reason = ""): Promise<RelationshipEvent> {
  const identity = await store.identity();
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  const previous = contact.relationship_state;
  contact.relationship_state = nextState;
  contact.updated_at = now();
  contacts[peerAgentId] = contact;
  await store.saveContacts(contacts);

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
  await appendJsonl(store.file(RELATIONSHIP_EVENTS_FILE), event);
  await store.audit(`relationship.${type}`, peerAgentId, { previous, next: nextState, reason });
  // Flight recorder (spec-133): friend-graph state transition — ids/states only.
  await logEvent(store, "friend.state_changed", { peer: peerAgentId, previous, next: nextState, event_type: type });
  return event;
}

export async function createFriendRequest(store: EdgeBookStore, targetCard: AgentCard, note = "", inviteCode = ""): Promise<MessageEnvelope> {
  const identity = await store.identity();
  validateCard(targetCard);
  const existing = (await store.contacts())[targetCard.agent_id];
  if (existing?.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot request a blocked peer");
  await store.upsertContactFromCard(targetCard, "request_sent");
  await store.setRelationship(targetCard.agent_id, "request_sent", "FriendRequest", note);
  const card = await store.writeCard();
  const body: FriendRequestBody = { card, note, ...(inviteCode ? { invite_code: inviteCode } : {}) };
  return store.signEnvelope({
    type: "friend_request",
    to_agent_id: targetCard.agent_id,
    relationship_id: relationshipId(identity.agent_id, targetCard.agent_id),
    capability_id: "",
    ref: "",
    transport: "local",
    body: body as unknown as Record<string, unknown>
  });
}

export async function receiveFriendRequest(store: EdgeBookStore, envelope: MessageEnvelope): Promise<AgentContactRecord> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "friend_request") throw new EdgeBookError("wrong_message_type", "Expected friend_request envelope");
  await store.enforceInboundRate(envelope.from_agent_id);
  const body = envelope.body as unknown as FriendRequestBody;
  validateCard(body.card);
  if (body.card.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Friend request card does not match sender");
  // Invite-only gate: when open_friend_requests is explicitly false, require either
  // a prior solicited/active relationship or a valid invite code.
  // Only "request_sent" (we reached out first, so their reply is expected) and
  // "friend" (already connected) bypass the code requirement.  States like
  // "rejected", "revoked", and "blocked" are NOT a bypass — those peers must
  // supply a fresh invite code just like a cold stranger would.
  if ((await store.config()).open_friend_requests === false) {
    const ALLOWED_INVITE_BYPASS: RelationshipState[] = ["request_sent", "friend"];
    const known = (await store.contacts())[envelope.from_agent_id]?.relationship_state;
    const allowed =
      (known !== undefined && ALLOWED_INVITE_BYPASS.includes(known)) ||
      (body.invite_code ? await consumeInviteCode(store, body.invite_code) : false);
    if (!allowed) {
      await store.audit("inbound.unsolicited_dropped", envelope.from_agent_id, {});
      throw new EdgeBookError("unsolicited_dropped", "Invite-only: unsolicited request without a valid invite code");
    }
  }
  const contact = await store.upsertContactFromCard(body.card, "request_received");
  await store.setRelationship(envelope.from_agent_id, "request_received", "FriendRequest", body.note);
  // Flight recorder (spec-133): inbound friend request — sender id + dedup key only.
  await logEvent(store, "friend.request_received", { from: envelope.from_agent_id, dedup_key: envelope.message_id, trace_id: envelope.trace_id });
  await appendJsonl(store.file(INBOX_FILE), envelope);
  // Dedup: if a pending friend_accept already exists for this peer (e.g. from a
  // prior request that was revoked and re-sent with a fresh message_id), reuse it
  // rather than accumulating stale duplicates that would each re-run acceptFriend.
  const existingApprovals = await store.approvals();
  const alreadyPending = Object.values(existingApprovals).some(
    (a) => a.status === "pending" && a.type === "friend_accept" && a.object_id === envelope.from_agent_id,
  );
  if (!alreadyPending) {
    await store.createApproval({
      type: "friend_accept",
      objectType: "contact",
      objectId: envelope.from_agent_id,
      summary: `Friend request from ${body.card.display_name || body.card.handle}`,
      riskLevel: "low",
      requestedByAgentId: envelope.from_agent_id,
    });
  }
  return contact;
}

// spec-139: ALL requests awaiting accept/decline — the "do I have friend
// requests waiting?" surface (`friend pending`). Notification state never
// hides an un-actioned request; callers read notified_at to tell new from seen.
export async function pendingFriendRequests(store: EdgeBookStore): Promise<AgentContactRecord[]> {
  const contacts = await store.contacts();
  return Object.values(contacts).filter((c) => c.relationship_state === "request_received");
}

// spec-139: the notification de-dup queue (`friend pending --new`) — only
// un-notified requests, gated on notify_on_friend_request. This is the
// notifier-cron surface; mark-notified removes entries from it.
export async function unnotifiedFriendRequests(store: EdgeBookStore): Promise<AgentContactRecord[]> {
  const config = await store.config();
  if (config.notify_on_friend_request === false) return [];
  return (await pendingFriendRequests(store)).filter((c) => !c.notified_at);
}

export async function markFriendRequestNotified(store: EdgeBookStore, peerAgentId: string): Promise<void> {
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.notified_at) return;
  contact.notified_at = now();
  contact.updated_at = now();
  contacts[peerAgentId] = contact;
  await store.saveContacts(contacts);
  await store.audit("friend.notified", peerAgentId, {});
}

export async function acceptFriend(store: EdgeBookStore, peerAgentId: string, reason = "accepted"): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot accept a blocked peer");
  await store.setRelationship(peerAgentId, "friend", "Accept", reason);
  // Flight recorder (spec-133): friend accepted — peer id only.
  await logEvent(store, "friend.accepted", { peer: peerAgentId });
  // `profile.read.friend` is minted now but intentionally NOT enforced in this
  // phase: the push exchange (profile_share) gates on relationship_state ===
  // "friend", not on the grant. The scope is reserved so a future pull-based
  // profile-read path (the reader `friend_accept` wiring, Plan C) can enforce
  // it without re-granting existing friendships. Until that consumer lands it
  // is a forward-compat token, not a live access check.
  // `escalation.raise` lets a confirmed friend raise an escalation to this
  // agent's human (ea-claude-094) — friending is the authorization to ask.
  const grant = await store.issueGrant(peerAgentId, ["message.friend", "feed.read.friends", "profile.read.friend", "escalation.raise"]);
  const card = await store.writeCard();
  const profile = await store.buildFriendProfile();
  return store.signEnvelope({
    type: "friend_response",
    to_agent_id: peerAgentId,
    relationship_id: relationshipId(identity.agent_id, peerAgentId),
    capability_id: grant.grant_id,
    ref: "",
    transport: "local",
    body: { accepted: true, card, grant, profile, reason } satisfies FriendResponseBody
  });
}

export async function rejectFriend(store: EdgeBookStore, peerAgentId: string, reason = "rejected"): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot reject a blocked peer");
  await store.setRelationship(peerAgentId, "rejected", "Reject", reason);
  const card = await store.writeCard();
  return store.signEnvelope({
    type: "friend_response",
    to_agent_id: peerAgentId,
    relationship_id: relationshipId(identity.agent_id, peerAgentId),
    capability_id: "",
    ref: "",
    transport: "local",
    body: { accepted: false, card, reason } satisfies FriendResponseBody,
  });
}

export async function applyFriendResponse(store: EdgeBookStore, envelope: MessageEnvelope): Promise<MessageEnvelope | null> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "friend_response") throw new EdgeBookError("wrong_message_type", "Expected friend_response envelope");
  const body = envelope.body as unknown as FriendResponseBody;
  validateCard(body.card);
  if (body.card.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Friend response card does not match sender");
  await store.upsertContactFromCard(body.card, body.accepted ? "friend" : "rejected");
  await store.setRelationship(envelope.from_agent_id, body.accepted ? "friend" : "rejected", body.accepted ? "Accept" : "Reject", body.reason);
  if (body.grant) await store.storeGrant(body.grant);
  if (body.accepted && body.profile) {
    const publicKey = body.card.public_keys?.[0]?.public_key_pem;
    if (!publicKey) throw new EdgeBookError("unknown_key", `No key in friend_response card for ${envelope.from_agent_id}`);
    if (body.profile.agent_id !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "friend_response profile agent_id does not match sender");
    validateFriendProfile(body.profile, publicKey);
    await storeFriendProfile(store, envelope.from_agent_id, body.profile);
  }
  // Now that both sides are friends, send our own profile back.
  if (body.accepted) return store.buildProfileShareEnvelope(envelope.from_agent_id);
  return null;
}

export async function buildProfileShareEnvelope(store: EdgeBookStore, peerAgentId: string): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact || contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", `Not friends with ${peerAgentId}; cannot share profile`);
  }
  const profile = await store.buildFriendProfile();
  return store.signEnvelope({
    type: "profile_share",
    to_agent_id: peerAgentId,
    relationship_id: relationshipId(identity.agent_id, peerAgentId),
    capability_id: "",
    ref: "",
    transport: "local",
    body: { profile } satisfies ProfileShareBody,
  });
}

export async function receiveProfileShare(store: EdgeBookStore, envelope: MessageEnvelope): Promise<void> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "profile_share") throw new EdgeBookError("wrong_message_type", "Expected profile_share envelope");
  const contacts = await store.contacts();
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
  await storeFriendProfile(store, envelope.from_agent_id, body.profile);
}

export async function broadcastProfileEnvelopes(store: EdgeBookStore): Promise<MessageEnvelope[]> {
  const contacts = await store.contacts();
  const friends = Object.values(contacts).filter((c) => c.relationship_state === "friend");
  const out: MessageEnvelope[] = [];
  for (const friend of friends) {
    out.push(await store.buildProfileShareEnvelope(friend.peer_agent_id));
  }
  return out;
}

export async function revoke(store: EdgeBookStore, peerAgentId: string): Promise<void> {
  await store.setRelationship(peerAgentId, "revoked", "Revoke", "revoked");
  const grants = await store.grants();
  const revoked: string[] = [];
  const scopes = new Set<string>();
  for (const grant of Object.values(grants)) {
    if (grant.subject_agent_id === peerAgentId || grant.issuer_agent_id === peerAgentId) {
      grant.status = "revoked";
      grant.revoked_at = now();
      revoked.push(grant.grant_id);
      for (const scope of grant.scopes) scopes.add(scope);
    }
  }
  await store.saveGrants(grants);
  if (revoked.length) await store.audit("grant.revoke", peerAgentId, { grant_ids: revoked, scopes: [...scopes].sort() });
}

export async function block(store: EdgeBookStore, peerAgentId: string): Promise<void> {
  await store.setRelationship(peerAgentId, "blocked", "Block", "blocked");
}

export async function reports(store: EdgeBookStore): Promise<ReportRecord[]> {
  return readJson<ReportRecord[]>(store.file(REPORTS_FILE), []);
}

export async function inviteCodes(store: EdgeBookStore): Promise<InviteCode[]> {
  return readJson<InviteCode[]>(store.file(INVITE_CODES_FILE), []);
}

export async function mintInviteCode(store: EdgeBookStore, opts: { ttlMs?: number; maxUses?: number } = {}): Promise<InviteCode> {
  const invite: InviteCode = {
    code: randomId("invite"),
    created_at: now(),
    expires_at: opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : "",
    max_uses: opts.maxUses ?? 0,
    uses: 0,
  };
  const codes = await store.inviteCodes();
  codes.push(invite);
  await writeJson(store.file(INVITE_CODES_FILE), codes);
  return invite;
}

export async function reportPeer(store: EdgeBookStore, peerAgentId: string, reason = "", opts: { block?: boolean } = {}): Promise<ReportRecord> {
  const auditRef = await store.audit("peer.reported", peerAgentId, { reason, block: Boolean(opts.block) });
  // Attempt the block before building the record so rec.blocked reflects
  // whether a block ACTUALLY happened (contact must exist for block() to fire).
  let actuallyBlocked = false;
  if (opts.block) {
    const contacts = await store.contacts();
    if (contacts[peerAgentId]) {
      await store.block(peerAgentId);
      actuallyBlocked = true;
    }
  }
  const rec: ReportRecord = {
    report_id: randomId("report"),
    peer_agent_id: peerAgentId,
    reason,
    blocked: actuallyBlocked,
    created_at: now(),
    audit_refs: [auditRef],
  };
  const existingReports = await readJson<ReportRecord[]>(store.file(REPORTS_FILE), []);
  existingReports.push(rec);
  await writeJson(store.file(REPORTS_FILE), existingReports);
  return rec;
}

export async function storeFriendProfile(store: EdgeBookStore, peerAgentId: string, profile: FriendProfile): Promise<boolean> {
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  const current = contact.friend_profile?.profile_version ?? -1;
  if (profile.profile_version <= current) return false;
  contact.friend_profile = profile;
  contact.updated_at = now();
  contacts[peerAgentId] = contact;
  await store.saveContacts(contacts);
  await store.audit("profile.received", peerAgentId, { profile_version: profile.profile_version });
  return true;
}

export async function consumeInviteCode(store: EdgeBookStore, code: string): Promise<boolean> {
  const codes = await store.inviteCodes();
  const idx = codes.findIndex((c) => c.code === code);
  if (idx === -1) return false;
  const invite = codes[idx]!; // findIndex returned a valid index — element is present
  // Check expiry
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return false;
  // Check max_uses (0 = unlimited)
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return false;
  invite.uses += 1;
  codes[idx] = invite;
  await writeJson(store.file(INVITE_CODES_FILE), codes);
  return true;
}
