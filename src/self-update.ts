// spec-142 self-update: a throttled npm-registry version check plus the
// `edge-book self-update` command that brings THIS install onto the latest
// release. The agent's own scheduler (the notifier cron, prompt v3) is the
// execution engine; this module only does the local work.
//
// Invariants:
//   - checkLatest never throws and never blocks a command for more than the
//     3s registry timeout: staleness detection degrades, never breaks.
//   - never downgrade; a lockfile in the install root guards concurrent runs.
//   - the new build is smoke-verified (--version spawn) BEFORE success is
//     reported; on mismatch the previous npm tree remains in place.
//   - policy: auto_update defaults to "auto"; pre-1.0 auto applies across all
//     0.x versions, from 1.0 only within the same major (cross-major drift
//     downgrades to the notify nudge — update-nudge.ts).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EdgeBookStore } from "./edge-book.ts";
import { eventErrorCode, logEvent } from "./event-log.ts";
import { EdgeBookError } from "./types.ts";

const execFileAsync = promisify(execFile);

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/edge-book/latest";
export const REGISTRY_TIMEOUT_MS = 3_000;
export const UPDATE_CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000; // one registry hit per 24h
export const SELF_UPDATE_LOCK = ".edge-book-self-update.lock";
const LOCK_STALE_MS = 15 * 60 * 1000; // a lock older than this is a crashed run

// Roots that are package-manager territory: even when writable (root), an npm
// install behind apt/brew/nix's back corrupts the manager's view. Manual only.
const SYSTEM_ROOT_PREFIXES = ["/usr/lib", "/usr/local/lib", "/usr/share", "/opt/homebrew", "/snap/", "/nix/store"];

let cachedRunning: string | undefined;

// The version of the CODE THIS PROCESS RUNS — read once and cached, so a
// long-running process keeps reporting the version it started as even after
// a self-update rewrites package.json on disk (that fresh read is
// installedVersion in update-drift.ts).
export async function runningVersion(): Promise<string> {
  if (cachedRunning) return cachedRunning;
  try {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    cachedRunning = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cachedRunning = "0.0.0";
  }
  return cachedRunning;
}

// Numeric dotted compare on the release triple (prerelease tags ignored).
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function majorOf(version: string): number {
  return Number(version.split(".")[0]) || 0;
}

// May the AUTOMATIC path (cron --if-stale, dial-out exit-75) apply this jump?
// Pre-1.0: yes across all versions. From 1.0: same-major only — breaking
// changes deserve a human/agent decision (the notify nudge).
export function autoUpdateAllowed(running: string, latest: string): boolean {
  const runningMajor = majorOf(running);
  if (runningMajor >= 1 && majorOf(latest) !== runningMajor) return false;
  return true;
}

export interface CheckLatestOptions {
  now?: number;
  fetchImpl?: typeof fetch;
  force?: boolean; // ignore the 24h throttle (self-update's fresh check)
}

// Query the registry for the latest published version. Throttled to one hit
// per 24h via config.update_check_at; the result is cached in
// config.update_latest_known. ALL failures are silent — returns the cached
// value (or undefined) so staleness detection degrades, never breaks.
export async function checkLatest(store: EdgeBookStore, opts: CheckLatestOptions = {}): Promise<string | undefined> {
  const now = opts.now ?? Date.now();
  let cached: string | undefined;
  try {
    const config = await store.config();
    cached = config.update_latest_known;
    if (!opts.force && config.update_check_at !== undefined && now - config.update_check_at < UPDATE_CHECK_THROTTLE_MS) {
      return cached;
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const response = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`registry ${response.status}`);
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+/.test(body.version)) throw new Error("malformed registry response");
    await store.updateConfig({ update_check_at: now, update_latest_known: body.version });
    return body.version;
  } catch {
    // Silent by contract. Record the attempt so an offline box does not
    // re-try the registry on every heartbeat command.
    await store.updateConfig({ update_check_at: now }).catch(() => undefined);
    return cached;
  }
}

// Resolve the npm prefix root this module executes from: the parent of the
// `node_modules` whose `edge-book` child contains the running module. A git
// checkout (no such ancestor) returns null — it is not an npm install.
export function resolveInstallRoot(modulePath: string = fileURLToPath(import.meta.url)): string | null {
  let dir = path.dirname(modulePath);
  for (;;) {
    const parent = path.dirname(dir);
    if (path.basename(dir) === "edge-book" && path.basename(parent) === "node_modules") {
      return path.dirname(parent);
    }
    if (parent === dir) return null;
    dir = parent;
  }
}

function notSelfUpdatable(detail: string, manualCommand: string): EdgeBookError {
  return new EdgeBookError(
    "install_not_self_updatable",
    `install_not_self_updatable: ${detail}. Update manually with the right permissions: ${manualCommand}`,
  );
}

async function assertSelfUpdatableRoot(root: string | null): Promise<string> {
  if (root === null) {
    throw notSelfUpdatable("this edge-book does not run from an npm install root", "npm install -g edge-book@latest");
  }
  const manual = `npm install edge-book@latest --prefix ${root}`;
  if (SYSTEM_ROOT_PREFIXES.some((prefix) => root === prefix.replace(/\/$/, "") || root.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
    throw notSelfUpdatable(`install root ${root} is system-managed`, manual);
  }
  try {
    await fs.access(root, fs.constants.W_OK);
    await fs.access(path.join(root, "node_modules"), fs.constants.W_OK);
  } catch {
    throw notSelfUpdatable(`install root ${root} is not writable by this process`, manual);
  }
  return root;
}

// Concurrent-run guard: exclusive-create a lockfile in the install root. A
// lock older than LOCK_STALE_MS belongs to a crashed run and is taken over.
async function acquireLock(lockPath: string, now: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, `${process.pid} ${new Date(now).toISOString()}\n`, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && now - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
        continue; // crashed run — take over once
      }
      throw new EdgeBookError("update_in_progress", `update_in_progress: another self-update holds ${lockPath}`);
    }
  }
  throw new EdgeBookError("update_in_progress", `update_in_progress: could not acquire ${lockPath}`);
}

async function defaultNpmInstall(spec: string, root: string): Promise<void> {
  await execFileAsync("npm", ["install", spec, "--prefix", root, "--no-audit", "--no-fund"], { timeout: 180_000 });
}

// Smoke-verify the new build by spawning its own --version.
async function defaultVerify(root: string): Promise<string> {
  const entry = path.join(root, "node_modules", "edge-book", "dist", "edge-book.js");
  const { stdout } = await execFileAsync(process.execPath, [entry, "--version"], { timeout: 30_000 });
  return stdout.trim();
}

export interface SelfUpdateDeps {
  now?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: undefined = resolve from the running module path; null = "not an npm install". */
  installRoot?: string | null;
  running?: string;
  npmInstall?: (spec: string, root: string) => Promise<void>;
  verify?: (root: string) => Promise<string>;
}

export interface SelfUpdateOptions extends SelfUpdateDeps {
  ifStale?: boolean;
  dryRun?: boolean;
}

export interface SelfUpdateOutcome {
  status: "current" | "skipped" | "dry_run" | "updated";
  from: string;
  to?: string;
  text: string;
}

async function selfAgentId(store: EdgeBookStore): Promise<string> {
  try {
    return (await store.identity()).agent_id;
  } catch {
    return "self";
  }
}

async function recordFailure(store: EdgeBookStore, from: string, to: string, reason: string): Promise<void> {
  await store.audit("update.self", await selfAgentId(store), { from, to, ok: false, reason });
  await logEvent(store, "update.failed", { from, to, reason });
}

// What the agent reading the output must do about a running dial-out.
function restartAdvice(autoRespawn: boolean): string {
  return autoRespawn
    ? "A running dial-out will detect the new install (on reconnect or within 6h) and exit 75 so its supervisor respawns it onto the new code — no restart needed from you."
    : "Restart the dial-out process now to pick up the new code — under this configuration it will NOT restart itself.";
}

async function performUpdate(store: EdgeBookStore, root: string, from: string, latest: string, opts: SelfUpdateOptions, now: number): Promise<SelfUpdateOutcome> {
  const install = opts.npmInstall ?? defaultNpmInstall;
  try {
    await install(`edge-book@${latest}`, root);
  } catch (error) {
    await recordFailure(store, from, latest, eventErrorCode(error));
    throw new EdgeBookError("update_failed", `update_failed: npm install edge-book@${latest} --prefix ${root} failed; the previous install remains in place.`);
  }
  let reported: string;
  try {
    reported = (await (opts.verify ?? defaultVerify)(root)).trim();
  } catch (error) {
    reported = `spawn_failed:${eventErrorCode(error)}`;
  }
  if (reported !== latest) {
    await recordFailure(store, from, latest, `verify_mismatch:${reported}`);
    throw new EdgeBookError("update_failed", `update_failed: the new build reports "${reported}" instead of ${latest}; not trusting it. The npm tree at ${root} may need a manual reinstall.`);
  }
  await store.audit("update.self", await selfAgentId(store), { from, to: latest });
  await logEvent(store, "update.self", { from, to: latest });
  const config = await store.updateConfig({ updated_at: now, update_latest_known: latest });
  const autoRespawn = (config.auto_update ?? "auto") === "auto" && config.dialout_respawn_expected !== false;
  return { status: "updated", from, to: latest, text: `Updated edge-book ${from} → ${latest} in ${root}.\n${restartAdvice(autoRespawn)}` };
}

// `edge-book self-update [--if-stale] [--dry-run]`. --if-stale is the
// cron-safe form: silent exit 0 when current, when the registry is
// unreachable, or when policy gates the automatic path. An explicit run (no
// --if-stale) IS the human/agent decision and proceeds regardless of
// auto_update mode — but never downgrades.
export async function selfUpdate(store: EdgeBookStore, opts: SelfUpdateOptions = {}): Promise<SelfUpdateOutcome> {
  const now = opts.now ?? Date.now();
  const from = opts.running ?? (await runningVersion());
  const config = await store.config();
  const mode = config.auto_update ?? "auto";
  const latest = await checkLatest(store, { now, fetchImpl: opts.fetchImpl, force: true });
  if (!latest) {
    if (opts.ifStale) return { status: "current", from, text: "" };
    throw new EdgeBookError("registry_unreachable", "registry_unreachable: could not determine the latest edge-book version from the npm registry.");
  }
  if (compareVersions(latest, from) <= 0) {
    return { status: "current", from, to: latest, text: opts.ifStale ? "" : `edge-book ${from} is current (latest published: ${latest}); never downgrading.` };
  }
  if (opts.ifStale && (mode !== "auto" || !autoUpdateAllowed(from, latest))) {
    // Kill switch ("off"), operator approval ("notify"), or cross-major drift:
    // the automatic path stands down; the heartbeat nudge owns the surface.
    return { status: "skipped", from, to: latest, text: "" };
  }
  const root = await assertSelfUpdatableRoot(opts.installRoot !== undefined ? opts.installRoot : resolveInstallRoot());
  if (opts.dryRun) {
    return { status: "dry_run", from, to: latest, text: `Would update edge-book ${from} → ${latest} in ${root} (dry run; nothing installed).` };
  }
  const lockPath = path.join(root, SELF_UPDATE_LOCK);
  await acquireLock(lockPath, now);
  try {
    return await performUpdate(store, root, from, latest, opts, now);
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}
