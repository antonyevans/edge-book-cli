// Two-agent smoke runner (ea-openclaw-031). Creates two (well, three —
// Alice, Bob, and a non-friend Carol) independent agents on disk and drives
// the full local interaction surface, printing a pass/fail checklist.
// Exits nonzero on any failed step.
//
//   node scripts/smoke-2agent.ts                  # LOCAL in-process, temp dir
//   node scripts/smoke-2agent.ts --dir ./.smoke   # persist agents on disk
//   node scripts/smoke-2agent.ts --host           # over a spawned local host mailbox
//   node scripts/smoke-2agent.ts --remote https://edge-book-host.fly.dev   # over a deployed host
//   npm run smoke   |   npm run smoke:host
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSmoke, type TransportFactory } from "./lib/two-agent-smoke.ts";
import { makeHostTransport } from "./lib/host-transport.ts";

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args.splice(i, 2)[1];
}

function takeBool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const explicitDir = takeFlag(args, "--dir");
  const remoteBase = takeFlag(args, "--remote");
  const useHost = takeBool(args, "--host") || Boolean(remoteBase);
  const dir = explicitDir ? path.resolve(explicitDir) : await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-smoke-"));
  await fs.mkdir(dir, { recursive: true });

  const makeTransport: TransportFactory | undefined = useHost ? makeHostTransport({ remoteBase }) : undefined;
  const result = await runSmoke({ dir, makeTransport });

  console.log(`\nTwo-agent smoke [${result.transport}] — agents on disk under ${dir}\n`);
  for (const s of result.steps) {
    console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}\n      ${s.detail}`);
  }
  const passed = result.steps.filter((s) => s.ok).length;
  console.log(`\n${passed}/${result.steps.length} steps passed — ${result.ok ? "ALL GREEN" : "FAILURES"}`);
  if (!explicitDir) {
    await fs.rm(dir, { recursive: true, force: true });
  } else {
    console.log(`Agents left on disk: ${result.agents.alice}, ${result.agents.bob}, ${result.agents.carol}`);
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke runner crashed:", error);
  process.exit(1);
});
