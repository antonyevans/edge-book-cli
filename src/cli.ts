// CLI command dispatch for the `edge-book` binary AND the OpenClaw plugin
// surface: index.js (plugin entry) imports handleCli, EdgeBookDialoutClient,
// and DEFAULT_DIALOUT_HOST from the tsup bundle of THIS file — its exports are
// a FROZEN public contract (npm package "edge-book").
//
// Layout: handleCli is one flat if-chain ordered like the command reference in
// commands-doc.ts (which generates --help and the README table; the pre-commit
// hook keeps the README in sync). Per-feature command blocks live in
// cli-identity.ts / cli-social.ts / cli-taxonomy.ts (each returns null when the
// command is not its own, preserving dispatch order); host/server commands
// (serve, dialout, pair, sessions, relay, harness) stay inline here.
import { realpathSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseHome, parseHost, requireArg, takeBoolFlag, takeFlag } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { maybeAppendHandleNudge } from "./handle-nudge.ts";
import { handleIdentityCli } from "./cli-identity.ts";
import { handleSocialCli } from "./cli-social.ts";
import { handleTaxonomyCli } from "./cli-taxonomy.ts";
import { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient, listSessions, revokeOneSession, sendPairRegistration, sendSessionsRevoke } from "./dialout.ts";
import type { SessionsRevokeFrame } from "./dialout-key.ts";
import { runTwoAgentHarness, EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import { renderUsage } from "./commands-doc.ts";
import { startRelayServer, startEdgeBookServer } from "./http.ts";
import { makeNotifyOnEnvelope, resolveNotifyCmd } from "./notify.ts";
import { ensureNotifierCron, defaultHermesRunner } from "./host-cron.ts";

export { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient };
export type { CliContext, CliResult } from "./cli-shared.ts";

function usage(): string {
  return renderUsage();
}

function serverAddress(server: { address(): string | net.AddressInfo | null }): string {
  const address = server.address();
  if (!address || typeof address === "string") return String(address);
  return `${address.address}:${address.port}`;
}

export async function handleCli(inputArgs: string[], ctx: CliContext = {}): Promise<CliResult> {
  const args = [...inputArgs];
  const home = parseHome(args, ctx);
  const command = args.shift() || "help";
  const store = new EdgeBookStore({ home });

  if (command === "help" || command === "--help" || command === "-h") {
    return { text: usage() };
  }

  const identityResult = await handleIdentityCli(command, args, ctx, home, store);
  if (identityResult) return identityResult;

  const socialResult = await handleSocialCli(command, args, ctx, home, store);
  if (socialResult) return maybeAppendHandleNudge(store, command, socialResult);

  if (command === "serve") {
    const host = takeFlag(args, "--host") || "127.0.0.1";
    const port = Number(takeFlag(args, "--port") || "0");
    const cardUrl = takeFlag(args, "--card-url");
    const server = await startEdgeBookServer({ home, host, port, cardUrl });
    console.log(`Edge Book server listening on ${serverAddress(server)}`);
    await new Promise(() => undefined);
  }

  if (command === "dialout") {
    const hostUrl = parseHost(args, ctx);
    const store = new EdgeBookStore({ home });
    // Resolve the host notify command (flag > env > config). When set, every
    // applied inbound envelope notifies the human via the host command.
    const notifyCmd = resolveNotifyCmd({
      flag: takeFlag(args, "--notify-cmd"),
      env: process.env.EDGE_BOOK_NOTIFY_CMD,
      config: (await store.config()).notify_cmd,
    });
    const client = new EdgeBookDialoutClient({
      home,
      host: hostUrl,
      socketFactory: ctx.socketFactory,
      onEnvelope: makeNotifyOnEnvelope(store, notifyCmd),
    });
    await client.start();
    console.log(`Edge Book dial-out connected to ${hostUrl}${notifyCmd ? " (notify hook active)" : ""}`);
    // Idempotently self-install the host notifier on a recognized host (e.g. Hermes
    // delivers via cron). Detection-gated, disable with --no-cron-install /
    // EDGE_BOOK_NO_CRON_INSTALL. A failure here must never break the dial-out.
    try {
      const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
      // `home` can be undefined when neither --home nor ctx.home is set; ensureNotifierCron
      // tolerates that at runtime (any failure is caught below). Documented cast to keep
      // pre-existing behavior unchanged — see FINDINGS.md §1.
      const res = ensureNotifierCron({ runner: defaultHermesRunner(), home: home as string, disabled });
      if (res.status === "installed") console.log(`  ↳ notifier cron self-installed ("Edge Book — friend requests", every 20m → telegram)`);
      else if (res.status === "error") console.log(`  ↳ notifier cron install skipped: ${res.detail}`);
    } catch (e) {
      console.log(`  ↳ notifier cron install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise(() => undefined);
  }

  if (command === "ensure-notifier") {
    // Explicit one-shot: provision the host notifier (for installers/manual setup).
    const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
    // Same documented cast as the dialout branch: `home` may be undefined and
    // ensureNotifierCron reports (not throws) failures. See FINDINGS.md §1.
    const res = ensureNotifierCron({ runner: defaultHermesRunner(), home: home as string, disabled });
    const msg: Record<string, string> = {
      installed: 'Installed notifier cron "Edge Book — friend requests" (every 20m → telegram).',
      already_present: "Notifier cron already present — nothing to do.",
      host_unsupported: "No recognized host (Hermes) detected — nothing installed. Set notify_cmd for real-time delivery on hosts with a sender.",
      disabled: "Cron self-install disabled.",
      error: `Could not install notifier cron: ${res.detail ?? ""}`,
    };
    return { text: msg[res.status] ?? res.status, json: res };
  }

  if (command === "pair") {
    const hostUrl = parseHost(args, ctx);
    const ttlMs = Number(takeFlag(args, "--ttl-ms") || `${5 * 60 * 1000}`);
    if (!ctx.textOnly) {
      const client = new EdgeBookDialoutClient({ home, host: hostUrl, socketFactory: ctx.socketFactory, openLocalApi: false });
      await client.start();
      const registration = await client.pair(ttlMs);
      console.log(`Pairing code: ${registration.code}`);
      console.log(`Expires in: ${ttlMs}ms`);
      console.log("Edge Book dial-out remains connected; leave this process running during the hosted reader session.");
      await new Promise(() => undefined);
    }
    const registration = await sendPairRegistration({ home, host: hostUrl, ttlMs, socketFactory: ctx.socketFactory });
    return { text: `Pairing code: ${registration.code}\nExpires in: ${registration.frame.ttl_ms}ms`, json: registration };
  }

  if (command === "sessions") {
    const action = args.shift();
    if (action === "list") {
      const hostUrl = parseHost(args, ctx);
      const devices = await listSessions({ home, host: hostUrl, socketFactory: ctx.socketFactory });
      const lines = devices.length
        ? devices.map((d) => `${d.device_id}  ${d.label}  (added ${new Date(d.created_at).toISOString()}, last seen ${new Date(d.last_seen_at).toISOString()})`).join("\n")
        : "No remembered devices.";
      return { text: lines, json: { devices } };
    }
    if (action === "revoke") {
      const hostUrl = parseHost(args, ctx);
      const deviceId = takeFlag(args, "--device");
      if (deviceId) {
        const revoked = await revokeOneSession({ home, host: hostUrl, socketFactory: ctx.socketFactory, deviceId });
        return { text: revoked ? `Revoked device ${deviceId}` : `No device ${deviceId} found on your channel`, json: { device_id: deviceId, revoked } };
      }
      const frame = await sendSessionsRevoke({ home, host: hostUrl, socketFactory: ctx.socketFactory });
      const channel = (frame as SessionsRevokeFrame & { channel_id?: string }).channel_id || "unknown-channel";
      return { text: `Received sessions_revoke_ok for request ${frame.request_id} on ${channel}`, json: frame };
    }
  }

  if (command === "relay") {
    const action = args.shift();
    if (action === "serve") {
      const host = takeFlag(args, "--host") || "127.0.0.1";
      const port = Number(takeFlag(args, "--port") || "0");
      const relayStore = requireArg(takeFlag(args, "--store"), "--store");
      const server = await startRelayServer({ host, port, store: relayStore });
      console.log(`Edge Book relay listening on ${serverAddress(server)}`);
      await new Promise(() => undefined);
    }
  }

  if (command === "harness") {
    const action = args.shift();
    if (action === "two-agent") {
      const result = await runTwoAgentHarness();
      return { text: `PASS two-agent harness\n${JSON.stringify(result, null, 2)}`, json: result };
    }
  }

  const taxonomyResult = await handleTaxonomyCli(command, args, ctx, store);
  if (taxonomyResult) return maybeAppendHandleNudge(store, command, taxonomyResult);

  throw new EdgeBookError("unknown_command", usage());
}

export async function runCli(args: string[]): Promise<void> {
  const result = await handleCli(args);
  console.log(result.text);
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isCliEntrypoint()) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
