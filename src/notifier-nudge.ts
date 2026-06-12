// Notifier prompt migration nudge (spec-141). On agent-tool schedulers (the
// Hermes built-in cronjob tool — no shell CLI), no code path can recreate the
// legacy 0.11.0-pinned notifier prompt mechanically: spec-139's getPrompt
// returns null and ensureNotifierCron conservatively keeps the stale job.
// Only the agent itself can fix it, via its scheduler tool — so this appends
// migration instructions to the heartbeat-read commands (spec-137 surface)
// until the agent acks the current NOTIFIER_PROMPT_VERSION. Throttled to one
// emit per 6h but UNCAPPED: an un-migrated notifier silently loses friend
// requests, so the nudge retires only on ack. Where the hermes shell CLI is
// detected, the mechanical path owns migration and this stays silent.
import type { CliResult } from "./cli-shared.ts";
import type { EdgeBookStore } from "./edge-book.ts";
import { NUDGE_COMMANDS } from "./handle-nudge.ts";
import {
  DEFAULT_FRIEND_REQUESTS_SCHEDULE,
  FRIEND_REQUESTS_CRON_NAME,
  NOTIFIER_PROMPT_VERSION,
  hermesCliDetected,
} from "./host-cron.ts";

export const NOTIFIER_NUDGE_THROTTLE_MS = 6 * 60 * 60 * 1000; // one emit per 6h

// Short and imperative: the heartbeat surface repeats, and the agent only
// needs the two commands — --print-prompt for the paste-ready text, --ack to
// retire this notice.
export function buildNotifierNudgeText(home: string): string {
  return [
    `---`,
    `Your scheduled job "${FRIEND_REQUESTS_CRON_NAME}" runs an outdated prompt and silently loses friend requests.`,
    `Using your scheduler tool, update that job's prompt to the exact output of: edge-book ensure-notifier --print-prompt --home ${home}`,
    `(If the job does not exist, create it with schedule ${DEFAULT_FRIEND_REQUESTS_SCHEDULE} and telegram delivery.)`,
    `Then run: edge-book ensure-notifier --ack --home ${home}  so this notice retires.`,
  ].join("\n");
}

// Best-effort wrapper, same failure posture as spec-137: any store error
// leaves the wrapped result untouched. `now` and `hermesDetected` are
// injectable for tests only.
export async function maybeAppendNotifierNudge(
  store: EdgeBookStore,
  command: string,
  result: CliResult,
  now = Date.now(),
  hermesDetected: () => boolean = hermesCliDetected,
): Promise<CliResult> {
  if (!NUDGE_COMMANDS.has(command)) return result;
  try {
    await store.identity(); // throws on an uninitialized home → no nudge
    const config = await store.config();
    if ((config.notifier_prompt_ack ?? 0) >= NOTIFIER_PROMPT_VERSION) return result;
    if (hermesDetected()) return result; // hermes shell CLI present → mechanical path owns migration
    if (config.notifier_nudge_at !== undefined && now - config.notifier_nudge_at < NOTIFIER_NUDGE_THROTTLE_MS) return result;
    await store.updateConfig({ notifier_nudge_at: now });
    return { ...result, text: `${result.text}\n${buildNotifierNudgeText(store.home)}` };
  } catch {
    return result; // nudge is best-effort; never break the wrapped command
  }
}
