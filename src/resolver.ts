// Edge Book resolver (ea-openclaw-031 Pass 2). Resolves a target
// (local handle / card file / card URL / invite / registry handle / Index
// opportunity) to a verified Agent Card or an approval-required candidate.
// Trust ALWAYS flows from validateCard — Index never asserts an agent_id.
// Spec: tasks/ea/ea-openclaw-030-.../authoring-spec.md (+ 2026-06-08 addendum).
import { loadCard, readJson, writeJson, randomId, EdgeBookError } from "./edge-book.ts";
import type { AgentCard, EdgeBookStore, MessageEnvelope } from "./edge-book.ts";

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

function cardProvider(name: string, source: ProvenanceSource, match: (t: string) => boolean): ResolverProvider {
  return {
    name,
    priority: 90,
    async resolve(_store, target) {
      if (!match(target)) return null;
      const card = await loadCard(target); // validateCard runs inside; throws on forgery
      return {
        kind: "card",
        card,
        agent_id: card.agent_id,
        provenance: { source, confidence: "high", display_name: card.handle, reason: `${source} card verified` },
      };
    },
  };
}

export const inviteProvider = cardProvider("invite", "invite", (t) => t.startsWith("edgebook:invite:"));
export const cardUrlProvider = cardProvider("card_url", "card_url", (t) => /^https?:\/\//.test(t));
export const cardFileProvider = cardProvider("card_file", "card_file", (t) =>
  t.startsWith("file://") || t.startsWith("/") || t.startsWith("./") || t.endsWith(".json")
);

// Configurable per the 030 Index addendum: which open-vocab Index fields may
// carry an Edge Book card URL. Confirm with Seref; changing this is one line.
export const INDEX_CARD_URL_FIELDS = ["edge_book_card", "website", "websites"] as const;

export interface IndexOpportunity {
  message: string;
  accept_url: string;
  socials?: Record<string, string>;
  network?: string;
}

export type IndexSource = (target: string) => Promise<IndexOpportunity[]>;

function cardUrlFromSocials(socials?: Record<string, string>): string | undefined {
  if (!socials) return undefined;
  for (const field of INDEX_CARD_URL_FIELDS) {
    if (socials[field]) return socials[field];
  }
  return undefined;
}

export function makeIndexProvider(source: IndexSource): ResolverProvider {
  return {
    name: "index",
    priority: 10,
    async resolve(_store, target) {
      if (!target.startsWith("index:")) return null;
      const opportunities = await source(target);
      if (opportunities.length === 0) return null;
      const opp = opportunities[0];
      const display = opp.message.slice(0, 60);
      return {
        kind: "candidate",
        candidate: {
          source: "index",
          confidence: "low",
          display_name: display,
          reason: opp.message,
          network: opp.network,
          card_url: cardUrlFromSocials(opp.socials),
          // agent_id intentionally omitted — trust comes only from validateCard at promotion.
        },
        provenance: { source: "index", confidence: "low", display_name: display, reason: opp.message, network: opp.network },
      };
    },
  };
}

const CANDIDATES_FILE = "candidates.json";

type CandidateInput = Omit<Candidate, "candidate_id" | "approved" | "created_at">;

function candidateKey(c: { source: ProvenanceSource; card_url?: string; agent_id?: string }): string {
  return `${c.source}:${c.card_url ?? c.agent_id ?? ""}`;
}

async function readCandidates(store: EdgeBookStore): Promise<Record<string, Candidate>> {
  return readJson<Record<string, Candidate>>(store.file(CANDIDATES_FILE), {});
}

export async function listCandidates(store: EdgeBookStore): Promise<Candidate[]> {
  return Object.values(await readCandidates(store));
}

export async function getCandidate(store: EdgeBookStore, id: string): Promise<Candidate | undefined> {
  return (await readCandidates(store))[id];
}

export async function writeCandidate(store: EdgeBookStore, input: CandidateInput): Promise<Candidate> {
  const map = await readCandidates(store);
  const existing = Object.values(map).find((c) => candidateKey(c) === candidateKey(input));
  if (existing) return existing;
  const candidate: Candidate = {
    candidate_id: randomId("cand"),
    approved: false,
    created_at: new Date().toISOString(),
    ...input,
  };
  map[candidate.candidate_id] = candidate;
  await writeJson(store.file(CANDIDATES_FILE), map);
  await store.audit("candidate.write", candidate.agent_id ?? "", { candidate_id: candidate.candidate_id, source: candidate.source });
  return candidate;
}

export function defaultProviders(relayBase?: string): ResolverProvider[] {
  const lookup: RegistryLookup = async (target) => {
    if (!relayBase) return null;
    const slug = target.startsWith("registry:") ? target.slice("registry:".length) : target;
    return `${relayBase.replace(/\/$/, "")}/handle/${encodeURIComponent(slug)}`;
  };
  return [localContactProvider, inviteProvider, cardUrlProvider, cardFileProvider, makeRegistryProvider(lookup)];
}

export interface ResolveOptions {
  providers: ResolverProvider[];
}

export async function resolveTarget(store: EdgeBookStore, target: string, opts: ResolveOptions): Promise<ResolverResult> {
  const ordered = [...opts.providers].sort((a, b) => b.priority - a.priority);
  for (const provider of ordered) {
    const r = await provider.resolve(store, target);
    if (!r) continue;
    if (r.kind === "card") {
      const result: ResolverResult = { status: "resolved", card: r.card, agent_id: r.agent_id, provenance: r.provenance, next_action: "" };
      result.next_action = nextAction(result, target);
      return result;
    }
    const candidate = await writeCandidate(store, r.candidate!);
    const result: ResolverResult = { status: "approval_required", candidates: [candidate], provenance: r.provenance, next_action: "" };
    result.next_action = nextAction(result, target);
    return result;
  }
  return { status: "not_found", next_action: "(no match — check the target)" };
}

export async function dropCandidate(store: EdgeBookStore, candidateId: string): Promise<void> {
  const map = await readJson<Record<string, Candidate>>(store.file(CANDIDATES_FILE), {});
  if (!map[candidateId]) return;
  delete map[candidateId];
  await writeJson(store.file(CANDIDATES_FILE), map);
}

// Mark a candidate approved and bind the verified agent_id (idempotent).
export async function markCandidateApproved(store: EdgeBookStore, candidateId: string, agentId: string): Promise<void> {
  const map = await readJson<Record<string, Candidate>>(store.file(CANDIDATES_FILE), {});
  if (!map[candidateId]) return;
  map[candidateId].approved = true;
  map[candidateId].agent_id = agentId;
  await writeJson(store.file(CANDIDATES_FILE), map);
}

export async function promoteCandidate(store: EdgeBookStore, candidateId: string, note = ""): Promise<MessageEnvelope> {
  const candidate = await getCandidate(store, candidateId);
  if (!candidate) throw new EdgeBookError("unknown_candidate", `No candidate ${candidateId}`);
  if (!candidate.card_url) {
    await store.audit("candidate.denied", "", { candidate_id: candidateId, reason: "no_card_url" });
    throw new EdgeBookError("candidate_not_resolvable", "Candidate has no card_url to verify; cannot promote");
  }
  const card = await loadCard(candidate.card_url); // validateCard runs inside; throws on forgery
  const envelope = await store.createFriendRequest(card, note);
  await markCandidateApproved(store, candidateId, card.agent_id);
  await store.audit("candidate.promoted", card.agent_id, { candidate_id: candidateId });
  return envelope;
}

export type RegistryLookup = (handle: string) => Promise<string | null>; // returns a loadCard-able target

// Bare-handle slug shape: lowercase alphanumerics + internal hyphens, 3–30 chars.
const HANDLE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export function makeRegistryProvider(lookup: RegistryLookup): ResolverProvider {
  return {
    name: "registry",
    priority: 50,
    async resolve(_store, target) {
      const isExplicit = target.startsWith("registry:");
      const slug = isExplicit ? target.slice("registry:".length) : target;
      if (!isExplicit && !HANDLE_SLUG.test(slug)) return null; // only bare slugs route here
      const cardTarget = await lookup(target);
      if (!cardTarget) return null;
      // A registry miss (404/unreachable) means "not in registry" — fall through, don't crash resolve.
      let card;
      try {
        card = await loadCard(cardTarget); // validateCard inside (sig + expiry)
      } catch (e) {
        if (e instanceof EdgeBookError && e.code === "card_fetch_failed") return null; // genuine registry miss → fall through
        throw e; // invalid_card / card_expired → surface the forgery loudly
      }
      return {
        kind: "card",
        card,
        agent_id: card.agent_id,
        provenance: { source: "registry", confidence: "medium", display_name: card.handle, reason: "handle registry lookup" },
      };
    },
  };
}
