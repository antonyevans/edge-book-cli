// Extract a replay-fixture skeleton from a user's doctor bundle (spec-135).
//
// Usage:
//   node scripts/extract-replay-fixture.ts <doctor-bundle.json> [--trace <trace_id>|all] [--out <file>]
//
// Operator workflow:
//   1. User runs `edge-book doctor --send` (or pastes `doctor --json`) — you
//      receive the bundle via `edge-book support read <id>` or as a file.
//   2. Run this script with the failing trace_id (see the bundle's `traces`
//      section) to get a skeleton fixture.
//   3. Fill in the TODO synthetic bodies, rename the synthetic identities,
//      tighten the expectations (events / relationship_state).
//   4. Drop the file into test/replay/fixtures/ — `npm test` discovers and
//      runs every fixture there automatically (test/replay.test.ts).
//
// Why a script and not a CLI command: extraction is an OPERATOR/dev workflow
// that turns a received bundle into a repo test fixture. It never runs on a
// user's agent, so it does not belong on the frozen `edge-book` command
// surface (commands-doc.ts / README table / npm bundle).
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildFixtureSkeleton } from "../test/replay/fixture-skeleton.ts";
import { validateFixture } from "../test/replay/replay-harness.ts";

function usage(): never {
  console.error("Usage: node scripts/extract-replay-fixture.ts <doctor-bundle.json> [--trace <trace_id>|all] [--out <file>]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let bundlePath = "";
  let trace = "all";
  let out = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--trace") trace = args[++i] ?? usage();
    else if (a === "--out") out = args[++i] ?? usage();
    else if (a.startsWith("--")) usage();
    else if (!bundlePath) bundlePath = a;
    else usage();
  }
  if (!bundlePath) usage();

  const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8")) as unknown;
  const { fixture, notes } = buildFixtureSkeleton(bundle, trace);
  validateFixture(fixture, "extracted skeleton"); // belt-and-suspenders: skeletons must load in the harness

  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  if (out) {
    await fs.writeFile(path.resolve(out), json, "utf8");
    console.error(`Skeleton written to ${out}`);
  } else {
    process.stdout.write(json);
  }
  for (const note of notes) console.error(`note: ${note}`);
  console.error("Next: fill in TODO synthetic bodies, then drop the file into test/replay/fixtures/ — npm test picks it up automatically.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
