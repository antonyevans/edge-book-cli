// Edge Book MVP shared objects (spec-0020 R2/R3): create, share, read, revoke.
//
// Extracted from EdgeBookStore (2026-06-09 legibility refactor); each function
// is called by a same-named one-line delegate method on EdgeBookStore.
// Invariants:
//   - FAIL CLOSED: canReadObject permits a read IFF an active, unexpired,
//     SIGNATURE-VERIFIED object.read grant exists for (object_id, subject)
//     (Contract 2 — mirror of canRead() in edge-book-host/src/contracts.ts;
//     grant signature verification is plan-031 check #6).
//   - a permitted read writes an object_access audit event; denials audit too.
//   - attachment bytes are agent-held (attachments/ dir); the host never
//     stores them (R2b: at most ONE attachment per object).
//   - NO status/delivery/verification field on objects (spec-0020 R4).
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { CapabilityGrant, MessageEnvelope, ObjectRevokeBody, ObjectShareBody, SharedObject, SharedObjectAttachment } from "./types.ts";
import { relationshipId, signPayload, withoutSignature } from "./crypto.ts";
import { now, randomId, readJson, writeJson } from "./fs-json.ts";
import { ATTACHMENTS_DIR, OBJECTS_FILE } from "./store-files.ts";
import fs from "node:fs/promises";
import path from "node:path";

export async function objects(store: EdgeBookStore): Promise<Record<string, SharedObject>> {
  return readJson<Record<string, SharedObject>>(store.file(OBJECTS_FILE), {});
}

export async function saveObjects(store: EdgeBookStore, objects: Record<string, SharedObject>): Promise<void> {
  await writeJson(store.file(OBJECTS_FILE), objects);
}

export async function getObject(store: EdgeBookStore, objectId: string): Promise<SharedObject | undefined> {
  return (await store.objects())[objectId];
}

export async function createObject(store: EdgeBookStore, input: {
    title: string;
    body: string;
    attachment?: { filename: string; mime: string; bytes: Buffer };
  }): Promise<SharedObject> {
  const identity = await store.identity();
  const object_id = randomId("obj");
  let attachment: SharedObjectAttachment | undefined;
  if (input.attachment) {
    const ref = path.join(ATTACHMENTS_DIR, `${object_id}-${input.attachment.filename}`);
    await fs.mkdir(store.file(ATTACHMENTS_DIR), { recursive: true });
    await fs.writeFile(store.file(ref), input.attachment.bytes);
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
  const objects = await store.objects();
  objects[object_id] = object;
  await store.saveObjects(objects);
  await store.audit("object.create", identity.agent_id, { object_id, has_attachment: Boolean(attachment) });
  return object;
}

export async function issueObjectGrant(store: EdgeBookStore, subjectAgentId: string, objectId: string, expiresAt = ""): Promise<CapabilityGrant> {
  const identity = await store.identity();
  if (!(await store.getObject(objectId))) throw new EdgeBookError("unknown_object", `Unknown object: ${objectId}`);
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
  await store.storeGrant(grant);
  await store.audit("grant.issue", subjectAgentId, { grant_id: grant.grant_id, object_id: objectId, scope: "object.read" });
  return grant;
}

export async function canReadObject(store: EdgeBookStore, objectId: string, subjectAgentId: string, at = Date.now()): Promise<boolean> {
  const object = await store.getObject(objectId);
  if (object && object.from_agent === subjectAgentId) return true; // owner
  const grants = await store.grants();
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
    if (await store.verifyGrantSignature(grant)) return true;
  }
  await store.audit("object.read.denied", subjectAgentId, { object_id: objectId, scope: "object.read" });
  return false;
}

export async function readObject(store: EdgeBookStore, objectId: string, subjectAgentId: string): Promise<SharedObject> {
  const object = await store.getObject(objectId);
  if (!object || !(await store.canReadObject(objectId, subjectAgentId))) {
    throw new EdgeBookError("access_denied", `No active object.read grant for (${objectId}, ${subjectAgentId})`);
  }
  await store.audit("object.access", subjectAgentId, { object_id: objectId });
  return object;
}

export async function readAttachmentBytes(store: EdgeBookStore, objectId: string): Promise<Buffer> {
  const object = await store.getObject(objectId);
  if (!object?.attachment) throw new EdgeBookError("no_attachment", `No attachment for ${objectId}`);
  return fs.readFile(store.file(object.attachment.ref));
}

export async function sharedObjectsFor(store: EdgeBookStore, subjectAgentId?: string): Promise<SharedObject[]> {
  const subject = subjectAgentId ?? (await store.identity()).agent_id;
  const objects = await store.objects();
  const out: SharedObject[] = [];
  for (const object of Object.values(objects)) {
    if (object.from_agent === subject) continue; // own objects aren't "shared with me"
    if (await store.canReadObject(object.object_id, subject)) out.push(object);
  }
  return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

export async function shareObjectEnvelope(store: EdgeBookStore, peerAgentId: string, objectId: string, expiresAt = ""): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const contact = (await store.contacts())[peerAgentId];
  if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
  if (contact.relationship_state !== "friend") {
    throw new EdgeBookError("not_friend", `Cannot share to relationship_state=${contact.relationship_state}`);
  }
  const object = await store.getObject(objectId);
  if (!object) throw new EdgeBookError("unknown_object", `Unknown object: ${objectId}`);
  const grant = await store.issueObjectGrant(peerAgentId, objectId, expiresAt);
  let attachment_b64: string | undefined;
  if (object.attachment) {
    attachment_b64 = (await fs.readFile(store.file(object.attachment.ref))).toString("base64");
  }
  await store.audit("object.share", peerAgentId, { object_id: objectId, grant_id: grant.grant_id, scope: "object.read" });
  return store.signEnvelope({
    type: "object_share",
    to_agent_id: peerAgentId,
    relationship_id: relationshipId(identity.agent_id, peerAgentId),
    capability_id: grant.grant_id,
    ref: objectId,
    transport: "local",
    body: { object, grant, ...(attachment_b64 ? { attachment_b64 } : {}) } as unknown as Record<string, unknown>
  });
}

export async function receiveObjectShare(store: EdgeBookStore, envelope: MessageEnvelope): Promise<SharedObject> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "object_share") throw new EdgeBookError("wrong_message_type", "Expected object_share envelope");
  await store.enforceInboundRate(envelope.from_agent_id);
  const identity = await store.identity();
  const body = envelope.body as unknown as ObjectShareBody;
  const { object, grant } = body;
  if (!object || !grant) throw new EdgeBookError("malformed_object_share", "object_share missing object or grant");
  if (object.from_agent !== envelope.from_agent_id) throw new EdgeBookError("agent_id_mismatch", "Shared object author does not match sender");
  if (grant.object_id !== object.object_id || grant.subject_agent_id !== identity.agent_id || !grant.scopes.includes("object.read")) {
    throw new EdgeBookError("grant_mismatch", "Grant does not bind this object to me with object.read");
  }
  if (body.attachment_b64 && object.attachment) {
    await fs.mkdir(store.file(ATTACHMENTS_DIR), { recursive: true });
    await fs.writeFile(store.file(object.attachment.ref), Buffer.from(body.attachment_b64, "base64"));
  }
  const objects = await store.objects();
  objects[object.object_id] = object;
  await store.saveObjects(objects);
  await store.storeGrant(grant);
  await store.audit("object.receive", envelope.from_agent_id, { object_id: object.object_id, grant_id: grant.grant_id });
  return object;
}

export async function revokeObjectGrant(store: EdgeBookStore, objectId: string, subjectAgentId: string): Promise<string[]> {
  const grants = await store.grants();
  const revoked: string[] = [];
  for (const grant of Object.values(grants)) {
    if (grant.object_id === objectId && grant.subject_agent_id === subjectAgentId && grant.status === "active") {
      grant.status = "revoked";
      grant.revoked_at = now();
      revoked.push(grant.grant_id);
    }
  }
  if (revoked.length) {
    await store.saveGrants(grants);
    await store.audit("grant.revoke", subjectAgentId, { object_id: objectId, grant_ids: revoked, scope: "object.read" });
  }
  return revoked;
}

export async function revokeObjectEnvelope(store: EdgeBookStore, peerAgentId: string, objectId: string): Promise<MessageEnvelope> {
  const identity = await store.identity();
  const revoked = await store.revokeObjectGrant(objectId, peerAgentId);
  return store.signEnvelope({
    type: "object_revoke",
    to_agent_id: peerAgentId,
    relationship_id: relationshipId(identity.agent_id, peerAgentId),
    capability_id: revoked[0] || "",
    ref: objectId,
    transport: "local",
    body: { object_id: objectId, grant_id: revoked[0] || "" } satisfies ObjectRevokeBody as unknown as Record<string, unknown>
  });
}

export async function receiveObjectRevoke(store: EdgeBookStore, envelope: MessageEnvelope): Promise<void> {
  await store.verifyEnvelope(envelope);
  if (envelope.type !== "object_revoke") throw new EdgeBookError("wrong_message_type", "Expected object_revoke envelope");
  const body = envelope.body as unknown as ObjectRevokeBody;
  const grants = await store.grants();
  let changed = false;
  for (const grant of Object.values(grants)) {
    if (grant.object_id === body.object_id && grant.issuer_agent_id === envelope.from_agent_id && grant.status === "active") {
      grant.status = "revoked";
      grant.revoked_at = now();
      changed = true;
    }
  }
  if (changed) await store.saveGrants(grants);
  await store.audit("object.revoke.receive", envelope.from_agent_id, { object_id: body.object_id });
}
