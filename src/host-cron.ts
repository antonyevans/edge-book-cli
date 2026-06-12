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

// spec-141: version of buildFriendRequestsPrompt for agent-directed migration.
// 1 = the legacy 0.11.0-pinned prompt; 2 = the pin-free spec-139 prompt;
// 3 = spec-142 step-0 self-update. Bump whenever the prompt materially
// changes. Recorded in config.notifier_prompt_ack once the scheduler is
// confirmed to run this version (mechanical install/update, or explicit
// `ensure-notifier --ack` after the agent updates its own scheduler tool).
export const NOTIFIER_PROMPT_VERSION = 3;

// spec-141: is the hermes *shell CLI* present? Where it is, the mechanical
// spec-139 path (ensureNotifierCron) owns prompt migration; where it is not
// (agent-tool schedulers), the heartbeat nudge instructs the agent instead.
export function hermesCliDetected(): boolean {
  return HERMES_BIN_CANDIDATES.some((p) => existsSync(p));
}

// Natural-language cron prompt for Hermes. Replies with the Hermes no-reply
// marker `[SILENT]` when nothing is pending or Edge Book is unavailable, so quiet
// cycles never ping. The agent's edge-book home is pinned so it reads the right state.
export function buildFriendRequestsPrompt(home: string): string {
  return [
    "You are the Edge Book friend-request notifier. Tell the human on their Telegram when someone has asked to connect on Edge Book. Hermes delivers your final assistant reply to their chat.",
    "",
    "This runs every 20 minutes; most runs there will be nothing pending. On any such run — and on any error — end your turn with exactly [SILENT] and nothing else. [SILENT] tells Hermes to send no message.",
    "",
    "0. Keep this agent's edge-book install current (run once, first; spec-142):",
    `   edge-book self-update --if-stale --home ${home}`,
    `   If edge-book is not on PATH, use: npm exec -y edge-book@latest -- self-update --if-stale --home ${home}`,
    "   Ignore this step's output and continue to step 1 even if it errors.",
    "",
    "1. List new (not-yet-surfaced) requests (run once):",
    `   edge-book friend pending --new --home ${home} --json`,
    `   If edge-book is not on PATH, use: npm exec -y edge-book -- friend pending --new --home ${home} --json`,
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
  /**
   * Return the stored prompt (or any output containing it) for the named job,
   * or null when it cannot be read — null means "unknown", and the caller
   * keeps the existing job rather than churning it. (spec-139)
   */
  getPrompt: (name: string) => string | null;
  /** Delete the named cron job; throw on failure. (spec-139) */
  remove: (name: string) => void;
}

export interface EnsureResult {
  status: "installed" | "updated" | "already_present" | "host_unsupported" | "disabled" | "error";
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
  const schedule = opts.schedule ?? DEFAULT_FRIEND_REQUESTS_SCHEDULE;
  const prompt = buildFriendRequestsPrompt(opts.home);
  let recreating = false;
  if (listing.includes(FRIEND_REQUESTS_CRON_NAME)) {
    // spec-139: an existing job with a stale prompt (deployed agents hold the
    // old `friend pending --json` + 0.11.0-pinned text) must be recreated.
    // When the stored prompt cannot be read (null) be conservative: keep it.
    const existing = opts.runner.getPrompt(FRIEND_REQUESTS_CRON_NAME);
    if (existing === null || existing.includes(prompt)) return { status: "already_present" };
    try {
      opts.runner.remove(FRIEND_REQUESTS_CRON_NAME);
    } catch (e) {
      return { status: "error", detail: e instanceof Error ? e.message : String(e) };
    }
    recreating = true;
  }

  const args = [
    "cron", "create", schedule, prompt,
    "--name", FRIEND_REQUESTS_CRON_NAME,
    "--deliver", "telegram",
    "--workdir", opts.home,
  ];
  try {
    opts.runner.create(args);
    return { status: recreating ? "updated" : "installed" };
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
    // Best-effort prompt read: `hermes cron show <name>` prints the job
    // (including its prompt). Any failure → null, which the caller treats as
    // "unknown — keep the existing job" so an older Hermes never churns.
    getPrompt: (name) => {
      if (!bin) return null;
      try {
        return execFileSync(bin, ["cron", "show", name], { encoding: "utf8" });
      } catch {
        return null;
      }
    },
    remove: (name) => { if (bin) execFileSync(bin, ["cron", "delete", name], { stdio: ["ignore", "ignore", "pipe"] }); },
  };
}

// ── spec-132: greeter cron (greeter host only) ──────────────────────────────
export const GREETER_CRON_NAME = "Edge Book — greeter";
export const DEFAULT_GREETER_SCHEDULE = "*/5 * * * *"; // parent design SLA: accept "within minutes"

// Unlike the notifier (which writes a human message and needs LLM judgment),
// the greeter command is self-contained — the Hermes prompt is a minimal
// "run this command and report" wrapper.
export function buildGreeterPrompt(home: string): string {
  return [
    "You are the Edge Book greeter runner. Run the command below once and report what it did. Hermes delivers your final assistant reply to the chat.",
    "",
    `   edge-book friend auto-accept --deliver --home ${home}`,
    `   If edge-book is not on PATH, use: npm exec -y edge-book -- friend auto-accept --deliver --home ${home}`,
    "",
    "If the command errors, or its JSON output is an empty list ([]), end your turn with exactly [SILENT] and nothing else. [SILENT] tells Hermes to send no message.",
    "",
    "Otherwise reply with one short line per entry: the agent_id, whether it was accepted, and whether it was welcomed. No extra commentary, no raw JSON.",
  ].join("\n");
}

// Idempotently ensure the greeter cron on a recognized host. The greeter_mode
// gate lives in the caller (cli.ts dialout) — normal agents never reach this.
export function ensureGreeterCron(opts: {
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
  if (listing.includes(GREETER_CRON_NAME)) return { status: "already_present" };

  const args = [
    "cron", "create", opts.schedule ?? DEFAULT_GREETER_SCHEDULE, buildGreeterPrompt(opts.home),
    "--name", GREETER_CRON_NAME,
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
