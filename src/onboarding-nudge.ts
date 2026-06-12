// Durable onboarding nudge (spec-137). The spec-129 onboarding triggers are
// one-shot console prints: the init note (swallowed on the plugin textOnly
// path, which discards the auto-init result) and the spec-135 interactive
// pair auto-fire (never reached on the textOnly branch; dies when the
// invoking agent's tool timeout is shorter than the pairing TTL). When both
// windows are missed, nothing ever starts onboarding. This appends the
// onboarding note to the heartbeat-read commands while the room is still
// empty — throttled, capped, and retiring the moment the first contact or
// object appears (the store is the onboarding state, spec-131 principle).
import type { CliResult } from "./cli-shared.ts";
import type { EdgeBookStore } from "./edge-book.ts";
import { NUDGE_COMMANDS } from "./handle-nudge.ts";

export const ONBOARDING_NUDGE_THROTTLE_MS = 6 * 60 * 60 * 1000; // one emit per 6h
export const ONBOARDING_NUDGE_MAX_EMITS = 3; // then it is a choice, not a missed trigger

// A short pointer, not the full init note: the heartbeat surface repeats, so
// it must stay small, and onboard.md carries the complete script anyway.
export function buildOnboardingNudgeText(): string {
  return [
    `---`,
    `Onboarding incomplete: this agent has no friends and no shares yet — the human was likely never onboarded.`,
    `Load skills/edge-book/prompts/onboard.md and run the first-session script with your human now.`,
  ].join("\n");
}

// Best-effort wrapper, same failure posture as the spec-130 handle nudge:
// any store error leaves the wrapped result untouched. `now` is injectable
// for throttle/cap tests only.
export async function maybeAppendOnboardingNudge(store: EdgeBookStore, command: string, result: CliResult, now = Date.now()): Promise<CliResult> {
  if (!NUDGE_COMMANDS.has(command)) return result;
  try {
    await store.identity(); // throws on an uninitialized home → no nudge
    const config = await store.config();
    const count = config.onboarding_nudge_count ?? 0;
    if (count >= ONBOARDING_NUDGE_MAX_EMITS) return result;
    if (config.onboarding_nudge_at !== undefined && now - config.onboarding_nudge_at < ONBOARDING_NUDGE_THROTTLE_MS) return result;
    const contacts = await store.contacts();
    if (Object.keys(contacts).length > 0) return result; // onboarding underway — retire
    const objects = await store.objects();
    if (Object.keys(objects).length > 0) return result;
    await store.updateConfig({ onboarding_nudge_at: now, onboarding_nudge_count: count + 1 });
    return { ...result, text: `${result.text}\n${buildOnboardingNudgeText()}` };
  } catch {
    return result;
  }
}
