// Edge Book resolver (ea-openclaw-031 Pass 2). Resolves a target
// (local handle / card file / card URL / invite / registry handle / Index
// opportunity) to a verified Agent Card or an approval-required candidate.
// Trust ALWAYS flows from validateCard — Index never asserts an agent_id.
// Spec: tasks/ea/ea-openclaw-030-.../authoring-spec.md (+ 2026-06-08 addendum).
import type { AgentCard, EdgeBookStore } from "./edge-book.ts";

export type ResolverStatus = "resolved" | "candidates" | "approval_required" | "not_found";
export type ProvenanceSource = "local" | "card_file" | "card_url" | "invite" | "registry" | "index";
export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  source: ProvenanceSource;
  confidence: Confidence;
  display_name: string;
  reason: string;
  network?: string;
}

export interface Candidate {
  candidate_id: string;
  source: ProvenanceSource;
  confidence: Confidence;
  display_name: string;
  reason: string;
  network?: string;
  card_url?: string;
  agent_id?: string; // absent until a real card is verified
  approved: boolean;
  created_at: string;
}

export interface ResolverResult {
  status: ResolverStatus;
  card?: AgentCard;
  agent_id?: string;
  candidates?: Candidate[];
  provenance?: Provenance;
  next_action: string;
}

export function nextAction(result: ResolverResult, target: string): string {
  switch (result.status) {
    case "resolved":
      return `friend request ${target} --deliver`;
    case "approval_required":
    case "candidates": {
      const first = result.candidates?.[0];
      return first ? `candidates list   # then: friend request ${first.candidate_id}` : "candidates list";
    }
    default:
      return "(no match — check the target)";
  }
}

export interface ProviderResult {
  kind: "card" | "candidate";
  card?: AgentCard;
  agent_id?: string;
  candidate?: Omit<Candidate, "candidate_id" | "approved" | "created_at">;
  provenance: Provenance;
}

export interface ResolverProvider {
  name: string;
  priority: number;
  resolve(store: EdgeBookStore, target: string): Promise<ProviderResult | null>;
}

export const localContactProvider: ResolverProvider = {
  name: "local",
  priority: 100,
  async resolve(store, target) {
    const contacts = await store.contacts();
    const match = Object.values(contacts).find(
      (c) => c.peer_agent_id === target || c.aliases.includes(target) || c.display_name === target
    );
    if (!match) return null;
    return {
      kind: "card",
      agent_id: match.peer_agent_id,
      provenance: {
        source: "local",
        confidence: "high",
        display_name: match.display_name,
        reason: `known contact (relationship_state=${match.relationship_state})`,
      },
    };
  },
};
