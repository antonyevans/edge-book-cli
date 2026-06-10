import { spawn } from "node:child_process";
import type { NotificationIntent } from "./edge-book.ts";

// Delivery of a NotificationIntent via a HOST-PROVIDED command (ea-claude-125).
// Edge Book stays transport-free: it never knows the channel. The operator
// configures `notify_cmd`; we run it and the command delivers stdin to the human.
//
// SECURITY: the command string is operator-trusted. ALL remote-attacker-controlled
// content (from_name, message body, etc.) is passed ONLY via stdin + env vars —
// NEVER interpolated into the command string — so a malicious display_name like
// `$(rm -rf ~)` is inert data, not executable shell.

export interface DeliverOptions {
  cmd?: string;       // host notify command (run via `sh -c`)
  timeoutMs?: number; // default 10s; a hung command is killed and reported as failure
}

export interface DeliverResult {
  delivered: boolean;
  error?: string;
}

export async function deliverNotification(intent: NotificationIntent, opts: DeliverOptions): Promise<DeliverResult> {
  if (!opts.cmd || !opts.cmd.trim()) return { delivered: false, error: "no_notify_cmd" };
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EB_NOTIFY_KIND: intent.kind,
    EB_NOTIFY_FROM_ID: intent.from_id,
    EB_NOTIFY_FROM_NAME: intent.from_name ?? "",
    EB_NOTIFY_DEDUP_KEY: intent.dedup_key,
  };
  for (const [k, v] of Object.entries(intent.meta ?? {})) {
    env[`EB_NOTIFY_${k.toUpperCase()}`] = v;
  }

  return new Promise<DeliverResult>((resolve) => {
    let settled = false;
    const done = (r: DeliverResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Untrusted data is NOT in this argv — only the operator's own command is.
    const child = spawn("/bin/sh", ["-c", opts.cmd as string], { env, stdio: ["pipe", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ delivered: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => done({ delivered: false, error: e.message }));
    child.on("close", (code) => {
      if (code === 0) done({ delivered: true });
      else done({ delivered: false, error: `exit ${code}${stderr ? `: ${stderr.trim()}` : ""}` });
    });
    // A command that exits before reading stdin closes the pipe; ignore the
    // resulting EPIPE (benign) — the exit code drives the result.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(intent.message ?? "");
  });
}
