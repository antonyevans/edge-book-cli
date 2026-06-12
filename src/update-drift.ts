// spec-142 §4: the long-running dial-out picks up a self-updated install.
// The process compares the version it STARTED as (captured at monitor
// creation) against the installed package.json on disk — on each reconnect
// and on a 6h timer. On drift with auto_update "auto" (the default) and a
// supervisor expected, it logs dialout.restart_for_update, flight-records,
// and exits 75 (EX_TEMPFAIL — "restart me") so the supervising gateway
// respawns it onto the new code. Under "notify"/"off" or
// dialout_respawn_expected:false it logs only. No in-process re-exec.
import fs from "node:fs/promises";
import type { EdgeBookStore } from "./edge-book.ts";
import { logEvent } from "./event-log.ts";
import { checkLatest, runningVersion } from "./self-update.ts";

export const DRIFT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Fresh, uncached read of the package.json next to the running module — after
// a self-update this is the NEW version while runningVersion() (cached at
// start) still reports the code in memory.
export async function installedVersion(): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateDriftMonitor {
  /** Drift check only — run on every (re)connect. */
  onConnect(): Promise<void>;
  /** Arm the 6h timer (registry check + drift check). Idempotent. */
  start(): void;
  stop(): void;
}

export interface DriftMonitorDeps {
  running?: string;
  installed?: () => Promise<string | undefined>;
  exit?: (code: number) => void;
  checkLatestImpl?: (store: EdgeBookStore) => Promise<unknown>;
  intervalMs?: number;
}

export function createUpdateDriftMonitor(store: EdgeBookStore, deps: DriftMonitorDeps = {}): UpdateDriftMonitor {
  // Capture the running version NOW, before any update can rewrite the file.
  const running: Promise<string> = deps.running !== undefined ? Promise.resolve(deps.running) : runningVersion();
  const installed = deps.installed ?? installedVersion;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  // The timer is also where the throttled registry check lives: every
  // dial-out keeps update_latest_known fresh for the heartbeat nudge without
  // adding network calls to short-lived CLI commands.
  const check = deps.checkLatestImpl ?? ((s: EdgeBookStore) => checkLatest(s));
  let timer: ReturnType<typeof setInterval> | undefined;

  async function driftCheck(): Promise<void> {
    try {
      const inMemory = await running;
      const onDisk = await installed();
      if (!onDisk || onDisk === inMemory) return;
      const config = await store.config();
      const mode = config.auto_update ?? "auto";
      const respawnExpected = config.dialout_respawn_expected !== false;
      await logEvent(store, "dialout.version_drift", { running: inMemory, installed: onDisk, mode, respawn_expected: respawnExpected });
      if (mode !== "auto" || !respawnExpected) return;
      console.log(`dialout.restart_for_update: installed edge-book ${onDisk} != running ${inMemory} — exiting 75 for supervisor respawn`);
      await logEvent(store, "dialout.restart_for_update", { from: inMemory, to: onDisk });
      exit(75);
    } catch {
      // Drift detection degrades silently — it must never break the dial-out.
    }
  }

  return {
    onConnect: () => driftCheck(),
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void check(store).catch(() => undefined).then(() => driftCheck());
      }, deps.intervalMs ?? DRIFT_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
