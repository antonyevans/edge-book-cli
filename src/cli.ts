// CLI command dispatch for the `edge-book` binary AND the OpenClaw plugin
// surface: index.js (plugin entry) imports handleCli, EdgeBookDialoutClient,
// and DEFAULT_DIALOUT_HOST from the tsup bundle of THIS file — its exports are
// a FROZEN public contract (npm package "edge-book").
//
// Layout: handleCli is one flat if-chain ordered like the command reference in
// commands-doc.ts (which generates --help and the README table; the pre-commit
// hook keeps the README in sync). Per-feature command blocks live in
// cli-identity.ts / cli-social.ts / cli-support.ts / cli-taxonomy.ts (each
// returns null when the command is not its own, preserving dispatch order);
// host/server commands
// (serve, dialout, pair, sessions, relay, harness) stay inline here.
import { realpathSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseHome, parseHost, requireArg, takeBoolFlag, takeFlag } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { maybeAppendHandleNudge } from "./handle-nudge.ts";
import { maybeAppendNotifierNudge } from "./notifier-nudge.ts";
import { maybeAppendOnboardingNudge } from "./onboarding-nudge.ts";
import { handleIdentityCli } from "./cli-identity.ts";
import { handleSocialCli } from "./cli-social.ts";
import { handleSupportCli } from "./cli-support.ts";
import { handleTaxonomyCli } from "./cli-taxonomy.ts";
import { handleDirectoryCli } from "./cli-directory.ts";
import { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient, listSessions, mailboxStatus, revokeOneSession, sendPairRegistration, sendSessionsRevoke } from "./dialout.ts";
import type { MailboxStatusEntry } from "./dialout.ts";
import { DEFAULT_PAIR_TTL_MS } from "./dialout-key.ts";
import type { PairRegistration, SessionsRevokeFrame } from "./dialout-key.ts";
import { formatAge, readOutbox, staleQueueMs } from "./store-outbox.ts";
import { runTwoAgentHarness, EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import { renderUsage } from "./commands-doc.ts";
import { startEdgeBookServer } from "./http.ts";
import { startRelayServer } from "./http-relay.ts";
import { deliverNotification, makeNotifyOnEnvelope, resolveNotifyCmd } from "./notify.ts";
import { NOTIFIER_PROMPT_VERSION, buildFriendRequestsPrompt, defaultHermesRunner, ensureGreeterCron, ensureNotifierCron } from "./host-cron.ts";
import { buildPairCompleteNotifyIntent } from "./store-notify.ts";
import { buildOnboardingNote } from "./onboarding.ts";
import { logEvent } from "./event-log.ts";
import { runningVersion, selfUpdate } from "./self-update.ts";
import { maybeAppendUpdateNudge } from "./update-nudge.ts";

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

  // spec-142: --version is the self-update smoke-verify surface — the new
  // build must answer it with exactly the package version, nothing else.
  if (command === "version" || command === "--version" || command === "-v") {
    const version = await runningVersion();
    return { text: version, json: { version } };
  }

  const identityResult = await handleIdentityCli(command, args, ctx, home, store);
  if (identityResult) return identityResult;

  // Capture the social sub-action before handleSocialCli shifts it off args:
  // `friend auto-accept` is machine-invoked (greeter cron) and its text output
  // is a machine-readable JSON contract for cron logs — the handle nudge
  // belongs to human conversation surfaces only (spec-132 ruling), so skip it.
  const socialAction = args[0];
  const socialResult = await handleSocialCli(command, args, ctx, home, store);
  if (socialResult) {
    if (command === "friend" && socialAction === "auto-accept") return socialResult;
    return maybeAppendUpdateNudge(store, command, await maybeAppendNotifierNudge(store, command, await maybeAppendOnboardingNudge(store, command, await maybeAppendHandleNudge(store, command, socialResult))));
  }

  const supportResult = await handleSupportCli(command, args, ctx, home, store);
  if (supportResult) return supportResult;

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
    const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
    try {
      // `home` can be undefined when neither --home nor ctx.home is set; ensureNotifierCron
      // tolerates that at runtime (any failure is caught below). Documented cast to keep
      // pre-existing behavior unchanged — see FINDINGS.md §1.
      const res = ensureNotifierCron({ runner: ctx.hermesRunner ?? defaultHermesRunner(), home: home as string, disabled });
      // Flight recorder (spec-133): cron provisioning outcome.
      if (res.status === "installed") await logEvent(store, "cron.notifier_installed", {});
      else if (res.status === "updated") await logEvent(store, "cron.notifier_updated", {});
      else if (res.status === "already_present") await logEvent(store, "cron.notifier_already_present", {});
      // spec-141: a mechanical install/update means the scheduler now runs the
      // canonical prompt — record the ack so the migration nudge never fires.
      if (res.status === "installed" || res.status === "updated") await store.updateConfig({ notifier_prompt_ack: NOTIFIER_PROMPT_VERSION });
      if (res.status === "installed") console.log(`  ↳ notifier cron self-installed ("Edge Book — friend requests", every 20m → telegram)`);
      else if (res.status === "updated") console.log(`  ↳ notifier cron recreated with the current prompt ("Edge Book — friend requests")`);
      else if (res.status === "error") console.log(`  ↳ notifier cron install skipped: ${res.detail}`);
    } catch (e) {
      console.log(`  ↳ notifier cron install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    // spec-132: the greeter cron installs ONLY when this agent is the greeter
    // (double gate: the command itself also refuses without greeter_mode).
    try {
      if ((await store.config()).greeter_mode === true) {
        const res = ensureGreeterCron({ runner: defaultHermesRunner(), home: home as string, disabled });
        if (res.status === "installed") console.log(`  ↳ greeter cron self-installed ("Edge Book — greeter", every 5m)`);
        else if (res.status === "error") console.log(`  ↳ greeter cron install skipped: ${res.detail}`);
      }
    } catch (e) {
      console.log(`  ↳ greeter cron install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise(() => undefined);
  }

  if (command === "ensure-notifier") {
    // spec-141 agent-directed migration helpers (agent-tool schedulers have no
    // hermes shell CLI, so the agent updates its own scheduler job and acks):
    // --print-prompt emits the canonical prompt verbatim (paste-ready, no
    // decoration); --ack records that the scheduler runs the current version.
    if (takeBoolFlag(args, "--print-prompt")) {
      return { text: buildFriendRequestsPrompt(home as string) };
    }
    if (takeBoolFlag(args, "--ack")) {
      const cfg = await store.updateConfig({ notifier_prompt_ack: NOTIFIER_PROMPT_VERSION });
      return { text: `notifier_prompt_ack = ${cfg.notifier_prompt_ack}`, json: cfg };
    }
    // Explicit one-shot: provision the host notifier (for installers/manual setup).
    const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
    // Same documented cast as the dialout branch: `home` may be undefined and
    // ensureNotifierCron reports (not throws) failures. See FINDINGS.md §1.
    const res = ensureNotifierCron({ runner: ctx.hermesRunner ?? defaultHermesRunner(), home: home as string, disabled });
    // Flight recorder (spec-133): cron provisioning outcome.
    if (res.status === "installed") await logEvent(store, "cron.notifier_installed", {});
    else if (res.status === "updated") await logEvent(store, "cron.notifier_updated", {});
    else if (res.status === "already_present") await logEvent(store, "cron.notifier_already_present", {});
    // spec-141: mechanical success = the scheduler now runs the canonical
    // prompt — auto-ack so the migration nudge never fires on this home.
    if (res.status === "installed" || res.status === "updated") await store.updateConfig({ notifier_prompt_ack: NOTIFIER_PROMPT_VERSION });
    const msg: Record<string, string> = {
      installed: 'Installed notifier cron "Edge Book — friend requests" (every 20m → telegram).',
      updated: 'Notifier cron prompt was stale — recreated "Edge Book — friend requests" with the current prompt.',
      already_present: "Notifier cron already present — nothing to do.",
      host_unsupported: "No recognized host (Hermes) detected — nothing installed. Set notify_cmd for real-time delivery on hosts with a sender.",
      disabled: "Cron self-install disabled.",
      error: `Could not install notifier cron: ${res.detail ?? ""}`,
    };
    return { text: msg[res.status] ?? res.status, json: res };
  }

  if (command === "self-update") {
    // spec-142: update THIS install from the npm registry. --if-stale is the
    // cron-safe form (silent exit 0 when current or policy-gated).
    const ifStale = takeBoolFlag(args, "--if-stale");
    const dryRun = takeBoolFlag(args, "--dry-run");
    const out = await selfUpdate(store, { ...(ctx.selfUpdateDeps ?? {}), ifStale, dryRun });
    return { text: out.text, json: out };
  }

  if (command === "greeter") {
    // spec-132: config gate for the greeter agent. Mirrors the friend
    // notify-config flag pattern (cli-social.ts) exactly.
    const on = takeBoolFlag(args, "--on");
    const off = takeBoolFlag(args, "--off");
    if (on && off) throw new EdgeBookError("bad_flags", "greeter takes either --on or --off, not both");
    if (!on && !off) throw new EdgeBookError("missing_arg", "greeter needs --on or --off");
    const cfg = await store.updateConfig({ greeter_mode: on ? true : false });
    return { text: `greeter_mode = ${cfg.greeter_mode}`, json: cfg };
  }

  if (command === "pair") {
    const hostUrl = parseHost(args, ctx);
    const ttlMs = Number(takeFlag(args, "--ttl-ms") || `${DEFAULT_PAIR_TTL_MS}`);
    if (!ctx.textOnly) {
      const client = new EdgeBookDialoutClient({ home, host: hostUrl, socketFactory: ctx.socketFactory, openLocalApi: false });
      await client.start();
      const registration = await client.pair(ttlMs);
      console.log(`Pairing code: ${registration.code}`);
      console.log(formatPairExpiry(registration, ttlMs));
      console.log("Waiting for your browser reader to connect...");
      // Wait out the host's real window when known, not the client estimate.
      const waitMs = registration.expires_at ? Math.max(registration.expires_at - Date.now(), 1_000) : ttlMs;
      const pairResult = await client.waitForPairComplete(waitMs);
      await client.stop();
      if (!pairResult) {
        // Old-host degradation or TTL expiry: the pair_complete frame never arrived.
        // New hosts always send it; old hosts never do — in both cases the code is
        // now expired. (spec-135 old-host degradation §C.2)
        throw new EdgeBookError("pair_timeout", "Pairing code expired unredeemed — run edge-book pair again for a fresh code.");
      }
      console.log(`\nPairing complete — your reader is connected (device: ${pairResult.label}).`);
      const notifyCmd = resolveNotifyCmd({ env: process.env.EDGE_BOOK_NOTIFY_CMD, config: (await store.config()).notify_cmd });
      const intent = buildPairCompleteNotifyIntent(pairResult.device_id, pairResult.label);
      if (notifyCmd && !(await store.wasNotified(intent.dedup_key))) {
        const nr = await deliverNotification(intent, { cmd: notifyCmd });
        if (nr.delivered) await store.recordNotified(intent.dedup_key);
      }
      console.log("\n" + buildOnboardingNote());
      return { text: `Pairing complete — your reader is connected (device: ${pairResult.label}).`, json: { device_id: pairResult.device_id, label: pairResult.label } };
    }
    const registration = await sendPairRegistration({ home, host: hostUrl, ttlMs, socketFactory: ctx.socketFactory });
    return { text: `Pairing code: ${registration.code}\n${formatPairExpiry(registration, ttlMs)}`, json: registration };
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

  if (command === "outbox") {
    // Delivery receipts (spec-097): one transient connection, a single
    // mailbox_status for the recorded ids, honest per-entry state. Against a
    // pre-receipts host (error frame or timeout) it degrades to the local
    // ledger with unknown states — exit 0 either way.
    const asJson = takeBoolFlag(args, "--json");
    const hostUrl = parseHost(args, ctx);
    const entries = await readOutbox(home);
    if (entries.length === 0) {
      return { text: "Outbox is empty — nothing has been sent with --deliver yet.", json: { entries: [] } };
    }
    // Newest 50: the wire bound on mailbox_status ids.
    const recent = entries.slice(-50);
    let statuses: MailboxStatusEntry[] | null = null;
    let unreachable = false; // connection failure ≠ old host — different "unknown" wording
    try {
      statuses = await mailboxStatus({ home, host: hostUrl, socketFactory: ctx.socketFactory, ids: recent.map((e) => e.id) });
    } catch (error) {
      // mailboxStatus already maps the old-host paths (host_unsupported_rpc
      // error frame, host_rpc_timeout) to a null RETURN. Anything that THROWS
      // here is a failure to reach the host at all — degrade to local-only
      // the same way, but say so honestly. Exit 0 either way.
      statuses = null;
      unreachable = !(error instanceof EdgeBookError && (error.code === "host_unsupported_rpc" || error.code === "host_rpc_timeout"));
    }
    const byId = new Map((statuses ?? []).map((s) => [s.id, s]));
    const contacts = await store.contacts();
    const staleMs = staleQueueMs();
    const report = recent.map((entry) => {
      const status = byId.get(entry.id);
      const state = statuses === null
        ? (unreachable ? "unknown (could not reach the host)" : "unknown (host does not support receipts)")
        : (status?.state ?? "unknown");
      const age = formatAge(Date.now() - Date.parse(entry.sent_at));
      const stale = status?.state === "queued" && ((status.queued_ms ?? 0) > staleMs || status.recipient_live === false);
      return {
        ...entry,
        to_display_name: contacts[entry.to_agent_id]?.display_name || entry.to_agent_id,
        age,
        state,
        ...(status?.queued_ms !== undefined ? { queued_ms: status.queued_ms } : {}),
        ...(status?.recipient_live !== undefined ? { recipient_live: status.recipient_live } : {}),
        stale: Boolean(stale)
      };
    });
    const lines = report.map((r) => {
      const base = `${r.id}  ${r.envelope_type}  → ${r.to_display_name}  (${r.age} ago)  ${r.state}`;
      return r.stale
        ? `${base}\n  ⚠ undelivered for ${r.age} — the recipient's agent may be running under a different identity; ask them for a fresh invite.`
        : base;
    });
    return { text: asJson ? JSON.stringify({ entries: report }, null, 2) : lines.join("\n"), json: { entries: report } };
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
  if (taxonomyResult) return maybeAppendUpdateNudge(store, command, await maybeAppendNotifierNudge(store, command, await maybeAppendOnboardingNudge(store, command, await maybeAppendHandleNudge(store, command, taxonomyResult))));

  const directoryResult = await handleDirectoryCli(command, args, ctx, home, store);
  if (directoryResult) return directoryResult;

  throw new EdgeBookError("unknown_command", usage());
}

// Pairing-code expiry line (ea-claude-112). Prefers the host-confirmed
// deadline from pair_register_ok; falls back to the requested TTL when the
// host predates the field. Minutes, not raw ms — this line gets relayed to a
// human through the agent (Slack/Telegram), so it must read at a glance.
function formatPairExpiry(registration: PairRegistration, ttlMs: number): string {
  if (typeof registration.expires_at === "number") {
    const mins = Math.max(1, Math.round((registration.expires_at - Date.now()) / 60_000));
    return `Expires at: ${new Date(registration.expires_at).toISOString()} (~${mins} min from now, host-confirmed)`;
  }
  return `Expires in: ~${Math.round(ttlMs / 60_000)} min (estimated)`;
}

export async function runCli(args: string[]): Promise<void> {
  // --json is a terminal-output flag, peeled here so handlers never see it;
  // handleCli's {text, json} return contract is unchanged.
  const argv = [...args];
  const asJson = takeBoolFlag(argv, "--json");
  const result = await handleCli(argv);
  if (asJson && result.json !== undefined) {
    console.log(JSON.stringify(result.json, null, 2));
  } else {
    console.log(result.text);
  }
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
