// Wire-schema embed sync (ea-claude-152) — cli half of the cross-repo contract.
//
// schemas/wire-frames.schema.json is VENDORED byte-identical from
// edge-book-host (canonical source: host src/contracts.ts via its
// scripts/generate-wire-schemas.ts). Host CI fetches this repo's copy from
// main and fails on any byte difference — never reformat or edit the JSON.
//
// This script derives the runtime embed from the vendored JSON:
//
//   src/wire-schema.ts — the schema as an exported const, so runtime code
//                        imports it (the npm package ships dist only; an
//                        fs-read of the JSON would break installed CLIs).
//
// Usage:
//   npm run schemas         — regenerate src/wire-schema.ts in place
//   npm run schemas:check   — regenerate to a temp dir and diff (exit 1 on
//                             drift; spec-0042 generator-equivalence rule)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_IN = path.join("schemas", "wire-frames.schema.json");
const TS_OUT = path.join("src", "wire-schema.ts");

function renderTs(json: string): string {
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    "// Source of truth: schemas/wire-frames.schema.json, VENDORED byte-identical from",
    "// edge-book-host (canonical: host src/contracts.ts). Host CI enforces the vendored",
    "// copy's byte-sync against this repo's main; `npm run schemas:check` enforces this",
    "// embed against the vendored JSON. Regenerate with `npm run schemas`.",
    "// (Embedded as one line so the 500-code-line file cap never bites.)",
    `export const WIRE_FRAMES_SCHEMA = ${JSON.stringify(JSON.parse(json))} as const;`,
    "",
  ].join("\n");
}

function main(): void {
  const json = fs.readFileSync(path.join(ROOT, JSON_IN), "utf8");
  const ts = renderTs(json);
  const check = process.argv.includes("--check");

  if (!check) {
    fs.writeFileSync(path.join(ROOT, TS_OUT), ts);
    console.log(`wrote ${TS_OUT} from ${JSON_IN}`);
    return;
  }

  // --check: regenerate to a temp dir and diff (spec-0042).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-schema-"));
  try {
    fs.writeFileSync(path.join(tmp, "wire-schema.ts"), ts);
    const committed = fs.existsSync(path.join(ROOT, TS_OUT))
      ? fs.readFileSync(path.join(ROOT, TS_OUT), "utf8")
      : "<missing>";
    if (committed !== fs.readFileSync(path.join(tmp, "wire-schema.ts"), "utf8")) {
      console.error(`DRIFT: ${TS_OUT} does not match ${JSON_IN} (run \`npm run schemas\`)`);
      process.exit(1);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`schemas:check ok — ${TS_OUT} matches ${JSON_IN}`);
}

main();
