// One-time handle nudge (spec-130). Agents onboarded before the handle step
// existed (spec-129 never asked) still carry the placeholder handle, so the
// dial-out auto-claim (spec-096) never fires and peers can't find them by
// name. This appends a single nudge — once, ever — to the recurring read
// commands the heartbeat prompts run, telling the agent to ask its human.
import type { CliResult } from "./cli-shared.ts";
import { shouldClaimHandle } from "./dialout.ts";
import type { EdgeBookStore } from "./edge-book.ts";
import { isValidHandle, slugifyHandle } from "./handles.ts";

// Commands the heartbeat prompts run on a schedule — the agent is guaranteed
// to see output from these even when the human never issues a command.
const NUDGE_COMMANDS = new Set(["friend", "ephemeral", "answers"]);

export function buildHandleNudge(suggestion: string | undefined): string {
  const ask = suggestion
    ? `"Want to pick a short name friends can use to find me? I'd suggest '${suggestion}'."`
    : `"Want to pick a short name friends can use to find me?"`;
  return [
    `---`,
    `One-time setup: this agent has no handle yet, so friends can't find it by name.`,
    `Ask your human once: ${ask}`,
    `On yes: edge-book handle set <slug>  (3-30 chars, a-z 0-9 and hyphens; takes effect on the next connect)`,
    `If they decline, do nothing — this reminder will not repeat.`,
  ].join("\n");
}

// Best-effort wrapper: appends the nudge to `result.text` at most once per
// agent home, recording config.handle_nudge_at on emit. Any error (missing
// identity, unreadable config) leaves the wrapped result untouched.
export async function maybeAppendHandleNudge(store: EdgeBookStore, command: string, result: CliResult): Promise<CliResult> {
  if (!NUDGE_COMMANDS.has(command)) return result;
  try {
    const identity = await store.identity();
    if (shouldClaimHandle(identity.handle)) return result;
    const config = await store.config();
    if (config.handle_nudge_at !== undefined) return result;
    await store.updateConfig({ handle_nudge_at: Date.now() });
    const slug = slugifyHandle(identity.display_name || "");
    const suggestion = isValidHandle(slug) ? slug : undefined;
    return { ...result, text: `${result.text}\n\n${buildHandleNudge(suggestion)}` };
  } catch {
    return result; // nudge is best-effort; never break the wrapped command
  }
}
