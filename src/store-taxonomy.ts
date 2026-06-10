// spec-0021 post-taxonomy operations: signals, ephemeral posts (query/share/
// coordinate/delegation_request), answers, endorsements, result attestations,
// capability advertisements, and the received-posts store.
//
// Extracted from EdgeBookStore (2026-06-09 legibility refactor); each public
// function here is called by a same-named one-line delegate method on
// EdgeBookStore, so the class API (which the tests specify) is unchanged.
// Invariants:
//   - every record is signed over its canonical JSON minus mutable lifecycle
//     metadata (lifecycle transitions must not invalidate signatures);
//   - received posts (from friends) are stored separately and are never
//     mutated by local lifecycle changes or deregister().
import { EdgeBookStore } from "./edge-book.ts";

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
import { EdgeBookError, EPHEMERAL_TTL_POLICY } from "./types.ts";
import type { Answer, CapabilityAdvertisement, Endorsement, EphemeralPost, EphemeralType, MessageEnvelope, ReceivedPost, ResultAttestation, Signal, StrongRef } from "./types.ts";
import { contentHash, relationshipId, signPayload, verifyPayload, withoutSignature } from "./crypto.ts";
import { now, randomId, readJson, writeJson } from "./fs-json.ts";
import { ATTESTATIONS_FILE, ENDORSEMENTS_FILE, SIGNALS_FILE, CAPABILITIES_FILE, EPHEMERAL_FILE, ANSWERS_FILE, RECEIVED_POSTS_FILE, DEFAULT_SIGNAL_TTL_MS, DEFAULT_EPHEMERAL_TTL_MS } from "./store-files.ts";

export async function attestations(store: EdgeBookStore): Promise<Record<string, ResultAttestation>> {
  return readJson<Record<string, ResultAttestation>>(store.file(ATTESTATIONS_FILE), {});
}

export async function saveAttestations(store: EdgeBookStore, attestations: Record<string, ResultAttestation>): Promise<void> {
  await writeJson(store.file(ATTESTATIONS_FILE), attestations);
}

export async function saveEndorsements(store: EdgeBookStore, endorsements: Record<string, Endorsement>): Promise<void> {
  await writeJson(store.file(ENDORSEMENTS_FILE), endorsements);
}

export async function saveSignals(store: EdgeBookStore, signals: Record<string, Signal>): Promise<void> {
  await writeJson(store.file(SIGNALS_FILE), signals);
}

export async function saveCapabilities(store: EdgeBookStore, capabilities: Record<string, CapabilityAdvertisement>): Promise<void> {
  await writeJson(store.file(CAPABILITIES_FILE), capabilities);
}

export async function createAttestation(store: EdgeBookStore, input: {
    subject_agent_id: string; task_ref: string;
    outcome: ResultAttestation["outcome"]; summary: string;
    evidence?: Record<string, unknown>; created_at?: string;
  }): Promise<ResultAttestation> {
  const identity = await store.identity();
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
  const all = await store.attestations();
  if (!all[attestation_id]) {           // write-once: never rewrite in place (R6)
    all[attestation_id] = attestation;
    await store.saveAttestations(all);
    await store.audit("attestation.create", input.subject_agent_id, { attestation_id, task_ref: input.task_ref });
  }
  return all[attestation_id];
}

export async function verifyAttestation(store: EdgeBookStore, att: ResultAttestation): Promise<boolean> {
  const identity = await store.identity();
  let pub = identity.agent_id === att.attestor_agent_id ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await store.contacts())[att.attestor_agent_id];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, ...signedPayload } = att;
  // integrity: id must equal hash of content (content excludes id+signature)
  const { attestation_id, ...content } = signedPayload;
  if (contentHash(content) !== attestation_id) return false;
  return verifyPayload(signedPayload, signature, pub);
}

export async function verifyCapability(store: EdgeBookStore, cap: CapabilityAdvertisement): Promise<boolean> {
  const identity = await store.identity();
  let pub = identity.agent_id === cap.agent_id ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await store.contacts())[cap.agent_id];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, ...rest } = cap;
  return verifyPayload(rest, signature, pub);
}

export async function verifyEphemeral(store: EdgeBookStore, post: EphemeralPost): Promise<boolean> {
  const identity = await store.identity();
  let pub = identity.agent_id === post.from_agent ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await store.contacts())[post.from_agent];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, lifecycle: _lc, ...signedPayload } = post;
  return verifyPayload(signedPayload, signature, pub);
}

export async function verifyAnswer(store: EdgeBookStore, ans: Answer): Promise<boolean> {
  const identity = await store.identity();
  let pub = identity.agent_id === ans.answerer_agent_id ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await store.contacts())[ans.answerer_agent_id];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, lifecycle: _lc, ...signedPayload } = ans;
  return verifyPayload(signedPayload, signature, pub);
}

export async function verifySignal(store: EdgeBookStore, sig: Signal): Promise<boolean> {
  const identity = await store.identity();
  let pub = identity.agent_id === sig.from_agent ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await store.contacts())[sig.from_agent];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, lifecycle: _lc, ...signedPayload } = sig;
  return verifyPayload(signedPayload, signature, pub);
}

export async function verifyEndorsement(store: EdgeBookStore, e: Endorsement): Promise<boolean> {
  const identity = await store.identity();
  let pub = identity.agent_id === e.endorser_agent_id ? identity.public_key_pem : undefined;
  if (!pub) {
    const c = (await store.contacts())[e.endorser_agent_id];
    pub = c?.public_keys?.[0]?.public_key_pem;
  }
  if (!pub) return false;
  const { signature, ...rest } = e;
  return verifyPayload(rest, signature, pub);
}

export async function endorsements(store: EdgeBookStore): Promise<Record<string, Endorsement>> {
  return readJson<Record<string, Endorsement>>(store.file(ENDORSEMENTS_FILE), {});
}

export async function createEndorsement(store: EdgeBookStore, input: {
    subject_agent_id: string; parent: StrongRef; statement: string;
    evidence_ref?: StrongRef; evidence_task_id?: string;
  }): Promise<Endorsement> {
  if (!input.evidence_ref && !input.evidence_task_id) {
    throw new EdgeBookError("missing_evidence", "Endorse requires an evidence link (Result Attestation ref or task id) — R8");
  }
  if (!input.parent?.uri || !input.parent?.hash) {
    throw new EdgeBookError("missing_parent", "Endorse requires a strongRef parent (uri + hash) — R5");
  }
  const identity = await store.identity();
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
  const all = await store.endorsements();
  all[endorse_id] = endorsement;
  // evidence_ref/evidence_task_id is an open-world link — no referential-integrity check that the attestation exists locally.
  await store.saveEndorsements(all);
  await store.audit("endorse.create", input.subject_agent_id, { endorse_id, parent: input.parent.uri });
  return endorsement;
}

export async function signals(store: EdgeBookStore): Promise<Record<string, Signal>> {
  const raw = await readJson<Record<string, Signal>>(store.file(SIGNALS_FILE), {});
  for (const id of Object.keys(raw)) {
    const sig = raw[id]!; // key comes from Object.keys(raw) — value is present
    sig.lifecycle = signalLifecycle(store, sig);
  }
  return raw;
}

export async function createSignal(store: EdgeBookStore, input: { body: string; ttlMs?: number }): Promise<Signal> {
  const identity = await store.identity();
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
  const all = await store.signals();
  all[signal_id] = signal;
  await store.saveSignals(all);
  await store.audit("signal.create", identity.agent_id, { signal_id });
  return signal;
}

export async function expireSignals(store: EdgeBookStore): Promise<void> {
  const all = await readJson<Record<string, Signal>>(store.file(SIGNALS_FILE), {});
  let changed = false;
  for (const id of Object.keys(all)) {
    const sig = all[id]!; // key comes from Object.keys(all) — value is present
    if (sig.lifecycle !== "expired" && Date.parse(sig.expires_at) <= Date.now()) {
      sig.lifecycle = "expired"; changed = true;
    }
  }
  if (changed) await store.saveSignals(all);
}

export function signalLifecycle(store: EdgeBookStore, sig: Signal): Signal["lifecycle"] {
  return computeLifecycle(sig.expires_at, false, sig.lifecycle) as Signal["lifecycle"];
}

export async function saveEphemeral(store: EdgeBookStore, posts: Record<string, EphemeralPost>): Promise<void> {
  await writeJson(store.file(EPHEMERAL_FILE), posts);
}

export async function ephemeralPosts(store: EdgeBookStore): Promise<Record<string, EphemeralPost>> {
  const raw = await readJson<Record<string, EphemeralPost>>(store.file(EPHEMERAL_FILE), {});
  for (const id of Object.keys(raw)) {
    const post = raw[id]!; // key comes from Object.keys(raw) — value is present
    post.lifecycle = computeLifecycle(post.expires_at, EPHEMERAL_TTL_POLICY[post.post_type].hard, post.lifecycle);
  }
  return raw;
}

export async function createEphemeral(store: EdgeBookStore, type: EphemeralType, input: { body: string; subject_agent_id?: string; ref?: string; ttlMs?: number }): Promise<EphemeralPost> {
  if (!EPHEMERAL_TTL_POLICY[type]) throw new EdgeBookError("unknown_post_type", `Not an ephemeral Class-2 type: ${type}`);
  const identity = await store.identity();
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
  const all = await store.ephemeralPosts();
  all[post_id] = post;
  await store.saveEphemeral(all);
  // actor is always identity.agent_id; subject_agent_id goes in details if relevant
  await store.audit(type + ".create", identity.agent_id, { post_id, ...(input.subject_agent_id ? { subject_agent_id: input.subject_agent_id } : {}) });
  return post;
}

export async function expireEphemeral(store: EdgeBookStore): Promise<void> {
  const all = await readJson<Record<string, EphemeralPost>>(store.file(EPHEMERAL_FILE), {});
  let changed = false;
  for (const id of Object.keys(all)) {
    const post = all[id]!; // key comes from Object.keys(all) — value is present
    const next = computeLifecycle(post.expires_at, EPHEMERAL_TTL_POLICY[post.post_type].hard, post.lifecycle);
    if (next !== post.lifecycle) { post.lifecycle = next; changed = true; }
  }
  if (changed) await store.saveEphemeral(all);
}

export async function cancelEphemeral(store: EdgeBookStore, postId: string): Promise<EphemeralPost> {
  const all = await readJson<Record<string, EphemeralPost>>(store.file(EPHEMERAL_FILE), {});
  const post = all[postId];
  if (!post) throw new EdgeBookError("not_found", `No ephemeral post ${postId}`);
  post.lifecycle = "cancelled";
  await store.saveEphemeral(all);
  await store.audit("ephemeral.cancel", post.from_agent, { post_id: postId });
  return post;
}

export async function saveAnswers(store: EdgeBookStore, answers: Record<string, Answer>): Promise<void> {
  await writeJson(store.file(ANSWERS_FILE), answers);
}

export async function answers(store: EdgeBookStore): Promise<Record<string, Answer>> {
  return readJson<Record<string, Answer>>(store.file(ANSWERS_FILE), {});
}

export async function createAnswer(store: EdgeBookStore, input: { parent: StrongRef; body: string }): Promise<Answer> {
  if (!input.parent?.uri || !input.parent?.hash) {
    throw new EdgeBookError("missing_parent", "Answer requires a strongRef parent (uri + hash) — R5");
  }
  const identity = await store.identity();
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
  const all = await store.answers();
  all[answer_id] = answer;
  await store.saveAnswers(all);
  await store.audit("answer.create", identity.agent_id, { answer_id, parent: input.parent.uri });
  return answer;
}

export async function deleteQuery(store: EdgeBookStore, queryId: string): Promise<void> {
  const eph = await readJson<Record<string, EphemeralPost>>(store.file(EPHEMERAL_FILE), {});
  const q = eph[queryId];
  if (!q || q.post_type !== "query") throw new EdgeBookError("not_found", `No query ${queryId}`);
  q.lifecycle = "tombstoned";
  await store.saveEphemeral(eph);
  const parentUri = "edgebook:query:" + queryId;
  const ans = await store.answers();
  let changed = false;
  for (const id of Object.keys(ans)) {
    const answer = ans[id]!; // key comes from Object.keys(ans) — value is present
    if (answer.parent.uri === parentUri && answer.lifecycle !== "tombstoned") { answer.lifecycle = "tombstoned"; changed = true; }
  }
  if (changed) await store.saveAnswers(ans);
  await store.audit("query.delete", q.from_agent, { query_id: queryId });
}

export async function capabilities(store: EdgeBookStore): Promise<Record<string, CapabilityAdvertisement>> {
  return readJson<Record<string, CapabilityAdvertisement>>(store.file(CAPABILITIES_FILE), {});
}

export async function advertiseCapability(store: EdgeBookStore, input: { name: string; version: string; summary: string }): Promise<CapabilityAdvertisement> {
  const identity = await store.identity();
  const capability_id = randomId("cap");
  const stamp = now();
  const unsigned = {
    capability_id, post_type: "capability_advertisement" as const,
    schema: "edge-book/capability/0.1" as const, agent_id: identity.agent_id,
    name: input.name, version: input.version, summary: input.summary,
    status: "active" as const, created_at: stamp, updated_at: stamp,
  };
  const cap: CapabilityAdvertisement = { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
  const all = await store.capabilities();
  all[capability_id] = cap;
  await store.saveCapabilities(all);
  await store.audit("capability.advertise", identity.agent_id, { capability_id, name: input.name });
  return cap;
}

export async function deprecateCapability(store: EdgeBookStore, capabilityId: string): Promise<CapabilityAdvertisement> {
  const identity = await store.identity();
  const all = await store.capabilities();
  const cap = all[capabilityId];
  if (!cap) throw new EdgeBookError("not_found", `No capability ${capabilityId}`);
  cap.status = "deprecated";        // never delete (R3)
  cap.updated_at = now();
  const { signature: _sig, ...rest } = cap;
  cap.signature = signPayload(rest, identity.private_key_pem);
  await store.saveCapabilities(all);
  await store.audit("capability.deprecate", identity.agent_id, { capability_id: capabilityId });
  return cap;
}

export async function receivedPosts(store: EdgeBookStore): Promise<Record<string, ReceivedPost>> {
  return readJson<Record<string, ReceivedPost>>(store.file(RECEIVED_POSTS_FILE), {});
}

export async function saveReceivedPosts(store: EdgeBookStore, posts: Record<string, ReceivedPost>): Promise<void> {
  await writeJson(store.file(RECEIVED_POSTS_FILE), posts);
}

export async function receivedByCategory(store: EdgeBookStore): Promise<{ signals: Record<string, Signal>; ephemeral: Record<string, EphemeralPost>; answers: Record<string, Answer>; endorsements: Record<string, Endorsement> }> {
  const all = await store.receivedPosts();
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

export async function receivePostPublish(store: EdgeBookStore, envelope: MessageEnvelope): Promise<ReceivedPost> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "post_publish") {
    throw new EdgeBookError("wrong_message_type", "Expected post_publish envelope");
  }
  const contact = (await store.contacts())[envelope.from_agent_id];
  if (!contact || contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", "post_publish only accepted from friends");
  }
  const post = (envelope.body as any).post;
  if (!post || !post.post_type) {
    throw new EdgeBookError("malformed_post_publish", "missing or malformed post in envelope body");
  }
  if (receivedPostAuthor(store, post) !== envelope.from_agent_id) {
    throw new EdgeBookError("author_mismatch", "post author does not match envelope sender");
  }
  const id = receivedPostId(store, post);
  if (!id) {
    throw new EdgeBookError("malformed_post_publish", "post missing id");
  }
  if (!(await verifyReceivedPost(store, post))) {
    throw new EdgeBookError("invalid_signature", "inner post signature invalid");
  }
  const all = await store.receivedPosts();
  const key = envelope.from_agent_id + ":" + id;
  all[key] = post;
  await store.saveReceivedPosts(all);
  await store.audit("post.receive", envelope.from_agent_id, {
    post_type: post.post_type,
    id,
  });
  return post;
}

export async function signPostPublishEnvelope(store: EdgeBookStore, input: { to_agent_id: string; post: ReceivedPost }): Promise<MessageEnvelope> {
  const identity = await store.identity();
  return store.signEnvelope({
    type: "post_publish",
    to_agent_id: input.to_agent_id,
    relationship_id: relationshipId(identity.agent_id, input.to_agent_id),
    capability_id: "",
    ref: "",
    transport: "direct",
    body: { post: input.post } as unknown as Record<string, unknown>,
  });
}

export async function verifyReceivedPost(store: EdgeBookStore, p: any): Promise<boolean> {
  switch (p.post_type) {
    case "signal": return store.verifySignal(p);
    case "answer": return store.verifyAnswer(p);
    case "endorse": return store.verifyEndorsement(p);
    case "query":
    case "share":
    case "coordinate":
    case "delegation_request": return store.verifyEphemeral(p);
    default: return false;
  }
}

export function receivedPostId(store: EdgeBookStore, p: any): string {
  return p.signal_id || p.post_id || p.answer_id || p.endorse_id || "";
}

export function receivedPostAuthor(store: EdgeBookStore, p: any): string {
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
