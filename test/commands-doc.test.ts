import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_GROUPS, renderUsage, renderReadmeTable } from "../src/commands-doc.ts";

// Top-level commands handled in cli.ts that are intentionally NOT in the user-facing
// registry. These are runtime help aliases that print the usage text rather than being
// documented commands in their own right. A genuinely new user-facing command must be
// added to COMMAND_GROUPS, not here.
const UNDOCUMENTED = new Set<string>(["help", "--help", "-h", "--version", "-v"]); // --version/-v are aliases of the documented `version` command

test("registry is non-empty and every row has usage + desc", () => {
  const rows = COMMAND_GROUPS.flatMap((g) => g.rows);
  assert.ok(rows.length >= 20);
  for (const r of rows) { assert.ok(r.usage.trim()); assert.ok(r.desc.trim()); }
});

test("renderUsage produces grouped text including key commands", () => {
  const u = renderUsage();
  for (const c of ["init", "profile set", "profile visibility", "friend request", "friend pending",
                    "friend policy", "report", "object share", "escalation raise", "candidates list"]) {
    assert.ok(u.includes(c), `usage missing: ${c}`);
  }
});

test("renderReadmeTable is a markdown table with a header and the same commands", () => {
  const t = renderReadmeTable();
  assert.ok(t.includes("| Command | What it does |"));
  assert.ok(t.includes("`friend policy"));
  assert.ok(t.includes("`report"));
});

test("registry reconciles against every top-level command in cli.ts (drift guard)", () => {
  // Read the real CLI source and extract every top-level command string from the
  // `command === "..."` comparisons. This catches the exact drift this feature
  // prevents: a new command wired into cli.ts but never added to the registry.
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cliSource = readFileSync(cliPath, "utf8");

  const commands = new Set<string>();
  for (const m of cliSource.matchAll(/command === "([^"]+)"/g)) {
    commands.add(m[1]);
  }
  assert.ok(commands.size > 0, "extracted no commands from cli.ts");

  const usage = renderUsage();
  // A command is documented if a usage line begins with `edge-book <command>`
  // (as a whole token, so `query` does not match `query-delete`).
  const documents = (cmd: string): boolean => {
    const re = new RegExp(`^\\s*edge-book ${cmd.replace(/[-]/g, "\\$&")}(\\s|$)`, "m");
    return re.test(usage);
  };

  const missing: string[] = [];
  for (const cmd of commands) {
    if (UNDOCUMENTED.has(cmd)) continue;
    if (!documents(cmd)) missing.push(cmd);
  }

  assert.deepEqual(
    missing,
    [],
    `cli.ts commands missing from the registry (add to COMMAND_GROUPS, or to UNDOCUMENTED if runtime-only): ${missing.join(", ")}`,
  );
});
