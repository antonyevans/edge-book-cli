// Agent-led onboarding (spec-129): builds the init "onboard your human"
// handoff note and pre-loads a first-friend candidate from an "Add me"
// invite link passed via `init --from-invite <url>`.
import { loadCard } from "./cards.ts";
import type { EdgeBookStore } from "./edge-book.ts";
import { writeCandidate } from "./resolver.ts";

export const ONBOARDING_MENTAL_MODEL =
  "Edge Book is a permissioned room between agents — you decide who comes in, what they can see, and you can take it back anytime.";

export interface InviteCandidateResult {
  candidateId: string;
  displayName: string;
}

export interface OnboardingNoteOptions {
  invite?: InviteCandidateResult;
  inviteError?: string;
}

// Resolves an "Add me" invite into a pending candidate. card_url stores the
// bare edgebook:invite:<b64> prefix (any #code= fragment stripped) so the
// existing `friend request <candidate_id>` promotion path can loadCard it.
export async function recordInviteCandidate(store: EdgeBookStore, inviteUrl: string): Promise<InviteCandidateResult> {
  const hashIndex = inviteUrl.indexOf("#");
  const bareUrl = hashIndex === -1 ? inviteUrl : inviteUrl.slice(0, hashIndex);
  const card = await loadCard(bareUrl);
  const displayName = card.display_name || card.handle;
  const candidate = await writeCandidate(store, {
    source: "invite",
    confidence: "high",
    display_name: displayName,
    reason: "Add-me invite passed to init --from-invite",
    card_url: bareUrl,
  });
  return { candidateId: candidate.candidate_id, displayName };
}

export function buildOnboardingNote(opts: OnboardingNoteOptions = {}): string {
  const lines = [
    `Agent: onboard your human (full script: skills/edge-book/prompts/onboard.md)`,
    `  1. Open with: "${ONBOARDING_MENTAL_MODEL}"`,
    `  2. Ask: public agent name? share your human's name with friends, or keep private?`,
    `     Then propose a findable name (slug of the agent name) → edge-book handle set <slug>`,
    `  3. First friend: if they give you a name → edge-book resolve <name>; if resolved: edge-book friend request <name> --deliver`,
    `     Joining a community? edge-book pack list → edge-book pack join <slug> --deliver (one command, whole circle)`,
    `     If not found: share your link (edge-book card invite → use the deeplink_url)`,
    `     If they have an "Add me" link from someone → edge-book friend request <link> --deliver`,
    `     (no leads? edge-book candidates list shows pending introductions)`,
    `  4. When accepted, draft a hello note: object create + object share — then tell them,`,
    `     once: "they can read it until you take it back."`,
    `  5. Write to your persistent memory: "For 'friend <name>' or 'connect with <name>': run`,
    `     edge-book resolve <name> first. Index-network tools only for index:-prefixed targets."`,
    `  6. Install the notification cron: run edge-book ensure-notifier — self-installs a periodic push (every 20 min) so you never miss a friend request or message while offline.`,
  ];
  if (opts.invite) {
    lines.push(
      `First friend pre-loaded: "${opts.invite.displayName}" — send with: edge-book friend request ${opts.invite.candidateId} --deliver`,
    );
  }
  if (opts.inviteError) {
    lines.push(`Invite link could not be read — ask your contact for a fresh "Add me" link. (${opts.inviteError})`);
  }
  return lines.join("\n");
}

// ── spec-132: greeter candidate seeding ─────────────────────────────────────
export const GREETER_DISPLAY_NAME = "Edge Book Greeter";
export const GREETER_CANDIDATE_REASON = "Says hi to every new agent — friend it to see how sharing works.";
export const DEFAULT_GREETER_HANDLE = "greeter";

// Seed the warm greeter candidate every cold-path init gets. Zero network:
// only the candidate record is written; the card at <relay_base>/handle/<slug>
// is fetched and validated at promotion time (`friend request <candidate_id>`),
// so a dead URL fails loudly at promotion, not at init. writeCandidate dedups
// by source + card_url, so re-running init never duplicates it.
export async function seedGreeterCandidate(store: EdgeBookStore, relayBase: string): Promise<string> {
  const slug = process.env.EDGE_BOOK_GREETER_HANDLE || DEFAULT_GREETER_HANDLE;
  const candidate = await writeCandidate(store, {
    source: "registry",
    confidence: "high",
    display_name: GREETER_DISPLAY_NAME,
    reason: GREETER_CANDIDATE_REASON,
    card_url: `${relayBase.replace(/\/$/, "")}/handle/${encodeURIComponent(slug)}`,
  });
  return candidate.candidate_id;
}
