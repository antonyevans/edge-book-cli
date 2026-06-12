import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureNotifierCron,
  buildFriendRequestsPrompt,
  FRIEND_REQUESTS_CRON_NAME,
  ensureGreeterCron,
  buildGreeterPrompt,
  GREETER_CRON_NAME,
  type HermesRunner,
} from "../src/host-cron.ts";

function fakeRunner(over: Partial<HermesRunner> & { listing?: string } = {}): HermesRunner & { created: string[][]; removed: string[] } {
  const created: string[][] = [];
  const removed: string[] = [];
  return {
    hermesBin: "hermesBin" in over ? (over.hermesBin ?? null) : "/opt/hermes/.venv/bin/hermes",
    list: over.list ?? (() => over.listing ?? ""),
    create: over.create ?? ((args: string[]) => { created.push(args); }),
    getPrompt: over.getPrompt ?? (() => null),
    remove: over.remove ?? ((name: string) => { removed.push(name); }),
    created,
    removed,
  };
}

const HOME = "/opt/data/home/.openclaw/edge-book";

test("disabled → no host mutation", () => {
  const runner = fakeRunner();
  const r = ensureNotifierCron({ runner, home: HOME, disabled: true });
  assert.equal(r.status, "disabled");
  assert.equal(runner.created.length, 0);
});

test("no hermes binary → host_unsupported, no create", () => {
  const runner = fakeRunner({ hermesBin: null });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "host_unsupported");
  assert.equal(runner.created.length, 0);
});

test("cron already present, prompt unreadable → already_present, no churn", () => {
  // getPrompt returns null (host cannot show the stored prompt) — be
  // conservative: keep the existing job rather than recreating every run.
  const runner = fakeRunner({ listing: `some-id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram` });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "already_present");
  assert.equal(runner.created.length, 0);
  assert.equal(runner.removed.length, 0);
});

test("spec-139: cron present with the current prompt → already_present, no recreate", () => {
  const runner = fakeRunner({
    listing: `some-id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram`,
    getPrompt: () => `name: ${FRIEND_REQUESTS_CRON_NAME}\nprompt:\n${buildFriendRequestsPrompt(HOME)}\n`,
  });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "already_present");
  assert.equal(runner.created.length, 0);
  assert.equal(runner.removed.length, 0);
});

test("spec-139: cron present with a stale prompt → deleted and recreated with the current prompt", () => {
  const stale = "1. List pending requests: edge-book friend pending --home " + HOME + " --json\n" +
    "If edge-book is not on PATH, use: npm exec -y edge-book@0.11.0 -- friend pending --home " + HOME + " --json";
  const runner = fakeRunner({
    listing: `some-id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram`,
    getPrompt: () => stale,
  });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "updated");
  assert.deepEqual(runner.removed, [FRIEND_REQUESTS_CRON_NAME], "stale job removed first");
  assert.equal(runner.created.length, 1, "fresh job created");
  const prompt = runner.created[0][3];
  assert.match(prompt, /friend pending --new/, "recreated with the --new notifier surface");
  assert.ok(!/edge-book@\d/.test(prompt), "recreated without a stale version pin");
});

test("absent + hermes present → installs the cron with correct args", () => {
  const runner = fakeRunner({ listing: "id  Edge — daily digest  0 8 * * *  telegram" });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "installed");
  assert.equal(runner.created.length, 1);
  const args = runner.created[0];
  assert.deepEqual(args.slice(0, 3), ["cron", "create", "*/20 * * * *"]);
  assert.ok(args.includes("--name"));
  assert.ok(args.includes(FRIEND_REQUESTS_CRON_NAME));
  assert.deepEqual(args.slice(-4), ["--deliver", "telegram", "--workdir", HOME]);
  // the prompt arg is present and carries the pinned home + the Hermes no-reply marker
  const prompt = args[3];
  assert.match(prompt, /\[SILENT\]/);
  assert.ok(prompt.includes(HOME), "prompt pins the agent's edge-book home");
});

test("create failure → error status, surfaced detail", () => {
  const runner = fakeRunner({ create: () => { throw new Error("hermes boom"); } });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "error");
  assert.match(String(r.detail), /boom/);
});

test("buildFriendRequestsPrompt pins home, uses [SILENT], polls --new, and carries no version pin", () => {
  const p = buildFriendRequestsPrompt(HOME);
  assert.match(p, /\[SILENT\]/);
  assert.ok(p.includes(HOME));
  assert.match(p, /friend pending --new/, "spec-139: the cron polls the un-notified surface");
  assert.ok(!/edge-book@\d/.test(p), "spec-139: no stale version pin");
});

test("greeter cron: disabled → no host mutation", () => {
  const runner = fakeRunner();
  const r = ensureGreeterCron({ runner, home: HOME, disabled: true });
  assert.equal(r.status, "disabled");
  assert.equal(runner.created.length, 0);
});

test("greeter cron: no hermes binary → host_unsupported", () => {
  const runner = fakeRunner({ hermesBin: null });
  const r = ensureGreeterCron({ runner, home: HOME });
  assert.equal(r.status, "host_unsupported");
  assert.equal(runner.created.length, 0);
});

test("greeter cron: already present → no duplicate create", () => {
  const runner = fakeRunner({ listing: `some-id  ${GREETER_CRON_NAME}  */5 * * * *  telegram` });
  const r = ensureGreeterCron({ runner, home: HOME });
  assert.equal(r.status, "already_present");
  assert.equal(runner.created.length, 0);
});

test("greeter cron: absent + hermes present → installs every 5 minutes with the run-command prompt", () => {
  const runner = fakeRunner({ listing: `id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram` });
  const r = ensureGreeterCron({ runner, home: HOME });
  assert.equal(r.status, "installed");
  assert.equal(runner.created.length, 1);
  const args = runner.created[0];
  assert.deepEqual(args.slice(0, 3), ["cron", "create", "*/5 * * * *"]);
  assert.ok(args.includes("--name"));
  assert.ok(args.includes(GREETER_CRON_NAME));
  assert.deepEqual(args.slice(-4), ["--deliver", "telegram", "--workdir", HOME]);
  // Minimal run-command prompt: pins home, runs auto-accept --deliver, silences quiet cycles.
  const prompt = args[3];
  assert.ok(prompt.includes(`friend auto-accept --deliver --home ${HOME}`), "prompt runs the self-contained command");
  assert.match(prompt, /\[SILENT\]/);
});

test("greeter cron: name does not collide with the notifier cron name", () => {
  assert.notEqual(GREETER_CRON_NAME, FRIEND_REQUESTS_CRON_NAME);
  assert.ok(GREETER_CRON_NAME.startsWith("Edge Book — "), "must keep the Edge Book cron name prefix");
  assert.ok(buildGreeterPrompt(HOME).includes(HOME));
});

// ── spec-141: mechanical install/update auto-acks the prompt version ────────

test("spec-141: ensure-notifier CLI auto-acks on a mechanical install", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { handleCli } = await import("../src/cli.ts");
  const { EdgeBookStore } = await import("../src/edge-book.ts");
  const { NOTIFIER_PROMPT_VERSION } = await import("../src/host-cron.ts");

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cron-ack-test-"));
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  const runner = fakeRunner();
  const result = await handleCli(["ensure-notifier", "--home", home], { hermesRunner: runner });
  assert.match(result.text, /Installed notifier cron/);
  assert.equal((await new EdgeBookStore({ home }).config()).notifier_prompt_ack, NOTIFIER_PROMPT_VERSION,
    "mechanical installed → ack set");
});

test("spec-141: ensure-notifier CLI auto-acks on a mechanical update (stale prompt recreated)", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { handleCli } = await import("../src/cli.ts");
  const { EdgeBookStore } = await import("../src/edge-book.ts");
  const { NOTIFIER_PROMPT_VERSION } = await import("../src/host-cron.ts");

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cron-ack-test-"));
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  const runner = fakeRunner({
    listing: `some-id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram`,
    getPrompt: () => "npm exec -y edge-book@0.11.0 -- friend pending",
  });
  const result = await handleCli(["ensure-notifier", "--home", home], { hermesRunner: runner });
  assert.match(result.text, /recreated/);
  assert.equal((await new EdgeBookStore({ home }).config()).notifier_prompt_ack, NOTIFIER_PROMPT_VERSION,
    "mechanical updated → ack set");
});

test("spec-141: ensure-notifier CLI does not ack when already_present (prompt unverified)", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { handleCli } = await import("../src/cli.ts");
  const { EdgeBookStore } = await import("../src/edge-book.ts");

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cron-ack-test-"));
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  // getPrompt → null: the stored prompt cannot be read, so it may still be stale.
  const runner = fakeRunner({ listing: `some-id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram` });
  const result = await handleCli(["ensure-notifier", "--home", home], { hermesRunner: runner });
  assert.match(result.text, /already present/);
  assert.equal((await new EdgeBookStore({ home }).config()).notifier_prompt_ack, undefined,
    "unverified prompt must not be acked");
});
