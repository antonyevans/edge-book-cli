import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Host cron self-install (ea-claude-125): when the dial-out runs on a recognized
// host, idempotently ensure the friend-request notifier is provisioned — so a
// user gets notifications by just running edge-book, with no manual cron and no
// dependency on an external installer. Detection-gated + disable-able; the core
// stays transport-free, this is an opt-in *host adapter*.
//
// Hermes delivers via cron (it has no standalone one-shot sender), so the Hermes
// adapter registers a `hermes cron … --deliver telegram` job. The "Edge Book —"
// name prefix keeps it distinct from agentvillage's "Edge —" jobs so the two
// never fight (agentvillage's reconciler only manages the "Edge —" prefix).

export const FRIEND_REQUESTS_CRON_NAME = "Edge Book — friend requests";
export const DEFAULT_FRIEND_REQUESTS_SCHEDULE = "*/20 * * * *";
const HERMES_BIN_CANDIDATES = ["/opt/hermes/.venv/bin/hermes"];

// Natural-language cron prompt for Hermes. Replies with the Hermes no-reply
// marker `[SILENT]` when nothing is pending or Edge Book is unavailable, so quiet
// cycles never ping. The agent's edge-book home is pinned so it reads the right state.
export function buildFriendRequestsPrompt(home: string): string {
  return [
    "You are the Edge Book friend-request notifier. Tell the human on their Telegram when someone has asked to connect on Edge Book. Hermes delivers your final assistant reply to their chat.",
    "",
    "This runs every 20 minutes; most runs there will be nothing pending. On any such run — and on any error — end your turn with exactly [SILENT] and nothing else. [SILENT] tells Hermes to send no message.",
    "",
    "1. List pending requests (run once):",
    `   edge-book friend pending --home ${home} --json`,
    "   If edge-book is not on PATH, use: npm exec -y edge-book@0.11.0 -- friend pending --home " + home + " --json",
    "   If the command errors, Edge Book is unavailable, or the list is empty ([]) → end your turn with exactly [SILENT].",
    "",
    "2. Otherwise write ONE short, warm message. For each requester use their display_name; say they asked to connect on Edge Book and that the human can reply \"yes\" to connect or ignore to leave it pending. No internal IDs, no JSON.",
    "",
    "3. Mark each surfaced request notified so it is never re-sent (once per requester):",
    `   edge-book friend mark-notified <agent_id> --home ${home}`,
  ].join("\n");
}

export interface HermesRunner {
  /** Resolved hermes binary path, or null when this host is not Hermes. */
  hermesBin: string | null;
  /** Run `hermes cron list` and return stdout. */
  list: () => string;
  /** Run `hermes cron create …` (or any cron subcommand); throw on failure. */
  create: (args: string[]) => void;
}

export interface EnsureResult {
  status: "installed" | "already_present" | "host_unsupported" | "disabled" | "error";
  detail?: string;
}

export function ensureNotifierCron(opts: {
  runner: HermesRunner;
  home: string;
  schedule?: string;
  disabled?: boolean;
}): EnsureResult {
  if (opts.disabled) return { status: "disabled" };
  if (!opts.runner.hermesBin) return { status: "host_unsupported" };

  let listing: string;
  try {
    listing = opts.runner.list();
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
  if (listing.includes(FRIEND_REQUESTS_CRON_NAME)) return { status: "already_present" };

  const schedule = opts.schedule ?? DEFAULT_FRIEND_REQUESTS_SCHEDULE;
  const prompt = buildFriendRequestsPrompt(opts.home);
  const args = [
    "cron", "create", schedule, prompt,
    "--name", FRIEND_REQUESTS_CRON_NAME,
    "--deliver", "telegram",
    "--workdir", opts.home,
  ];
  try {
    opts.runner.create(args);
    return { status: "installed" };
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

// Default runner backed by the real Hermes CLI.
export function defaultHermesRunner(): HermesRunner {
  const bin = HERMES_BIN_CANDIDATES.find((p) => existsSync(p)) ?? null;
  return {
    hermesBin: bin,
    list: () => (bin ? execFileSync(bin, ["cron", "list"], { encoding: "utf8" }) : ""),
    create: (args) => { if (bin) execFileSync(bin, args, { stdio: ["ignore", "ignore", "pipe"] }); },
  };
}
