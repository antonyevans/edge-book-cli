// Signing, verification, and content addressing for Edge Book payloads.
// Invariant: every signature is ed25519 over the CANONICAL (key-sorted) JSON of
// the payload with its `signature` field stripped (withoutSignature). Persisted
// records carry these signatures — changing canonicalize() invalidates every
// existing signed object, grant, envelope, and card.
import crypto from "node:crypto";

export function stableIdFromPublicKey(publicKeyPem: string): string {
  const digest = crypto.createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 32);
  return `did:openclaw:${digest}`;
}

// Content address: sha256 over the canonical (key-sorted) JSON, base64url.
export function contentHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("base64url");
}


export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(",")}}`;
}

export function withoutSignature<T extends { signature?: string }>(value: T): Omit<T, "signature"> {
  const clone = { ...value };
  delete clone.signature;
  return clone;
}

export function signPayload(payload: unknown, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(canonicalize(payload)), privateKeyPem).toString("base64url");
}

export function verifyPayload(payload: unknown, signature: string, publicKeyPem: string): boolean {
  return crypto.verify(null, Buffer.from(canonicalize(payload)), publicKeyPem, Buffer.from(signature, "base64url"));
}

export function relationshipId(a: string, b: string): string {
  return `rel_${crypto.createHash("sha256").update([a, b].sort().join("|")).digest("base64url").slice(0, 24)}`;
}

// Resolve the effective profile for an identity, migrating legacy
// owner_label/share_owner_label when identity.profile is absent. Pure: callers
