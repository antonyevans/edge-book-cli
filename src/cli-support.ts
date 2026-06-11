// Operator support-inbox CLI commands (spec-134, ea-claude-139): the OPERATOR
// runs these against their own support agent's store to work the queue of
// received `doctor --send` bundles. Returns null when the command is not its
// own (handleCli dispatch contract, same as cli-identity/cli-social).
//
// Store functions are imported directly from store-support.ts (no
// EdgeBookStore delegates — see the store-support.ts header).
import { readEnvelope, requireArg, takeBoolFlag } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { EdgeBookError, EdgeBookStore } from "./edge-book.ts";
import { pendingSupportBundles, receiveSupportBundle, setSupportBundleStatus, supportBundles } from "./store-support.ts";
import type { SupportBundleRecord } from "./types.ts";

function bundleLine(b: SupportBundleRecord): string {
  return `${b.bundle_id}  ${b.received_at}  ${b.from_display_name ?? "(no name)"} (${b.from_agent_id})  ref=${b.trace_id ?? "-"}`;
}

export async function handleSupportCli(command: string, args: string[], _ctx: CliContext, _home: string | undefined, store: EdgeBookStore): Promise<CliResult | null> {
  if (command !== "support") return null;
  const action = args.shift();

  if (action === "inbox") {
    // Operator opt-in gate (fail closed by default) — flag pattern mirrors
    // `greeter --on/--off` exactly.
    const on = takeBoolFlag(args, "--on");
    const off = takeBoolFlag(args, "--off");
    if (on && off) throw new EdgeBookError("bad_flags", "support inbox takes either --on or --off, not both");
    if (!on && !off) throw new EdgeBookError("missing_arg", "support inbox needs --on or --off");
    const cfg = await store.updateConfig({ support_inbox: on ? true : false });
    return { text: `support_inbox = ${cfg.support_inbox}`, json: cfg };
  }

  if (action === "pending") {
    const bundles = await pendingSupportBundles(store);
    const text = bundles.length
      ? bundles.map(bundleLine).join("\n")
      : "No pending support bundles.";
    return { text, json: bundles };
  }

  if (action === "read") {
    const bundleId = requireArg(args.shift(), "bundle-id");
    const record = await setSupportBundleStatus(store, bundleId, "read");
    const header = [
      `Support bundle ${record.bundle_id} (marked read)`,
      `from:    ${record.from_display_name ?? "(no name)"} (${record.from_agent_id})`,
      `ref:     ${record.trace_id ?? "-"}`,
      `at:      ${record.received_at}`,
      ...(record.note ? [`note:    ${record.note}`] : []),
      "",
    ].join("\n");
    return { text: `${header}${JSON.stringify(record.report, null, 2)}`, json: record };
  }

  if (action === "dismiss") {
    const bundleId = requireArg(args.shift(), "bundle-id");
    const record = await setSupportBundleStatus(store, bundleId, "dismissed");
    return { text: `Dismissed support bundle ${record.bundle_id}`, json: record };
  }

  if (action === "receive") {
    // Manual apply for file-hop testing; the dial-out applies inbound bundles
    // automatically via receiveEnvelope.
    const source = requireArg(args.shift(), "envelope-json-path");
    const record = await receiveSupportBundle(store, await readEnvelope(source));
    return { text: `Received support bundle ${record.bundle_id} from ${record.from_agent_id} (ref ${record.trace_id ?? "-"})`, json: record };
  }

  if (action === "list") {
    // Full queue including read/dismissed (audit view).
    const all = Object.values(await supportBundles(store)).sort((a, b) => a.received_at.localeCompare(b.received_at));
    const text = all.length ? all.map((b) => `${b.status.padEnd(9)} ${bundleLine(b)}`).join("\n") : "No support bundles.";
    return { text, json: all };
  }

  throw new EdgeBookError("unknown_action", `Unknown support action: ${action} (use "inbox", "pending", "read", "dismiss", "list", or "receive")`);
}
