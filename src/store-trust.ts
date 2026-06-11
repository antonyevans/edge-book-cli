// The grant trust kernel + envelope signing/verification + web sessions:
// capability grant issue/verify/assert, friend-gated privileged messages,
// envelope sign/verify (recipient/expiry/replay/sender-key checks), the
// inbound rate throttle, and local web-session auth.
//
// Extracted from EdgeBookStore (2026-06-10 size-compliance refactor); each
// public function is called by a same-named one-line delegate method on
// EdgeBookStore. Invariants:
//   - a grant authorizes access only if its issuer signature verifies against
//     the issuer's accepted public key (ea-openclaw-030 check #6) — grants are
//     re-verified on USE via assertGrantSignature, failing closed;
//   - verifyEnvelope enforces recipient match, expiry, replay (seen message
//     ids), and the sender key from contacts (or the embedded card for
//     friend_request/friend_response bootstrap);
//   - privileged messages require relationship_state === "friend" AND an
//     active message.friend grant on BOTH send and receive.
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { AgentContactRecord, CapabilityGrant, Escalation, FriendRequestBody, FriendResponseBody, LocalUserSession, MessageEnvelope } from "./types.ts";
import { relationshipId, signPayload, verifyPayload, withoutSignature } from "./crypto.ts";
import { now, randomId, readJson, writeJson, appendJsonl } from "./fs-json.ts";
import { AUDIT_FILE, INBOUND_RATE_FILE, INBOX_FILE, MESSAGES_FILE, SEEN_MESSAGES_FILE } from "./store-files.ts";
import { logEvent } from "./event-log.ts";

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
export async function enforceInboundRate(store: EdgeBookStore, peerAgentId: string): Promise<void> {
  const config = await store.config();
  const windowMs = config.inbound_window_ms ?? 3_600_000;
  const maxPeer = config.inbound_max_per_peer ?? 5;
  const maxGlobal = config.inbound_max_global ?? 60;
  const cutoff = Date.now() - windowMs;
  const all = await readJson<Record<string, number[]>>(store.file(INBOUND_RATE_FILE), {});
  for (const k of Object.keys(all)) {
    const kept = all[k]!.filter((t) => t > cutoff); // key comes from Object.keys(all) — value is present
    all[k] = kept;
    if (!kept.length) delete all[k];
  }
  const peerCount = (all[peerAgentId] ?? []).length;
  const globalCount = Object.values(all).reduce((n, arr) => n + arr.length, 0);
  if (peerCount >= maxPeer || globalCount >= maxGlobal) {
    await store.audit("inbound.rate_limited", peerAgentId, { peerCount, globalCount });
    throw new EdgeBookError("rate_limited", "Inbound request rate limit exceeded");
  }
  all[peerAgentId] = [...(all[peerAgentId] ?? []), Date.now()];
  await writeJson(store.file(INBOUND_RATE_FILE), all);
}

export async function issueGrant(store: EdgeBookStore, subjectAgentId: string, scopes: string[], expiresAt = ""): Promise<CapabilityGrant> {
  const identity = await store.identity();
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
  await store.storeGrant(grant);
  await store.audit("grant.issue", subjectAgentId, { grant_id: grant.grant_id, scopes });
  return grant;
}

export async function storeGrant(store: EdgeBookStore, grant: CapabilityGrant): Promise<void> {
  const grants = await store.grants();
  grants[grant.grant_id] = grant;
  await store.saveGrants(grants);
  const contacts = await store.contacts();
  const peer = grant.issuer_agent_id === (await store.identity()).agent_id ? grant.subject_agent_id : grant.issuer_agent_id;
  const contact = contacts[peer];
  if (contact && !contact.capability_grants.includes(grant.grant_id)) {
    contact.capability_grants.push(grant.grant_id);
    contact.updated_at = now();
    contacts[peer] = contact;
    await store.saveContacts(contacts);
  }
}

export async function sendPrivilegedMessage(store: EdgeBookStore, peerAgentId: string, body: Record<string, unknown>, scope = "message.friend"): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const contacts = await store.contacts();
  const contact = contacts[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked", `Peer ${peerAgentId} is blocked`);
  if (contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", `Cannot send friend-gated message to relationship_state=${contact.relationship_state}`);
  }
  const grant = await store.findUsableGrant(peerAgentId, scope);
  if (!grant) throw new EdgeBookError("missing_grant", `No active grant for ${scope}`);
  await store.assertGrantSignature(grant);
  const envelope = await store.signEnvelope({
    type: "privileged_message",
    to_agent_id: peerAgentId,
    relationship_id: relationshipId(identity.agent_id, peerAgentId),
    capability_id: grant.grant_id,
    ref: "",
    transport: "local",
    body
  });
  await appendJsonl(store.file(MESSAGES_FILE), envelope);
  await store.audit("message.send", peerAgentId, { message_id: envelope.message_id, scope });
  return envelope;
}

export async function receivePrivilegedMessage(store: EdgeBookStore, envelope: MessageEnvelope): Promise<void> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "privileged_message") throw new EdgeBookError("wrong_message_type", "Expected privileged_message envelope");
  const contacts = await store.contacts();
  const contact = contacts[envelope.from_agent_id];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${envelope.from_agent_id}`);
  if (contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", `Cannot receive friend-gated message from relationship_state=${contact.relationship_state}`);
  }
  const grants = await store.grants();
  const grant = grants[envelope.capability_id];
  if (!grant || grant.status !== "active" || grant.subject_agent_id !== envelope.from_agent_id || !grant.scopes.includes("message.friend")) {
    throw new EdgeBookError("missing_grant", "Message does not carry an active grant issued to sender");
  }
  await store.assertGrantSignature(grant);
  await appendJsonl(store.file(INBOX_FILE), envelope);
  await store.audit("message.receive", envelope.from_agent_id, { message_id: envelope.message_id });
}

export async function findUsableGrant(store: EdgeBookStore, peerAgentId: string, scope: string): Promise<CapabilityGrant | undefined> {
  const identity = await store.identity();
  const grants = await store.grants();
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
export async function verifyGrantSignature(store: EdgeBookStore, grant: CapabilityGrant): Promise<boolean> {
  if (!grant.signature) return false;
  const identity = await store.identity();
  let publicKey: string | undefined;
  if (grant.issuer_agent_id === identity.agent_id) {
    publicKey = identity.public_key_pem;
  } else {
    const contacts = await store.contacts();
    publicKey = contacts[grant.issuer_agent_id]?.public_keys?.[0]?.public_key_pem;
  }
  if (!publicKey) return false;
  return verifyPayload(withoutSignature(grant), grant.signature, publicKey);
}

// Throwing guard used by every friend-gated access path so the signature
// check lives in exactly one place (ea-openclaw-031: build the grant-check
// primitive once, have all sites consume it).
export async function assertGrantSignature(store: EdgeBookStore, grant: CapabilityGrant): Promise<void> {
  if (!(await store.verifyGrantSignature(grant))) {
    await store.audit("grant.denied", grant.issuer_agent_id, { grant_id: grant.grant_id, reason: "invalid_grant_signature" });
    throw new EdgeBookError("invalid_grant_signature", "Grant signature does not verify against the issuer key");
  }
}

export async function signEnvelope(store: EdgeBookStore, input: Omit<MessageEnvelope, "message_id" | "from_agent_id" | "created_at" | "expires_at" | "signature">): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const unsigned: Omit<MessageEnvelope, "signature"> = {
    message_id: randomId("msg"),
    from_agent_id: identity.agent_id,
    created_at: now(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...input
  };
  return { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
}

export async function verifyEnvelope(store: EdgeBookStore, envelope: MessageEnvelope): Promise<void> {
  const identity = await store.identity();
  if (envelope.to_agent_id !== identity.agent_id) throw new EdgeBookError("wrong_recipient", "Envelope recipient does not match local identity");
  if (Date.parse(envelope.expires_at) <= Date.now()) throw new EdgeBookError("expired_message", "Message is expired");
  const seen = await readJson<string[]>(store.file(SEEN_MESSAGES_FILE), []);
  if (seen.includes(envelope.message_id)) {
    // Flight recorder (spec-133): dedup hit — kind/from/dedup key only.
    await logEvent(store, "envelope.dedup_hit", { envelope_kind: envelope.type, from: envelope.from_agent_id, dedup_key: envelope.message_id });
    throw new EdgeBookError("replay", `Replay detected for ${envelope.message_id}`);
  }
  const contacts = await store.contacts();
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
    // Flight recorder (spec-133): signature verification failure.
    await logEvent(store, "envelope.signature_failed", { envelope_kind: envelope.type, from: envelope.from_agent_id, dedup_key: envelope.message_id });
    throw new EdgeBookError("invalid_signature", "Message signature is invalid");
  }
  seen.push(envelope.message_id);
  await writeJson(store.file(SEEN_MESSAGES_FILE), seen);
}

export async function createSession(store: EdgeBookStore, input: { authMethod?: LocalUserSession["auth_method"]; ttlMs?: number } = {}): Promise<LocalUserSession> {
  const identity = await store.identity();
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
  const sessions = await store.sessions();
  sessions[session.session_id] = session;
  await store.saveSessions(sessions);
  await store.audit("session.create", identity.agent_id, { session_id: session.session_id, auth_method: session.auth_method });
  return session;
}

export async function requireSession(store: EdgeBookStore, sessionId: string): Promise<LocalUserSession> {
  const sessions = await store.sessions();
  const session = sessions[sessionId];
  if (!session) throw new EdgeBookError("unauthorized", "Missing or unknown web session");
  if (session.revoked_at) throw new EdgeBookError("unauthorized", "Web session was revoked");
  if (Date.parse(session.expires_at) <= Date.now()) throw new EdgeBookError("unauthorized", "Web session expired");
  session.last_seen_at = now();
  sessions[sessionId] = session;
  await store.saveSessions(sessions);
  return session;
}

export async function revokeSession(store: EdgeBookStore, sessionId: string): Promise<void> {
  const sessions = await store.sessions();
  const session = sessions[sessionId];
  if (!session) return;
  session.revoked_at = now();
  sessions[sessionId] = session;
  await store.saveSessions(sessions);
  await store.audit("session.revoke", session.owner_agent_id, { session_id: sessionId });
}

// Route an applied inbound envelope to its type handler (the mailbox receive
// path; dedupe-by-message_id happens inside verifyEnvelope on each handler).
export async function receiveEnvelope(store: EdgeBookStore, envelope: MessageEnvelope): Promise<void | AgentContactRecord | MessageEnvelope | Escalation | null> {
  if (envelope.type === "friend_request") return store.receiveFriendRequest(envelope);
  if (envelope.type === "friend_response") return store.applyFriendResponse(envelope);
  if (envelope.type === "privileged_message") return store.receivePrivilegedMessage(envelope);
  if (envelope.type === "object_share") { await store.receiveObjectShare(envelope); return; }
  if (envelope.type === "object_revoke") { await store.receiveObjectRevoke(envelope); return; }
  if (envelope.type === "post_publish") { await store.receivePostPublish(envelope); return; }
  if (envelope.type === "profile_share") { await store.receiveProfileShare(envelope); return; }
  if (envelope.type === "escalation") return store.receiveEscalation(envelope);
  if (envelope.type === "escalation_response") return store.applyEscalationResponse(envelope);
  throw new EdgeBookError("unsupported_envelope", `Unsupported envelope type: ${envelope.type}`);
}

// Append-only audit trail (audit.jsonl in the agent home).
export async function audit(store: EdgeBookStore, action: string, peerAgentId: string, details: Record<string, unknown>): Promise<string> {
  const audit_id = randomId("audit");
  await appendJsonl(store.file(AUDIT_FILE), {
    audit_id,
    created_at: now(),
    action,
    peer_agent_id: peerAgentId,
    details
  });
  return audit_id;
}
