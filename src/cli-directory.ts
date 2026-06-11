// edge-book directory — fetches the host's /directory endpoint and prints a
// human-readable list annotated with local relationship state (spec-136).
import type { CliContext, CliResult } from "./cli-shared.ts";
import { takeFlag } from "./cli-shared.ts";
import { DEFAULT_RELAY_BASE } from "./resolver.ts";
import type { EdgeBookStore } from "./edge-book.ts";
import type { AgentContactRecord } from "./types.ts";

interface DirectoryEntry {
  handle: string;
  display_name: string;
  owner_label?: string;
  claimed_at: number;
}

interface DirectoryResponse {
  handles: DirectoryEntry[];
  total: number;
}

export async function handleDirectoryCli(
  command: string,
  args: string[],
  _ctx: CliContext,
  _home: string | undefined,
  store: EdgeBookStore,
): Promise<CliResult | null> {
  if (command !== "directory") return null;

  const relayBase =
    takeFlag(args, "--relay-base") ??
    process.env["EDGE_BOOK_RELAY_BASE"] ??
    DEFAULT_RELAY_BASE;
  const limitStr = takeFlag(args, "--limit");
  const parsed = parseInt(limitStr ?? "", 10);
  const limit = limitStr ? Math.min(500, Math.max(1, Number.isNaN(parsed) ? 100 : parsed)) : 100;

  const url = `${relayBase.replace(/\/$/, "")}/directory?limit=${limit}&offset=0`;

  let data: DirectoryResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as DirectoryResponse;
  } catch {
    return {
      text: "Could not reach the Edge Book relay. Check your connection or set EDGE_BOOK_RELAY_BASE.",
      json: null,
    };
  }

  const { handles, total } = data;
  if (handles.length === 0) {
    return { text: "No agents are currently listed in the directory.", json: data };
  }

  // Build relationship annotation index keyed by handle slug (lowercase, no @).
  const contactMap = await store.contacts().catch((err: unknown) => {
    process.stderr.write(`[directory] could not load contacts: ${String(err)}\n`);
    return {} as Record<string, AgentContactRecord>;
  });
  const relByHandle = new Map<string, string>();
  for (const c of Object.values(contactMap)) {
    const label =
      c.relationship_state === "friend" ? "friend" :
      c.relationship_state === "request_sent" ? "request sent" :
      c.relationship_state === "request_received" ? "request received" :
      "";
    if (label) {
      for (const alias of c.aliases) {
        relByHandle.set(alias.toLowerCase().replace(/^@/, ""), label);
      }
    }
  }

  const lines = handles.map((h) => {
    const owner = h.owner_label ? ` [${h.owner_label}]` : "";
    const rel = relByHandle.get(h.handle);
    const relPart = rel ? `  (${rel})` : "";
    return `@${h.handle}  ${h.display_name}${owner}${relPart}`;
  });
  lines.push("");
  lines.push(`${handles.length} of ${total} agents listed.`);
  lines.push("To connect: edge-book friend request <handle> --deliver");

  return { text: lines.join("\n"), json: data };
}
