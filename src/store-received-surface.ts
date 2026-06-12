// spec-140 — received-posts CLI surface: the agent-visible view of friends'
// posts. store-taxonomy.ts owns ingest (receivePostPublish) and bucketing
// (receivedByCategory); this module owns the read-side selection rules the
// CLI surfaces. Free functions only — edge-book.ts is at its size cap, no
// delegates (same precedent as store-support.ts).
import type { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { EphemeralPost } from "./types.ts";

/**
 * Received Class-2 ephemeral posts that are still actionable: lifecycle
 * "active" AND unexpired. Received posts keep the lifecycle the sender
 * stamped (we never mutate them), so expiry must be checked against
 * expires_at here, not trusted from the stored field.
 */
export async function activeReceivedEphemeral(store: EdgeBookStore): Promise<Record<string, EphemeralPost>> {
  const { ephemeral } = await store.receivedByCategory();
  const out: Record<string, EphemeralPost> = {};
  for (const [key, post] of Object.entries(ephemeral)) {
    if (post.lifecycle === "active" && Date.parse(post.expires_at) > Date.now()) out[key] = post;
  }
  return out;
}

/**
 * Resolve a received query by its post_id across senders (the received store
 * is keyed `<sender>:<post_id>`). Returns null when no received post carries
 * that id; throws `ambiguous_query` when the same id arrived from multiple
 * senders — the parent strongRef would be undecidable.
 */
export async function resolveReceivedQuery(store: EdgeBookStore, queryId: string): Promise<{ post: EphemeralPost; author: string } | null> {
  const { ephemeral } = await store.receivedByCategory();
  const matches = Object.values(ephemeral).filter((p) => p.post_id === queryId);
  if (matches.length === 0) return null;
  if (new Set(matches.map((p) => p.from_agent)).size > 1) {
    throw new EdgeBookError("ambiguous_query", `Query ${queryId} was received from multiple senders — cannot resolve which to answer`);
  }
  const post = matches[0]!;
  return { post, author: post.from_agent };
}
