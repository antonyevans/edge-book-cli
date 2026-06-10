// Agent -> human escalations (spec-094): a free-form ask raised by an agent
// (local: its own owner; remote: a friend's owner) that surfaces in the
// human's reader; the answer routes back to the requesting agent.
//
// Extracted from EdgeBookStore (2026-06-09 legibility refactor); each public
// function is called by a same-named one-line delegate method on EdgeBookStore.
// Invariants:
//   - remote raise is gated on friend-state + an escalation.raise grant,
//     FAIL CLOSED (spec-094 D4); acceptFriend issues that grant by default;
//   - receivers materialise the remote record keyed by the SAME escalation_id
//     (dedupe key for the response routing);
//   - answers are persisted BEFORE any relay attempt — a relay failure must
//     never fail the human's answer (see dialout.ts auto-relay).
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { Escalation, EscalationBody, EscalationKind, EscalationResponseBody, MessageEnvelope } from "./types.ts";
import { now, randomId, readJson, writeJson } from "./fs-json.ts";
import { ESCALATIONS_FILE } from "./store-files.ts";
import { relationshipId } from "./crypto.ts";

export async function escalations(store: EdgeBookStore): Promise<Record<string, Escalation>> {
  return readJson<Record<string, Escalation>>(store.file(ESCALATIONS_FILE), {});
}

export async function saveEscalations(store: EdgeBookStore, escalations: Record<string, Escalation>): Promise<void> {
  await writeJson(store.file(ESCALATIONS_FILE), escalations);
}

export async function putEscalation(store: EdgeBookStore, escalation: Escalation): Promise<void> {
  const all = await store.escalations();
  all[escalation.escalation_id] = escalation;
  await store.saveEscalations(all);
}

export async function raiseEscalation(store: EdgeBookStore, input: {
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
  const identity = await store.identity();
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
    escalation.audit_refs.push(await store.audit("escalation.raise", identity.agent_id, { escalation_id: escalation.escalation_id, kind: escalation.kind, local: true }));
    await putEscalation(store, escalation);
    return { escalation };
  }

  // Remote: ask a friend's human. Gate on friend-state + escalation.raise grant.
  const contacts = await store.contacts();
  const contact = contacts[input.to];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${input.to}`);
  if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked", `Peer ${input.to} is blocked`);
  if (contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", `Cannot escalate to relationship_state=${contact.relationship_state}`);
  }
  const grant = await store.findUsableGrant(input.to, "escalation.raise");
  if (!grant) throw new EdgeBookError("missing_grant", `No active escalation.raise grant for ${input.to}`);
  await store.assertGrantSignature(grant);

  const envelope = await store.signEnvelope({
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
  escalation.audit_refs.push(await store.audit("escalation.raise", input.to, { escalation_id: escalation.escalation_id, kind: escalation.kind, message_id: envelope.message_id }));
  await putEscalation(store, escalation); // requester keeps its own copy to track
  return { escalation, envelope };
}

export async function receiveEscalation(store: EdgeBookStore, envelope: MessageEnvelope): Promise<Escalation> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "escalation") throw new EdgeBookError("wrong_message_type", "Expected escalation envelope");
  const contacts = await store.contacts();
  const contact = contacts[envelope.from_agent_id];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${envelope.from_agent_id}`);
  if (contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", `Cannot receive escalation from relationship_state=${contact.relationship_state}`);
  }
  const grants = await store.grants();
  const grant = grants[envelope.capability_id];
  if (!grant || grant.status !== "active" || grant.subject_agent_id !== envelope.from_agent_id || !grant.scopes.includes("escalation.raise")) {
    throw new EdgeBookError("missing_grant", "Escalation does not carry an active escalation.raise grant issued to sender");
  }
  await store.assertGrantSignature(grant);

  const identity = await store.identity();
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
  escalation.audit_refs.push(await store.audit("escalation.receive", envelope.from_agent_id, { escalation_id: escalation.escalation_id, kind: escalation.kind }));
  await putEscalation(store, escalation);
  return escalation;
}

export async function answerEscalation(store: EdgeBookStore, escalationId: string, input: { text?: string; choice?: string }): Promise<Escalation & { envelope?: MessageEnvelope }> {
  const identity = await store.identity();
  const all = await store.escalations();
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
  escalation.audit_refs.push(await store.audit("escalation.answer", escalation.raised_by_agent_id, { escalation_id: escalationId }));
  all[escalationId] = escalation;
  await store.saveEscalations(all);

  // Route back only if a *remote* agent raised this (we are answering on behalf
  // of our own human for someone else's request).
  let envelope: MessageEnvelope | undefined;
  if (escalation.raised_by_agent_id !== identity.agent_id) {
    envelope = await store.signEnvelope({
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

export async function applyEscalationResponse(store: EdgeBookStore, envelope: MessageEnvelope): Promise<Escalation> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "escalation_response") throw new EdgeBookError("wrong_message_type", "Expected escalation_response envelope");
  const body = envelope.body as unknown as EscalationResponseBody;
  const all = await store.escalations();
  const escalation = all[body.escalation_id];
  if (!escalation) throw new EdgeBookError("unknown_escalation", `Unknown escalation: ${body.escalation_id}`);
  escalation.status = body.status;
  escalation.answer_text = body.answer_text;
  escalation.answer_choice = body.answer_choice;
  escalation.answered_at = body.answered_at;
  escalation.answered_by = "local-owner";
  escalation.audit_refs.push(await store.audit("escalation.response", envelope.from_agent_id, { escalation_id: body.escalation_id, status: body.status }));
  all[body.escalation_id] = escalation;
  await store.saveEscalations(all);
  return escalation;
}

export async function expireEscalations(store: EdgeBookStore): Promise<void> {
  const all = await store.escalations();
  let changed = false;
  for (const escalation of Object.values(all)) {
    if (escalation.status === "pending" && Date.parse(escalation.expires_at) <= Date.now()) {
      escalation.status = "expired";
      changed = true;
    }
  }
  if (changed) await store.saveEscalations(all);
}
