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

function fakeRunner(over: Partial<HermesRunner> & { listing?: string } = {}): HermesRunner & { created: string[][] } {
  const created: string[][] = [];
  return {
    hermesBin: "hermesBin" in over ? (over.hermesBin ?? null) : "/opt/hermes/.venv/bin/hermes",
    list: over.list ?? (() => over.listing ?? ""),
    create: over.create ?? ((args: string[]) => { created.push(args); }),
    created,
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

test("cron already present → already_present, no duplicate create", () => {
  const runner = fakeRunner({ listing: `some-id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram` });
  const r = ensureNotifierCron({ runner, home: HOME });
  assert.equal(r.status, "already_present");
  assert.equal(runner.created.length, 0);
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

test("buildFriendRequestsPrompt pins home and uses [SILENT]", () => {
  const p = buildFriendRequestsPrompt(HOME);
  assert.match(p, /\[SILENT\]/);
  assert.ok(p.includes(HOME));
  assert.match(p, /friend pending/);
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
