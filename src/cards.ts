// Agent Card + FriendProfile validation and loading.
// validateCard enforces signature, DID derivation (agent_id MUST equal
// stableIdFromPublicKey of the first public key), and card expiry — expired
// cards are rejected (spec-096 §C: a stale invite must not orphan mail).
import fs from "node:fs/promises";
import path from "node:path";
import { EdgeBookError } from "./types.ts";
import type { AgentCard, FriendProfile } from "./types.ts";
import { stableIdFromPublicKey, verifyPayload, withoutSignature } from "./crypto.ts";

export function validateCard(card: AgentCard): void {
  if (card.schema !== "openclaw-agent-card/0.1") throw new EdgeBookError("invalid_card", "Unsupported Agent Card schema");
  if (card.expires_at) {
    const exp = Date.parse(card.expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) {
      throw new EdgeBookError("card_expired", "Card/invite expired — ask the peer for a fresh handle or invite");
    }
  }
  if (!card.agent_id || !card.public_keys?.[0]?.public_key_pem) throw new EdgeBookError("invalid_card", "Agent Card is missing identity key");
  const expectedId = stableIdFromPublicKey(card.public_keys[0].public_key_pem);
  if (card.agent_id !== expectedId) throw new EdgeBookError("invalid_card", "Agent Card agent_id does not match public key");
  if (!verifyPayload(withoutSignature(card), card.signature, card.public_keys[0].public_key_pem)) {
    throw new EdgeBookError("invalid_card", "Agent Card signature is invalid");
  }
}

// Structural + signature validation against a known public key (the peer's card
// key). Throws EdgeBookError on any failure. The agent_id<->sender match is
// checked by the caller (it has the envelope's from_agent_id).
export function validateFriendProfile(profile: FriendProfile, publicKeyPem: string): void {
  if (profile.schema !== "openclaw-friend-profile/0.1") {
    throw new EdgeBookError("invalid_friend_profile", "Unsupported FriendProfile schema");
  }
  if (!profile.agent_id) throw new EdgeBookError("invalid_friend_profile", "FriendProfile missing agent_id");
  if (typeof profile.profile_version !== "number") {
    throw new EdgeBookError("invalid_friend_profile", "FriendProfile missing profile_version");
  }
  if (!verifyPayload(withoutSignature(profile), profile.signature, publicKeyPem)) {
    throw new EdgeBookError("invalid_friend_profile", "FriendProfile signature is invalid");
  }
}

export async function loadCard(cardPathOrUrl: string): Promise<AgentCard> {
  // "Add me" invite link: edgebook:invite:<base64url(signed Agent Card)>.
  if (cardPathOrUrl.startsWith("edgebook:invite:")) {
    const encoded = cardPathOrUrl.slice("edgebook:invite:".length);
    const card = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AgentCard;
    validateCard(card);
    return card;
  }
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
