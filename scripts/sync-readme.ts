#!/usr/bin/env tsx
/**
 * sync-readme.ts — regenerate the README command table from the registry.
 *
 * Usage:
 *   npx tsx scripts/sync-readme.ts          # write (update in-place)
 *   npx tsx scripts/sync-readme.ts --check  # exit 1 if stale, 0 if in sync
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReadmeTable } from "../src/commands-doc.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.resolve(__dirname, "../README.md");

const START_MARKER = "<!-- COMMANDS:START";
const END_MARKER = "<!-- COMMANDS:END -->";

function syncReadme(checkOnly: boolean): void {
  const original = fs.readFileSync(README_PATH, "utf8");

  const startIdx = original.indexOf(START_MARKER);
  const endIdx = original.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `README.md is missing the COMMANDS:START / COMMANDS:END markers.\n` +
        `Add them around the command reference section.`,
    );
  }

  // Find the end of the start-marker line (we preserve the full start-marker line as-is)
  const startLineEnd = original.indexOf("\n", startIdx);
  if (startLineEnd === -1) {
    throw new Error("COMMANDS:START marker line has no newline terminator.");
  }

  const before = original.slice(0, startLineEnd + 1); // everything up to and including the start-marker line
  const after = original.slice(endIdx);                // from the end-marker onwards

  const table = renderReadmeTable();
  const regenerated = `${before}\n${table}\n${after}`;

  if (checkOnly) {
    if (regenerated !== original) {
      console.error(
        "sync-readme: README command table is stale. Run `npm run sync-readme` to update.",
      );
      process.exit(1);
    }
    console.log("sync-readme: README command table is up to date.");
    return;
  }

  fs.writeFileSync(README_PATH, regenerated, "utf8");
  console.log("sync-readme: README.md updated.");
}

const checkOnly = process.argv.includes("--check");
syncReadme(checkOnly);
