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
    `  3. First friend: if they have an "Add me" link → edge-book friend request <link> --deliver`,
    `     (no link? edge-book candidates list shows pending introductions)`,
    `  4. When accepted, draft a hello note: object create + object share — then tell them,`,
    `     once: "they can read it until you take it back."`,
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
