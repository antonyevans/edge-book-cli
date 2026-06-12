// spec-142 heartbeat update nudge — the fallback trigger surface for agents
// without the notifier cron. When a newer release is known
// (config.update_latest_known, kept fresh by the dial-out's 6h check and by
// self-update runs) and the automatic path cannot apply it — auto_update
// "notify", or "auto" facing cross-major drift (post-1.0 rule) — append a
// short instruction to the heartbeat-read commands. 24h throttle
// (update_nudge_at), uncapped; retires the moment the install is current.
// Machine surfaces stay exempt (spec-132 ruling — same NUDGE_COMMANDS gate
// and the friend auto-accept bypass in cli.ts as every other nudge).
import type { CliResult } from "./cli-shared.ts";
import type { EdgeBookStore } from "./edge-book.ts";
import { NUDGE_COMMANDS } from "./handle-nudge.ts";
import { autoUpdateAllowed, compareVersions, runningVersion } from "./self-update.ts";

export const UPDATE_NUDGE_THROTTLE_MS = 24 * 60 * 60 * 1000; // one emit per 24h

export function buildUpdateNudgeText(home: string, running: string, latest: string): string {
  return [
    `---`,
    `Edge Book update available: this install runs ${running}; the latest release is ${latest}.`,
    `Run: edge-book self-update --home ${home}`,
    `If a dial-out process is running unsupervised, restart it after the update so it picks up the new code.`,
  ].join("\n");
}

// Best-effort wrapper, same failure posture as spec-137/spec-141: any store
// error leaves the wrapped result untouched. `now` and `running` are
// injectable for tests only.
export async function maybeAppendUpdateNudge(
  store: EdgeBookStore,
  command: string,
  result: CliResult,
  now = Date.now(),
  running?: string,
): Promise<CliResult> {
  if (!NUDGE_COMMANDS.has(command)) return result;
  try {
    await store.identity(); // throws on an uninitialized home → no nudge
    const config = await store.config();
    const mode = config.auto_update ?? "auto";
    if (mode === "off") return result; // kill switch silences every surface
    const latest = config.update_latest_known;
    const current = running ?? (await runningVersion());
    if (!latest || compareVersions(latest, current) <= 0) return result; // current → retired
    if (mode === "auto" && autoUpdateAllowed(current, latest)) return result; // the cron/exit-75 path owns it
    if (config.update_nudge_at !== undefined && now - config.update_nudge_at < UPDATE_NUDGE_THROTTLE_MS) return result;
    await store.updateConfig({ update_nudge_at: now });
    return { ...result, text: `${result.text}\n${buildUpdateNudgeText(store.home, current, latest)}` };
  } catch {
    return result; // nudge is best-effort; never break the wrapped command
  }
}
