// spec-142 self-update: throttled registry version check (checkLatest) and
// the `edge-book self-update` command. Registry and npm install are always
// mocked — these tests never touch the network or a real npm tree.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";
import { readEvents } from "../src/event-log.ts";
import {
  SELF_UPDATE_LOCK,
  UPDATE_CHECK_THROTTLE_MS,
  autoUpdateAllowed,
  checkLatest,
  compareVersions,
  resolveInstallRoot,
  runningVersion,
  selfUpdate,
} from "../src/self-update.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-self-update-test-"));
}

async function initHome(): Promise<string> {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--handle", "scout", "--name", "Scout Agent", "--no-greeter"]);
  return home;
}

// A fetch stub answering the registry /latest endpoint.
function fakeRegistry(version: string | Error): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    if (version instanceof Error) throw version;
    return { ok: true, json: async () => ({ version }) } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// A writable fake npm install root: <root>/node_modules/edge-book/{package.json,dist/edge-book.js}.
async function fakeInstallRoot(version: string, distPrints = version): Promise<string> {
  const root = await tempRoot();
  const pkgDir = path.join(root, "node_modules", "edge-book");
  await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "edge-book", version }), "utf8");
  await fs.writeFile(path.join(pkgDir, "dist", "edge-book.js"), `console.log(${JSON.stringify(distPrints)});\n`, "utf8");
  return root;
}

// ── compareVersions / policy ────────────────────────────────────────────────

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("0.17.1", "0.18.0"), -1);
  assert.equal(compareVersions("0.18.0", "0.17.1"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1, "numeric, not lexicographic");
});

test("autoUpdateAllowed: pre-1.0 always; post-1.0 only within the same major", () => {
  assert.equal(autoUpdateAllowed("0.17.1", "0.18.0"), true, "all 0.x auto");
  assert.equal(autoUpdateAllowed("0.17.1", "1.0.0"), true, "pre-1.0 running auto-updates across all versions");
  assert.equal(autoUpdateAllowed("1.2.0", "1.9.0"), true, "same major auto");
  assert.equal(autoUpdateAllowed("1.2.0", "2.0.0"), false, "cross-major drift needs a decision");
});

// ── checkLatest ─────────────────────────────────────────────────────────────

test("checkLatest queries the registry, caches the result, and records the check time", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const { fetchImpl, calls } = fakeRegistry("9.9.9");
  const base = Date.now();
  const latest = await checkLatest(store, { now: base, fetchImpl });
  assert.equal(latest, "9.9.9");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /registry\.npmjs\.org\/edge-book\/latest/);
  const config = await store.config();
  assert.equal(config.update_latest_known, "9.9.9");
  assert.equal(config.update_check_at, base);
});

test("checkLatest is throttled to one registry hit per 24h, serving the cache inside the window", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const base = Date.now();
  await checkLatest(store, { now: base, fetchImpl: fakeRegistry("9.9.9").fetchImpl });
  const second = fakeRegistry("10.0.0");
  const inside = await checkLatest(store, { now: base + UPDATE_CHECK_THROTTLE_MS - 1, fetchImpl: second.fetchImpl });
  assert.equal(inside, "9.9.9", "inside the window the cached value is served");
  assert.equal(second.calls.length, 0, "no registry hit inside the throttle window");
  const outside = await checkLatest(store, { now: base + UPDATE_CHECK_THROTTLE_MS + 1, fetchImpl: second.fetchImpl });
  assert.equal(outside, "10.0.0", "past the window the registry is re-queried");
});

test("checkLatest force ignores the throttle (the --if-stale fresh check)", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const base = Date.now();
  await checkLatest(store, { now: base, fetchImpl: fakeRegistry("9.9.9").fetchImpl });
  const fresh = fakeRegistry("10.0.0");
  const latest = await checkLatest(store, { now: base + 1, fetchImpl: fresh.fetchImpl, force: true });
  assert.equal(latest, "10.0.0");
  assert.equal(fresh.calls.length, 1);
});

test("checkLatest failures are silent: offline returns the cached value, never throws", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const base = Date.now();
  await checkLatest(store, { now: base, fetchImpl: fakeRegistry("9.9.9").fetchImpl });
  const offline = await checkLatest(store, { now: base + UPDATE_CHECK_THROTTLE_MS + 1, fetchImpl: fakeRegistry(new Error("offline")).fetchImpl });
  assert.equal(offline, "9.9.9", "failure degrades to the cached value");
  const neverChecked = new EdgeBookStore({ home: await initHome() });
  const nothing = await checkLatest(neverChecked, { fetchImpl: fakeRegistry(new Error("offline")).fetchImpl });
  assert.equal(nothing, undefined, "no cache + failure = undefined, no throw");
});

test("checkLatest ignores a malformed registry response", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const fetchImpl = (async () => ({ ok: true, json: async () => ({ nope: true }) }) as unknown as Response) as typeof fetch;
  assert.equal(await checkLatest(store, { fetchImpl }), undefined);
  assert.equal((await store.config()).update_latest_known, undefined);
});

// ── selfUpdate ──────────────────────────────────────────────────────────────

test("self-update --if-stale no-ops silently when current", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const installs: string[] = [];
  const out = await selfUpdate(store, {
    ifStale: true,
    running: "1.0.0",
    fetchImpl: fakeRegistry("1.0.0").fetchImpl,
    npmInstall: async (spec) => { installs.push(spec); },
  });
  assert.equal(out.status, "current");
  assert.equal(out.text, "", "--if-stale is the cron form: silent when current");
  assert.equal(installs.length, 0);
});

test("self-update never downgrades", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const installs: string[] = [];
  const out = await selfUpdate(store, {
    running: "1.5.0",
    fetchImpl: fakeRegistry("1.4.0").fetchImpl,
    installRoot: await fakeInstallRoot("1.5.0"),
    npmInstall: async (spec) => { installs.push(spec); },
  });
  assert.equal(out.status, "current");
  assert.equal(installs.length, 0, "a lower latest must never trigger an install");
});

test("self-update updates when behind: npm install against the root, audit + flight record + updated_at", async () => {
  const home = await initHome();
  const store = new EdgeBookStore({ home });
  const root = await fakeInstallRoot("0.17.0");
  const installs: Array<{ spec: string; root: string }> = [];
  const now = Date.now();
  const out = await selfUpdate(store, {
    ifStale: true,
    now,
    running: "0.17.0",
    fetchImpl: fakeRegistry("0.18.0").fetchImpl,
    installRoot: root,
    npmInstall: async (spec, prefix) => { installs.push({ spec, root: prefix }); },
    verify: async () => "0.18.0",
  });
  assert.equal(out.status, "updated");
  assert.equal(out.from, "0.17.0");
  assert.equal(out.to, "0.18.0");
  assert.deepEqual(installs, [{ spec: "edge-book@0.18.0", root }]);
  assert.match(out.text, /restart/i, "output must tell the agent about the dial-out restart");
  const audit = (await store.auditEvents()).find((e) => e.kind === "update.self");
  assert.ok(audit, "update.self audit record written");
  assert.equal((audit!.details as { from?: string }).from, "0.17.0");
  assert.equal((audit!.details as { to?: string }).to, "0.18.0");
  const events = await readEvents(store);
  assert.ok(events.some((e) => e.kind === "update.self" && e.from === "0.17.0" && e.to === "0.18.0"), "flight-recorder event");
  const config = await store.config();
  assert.equal(config.updated_at, now);
  assert.equal(config.update_latest_known, "0.18.0");
});

test("self-update smoke-verifies via a real --version spawn of the new build", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  // The fake dist prints exactly the new version — the default verify spawn must accept it.
  const root = await fakeInstallRoot("0.18.0", "0.18.0");
  const out = await selfUpdate(store, {
    running: "0.17.0",
    fetchImpl: fakeRegistry("0.18.0").fetchImpl,
    installRoot: root,
    npmInstall: async () => undefined,
  });
  assert.equal(out.status, "updated");
});

test("smoke-verify failure → update_failed, previous tree intact, audit records the attempt", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const root = await fakeInstallRoot("0.17.0");
  await assert.rejects(
    selfUpdate(store, {
      running: "0.17.0",
      fetchImpl: fakeRegistry("0.18.0").fetchImpl,
      installRoot: root,
      npmInstall: async () => undefined,
      verify: async () => "0.17.0", // new build reports the wrong version
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "update_failed");
      return true;
    },
  );
  const audit = (await store.auditEvents()).find((e) => e.kind === "update.self");
  assert.ok(audit, "the failed attempt must still be audited");
  assert.equal((audit!.details as { ok?: boolean }).ok, false);
  assert.equal((await store.config()).updated_at, undefined, "no updated_at on failure");
});

test("self-update refuses a system-managed root with the manual command", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await assert.rejects(
    selfUpdate(store, {
      running: "0.17.0",
      fetchImpl: fakeRegistry("0.18.0").fetchImpl,
      installRoot: "/usr/lib",
      npmInstall: async () => undefined,
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "install_not_self_updatable");
      assert.match(error.message, /npm install/, "error must carry the manual command");
      return true;
    },
  );
});

test("self-update refuses an unwritable root", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("permission semantics differ");
  const store = new EdgeBookStore({ home: await initHome() });
  const root = await fakeInstallRoot("0.17.0");
  await fs.chmod(root, 0o555);
  try {
    await assert.rejects(
      selfUpdate(store, {
        running: "0.17.0",
        fetchImpl: fakeRegistry("0.18.0").fetchImpl,
        installRoot: root,
        npmInstall: async () => undefined,
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "install_not_self_updatable");
        return true;
      },
    );
  } finally {
    await fs.chmod(root, 0o755);
  }
});

test("self-update refuses when not running from an npm install (no node_modules ancestor)", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  await assert.rejects(
    selfUpdate(store, {
      running: "0.17.0",
      fetchImpl: fakeRegistry("0.18.0").fetchImpl,
      installRoot: null, // resolveInstallRoot found no node_modules/edge-book ancestor
      npmInstall: async () => undefined,
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "install_not_self_updatable");
      assert.match(error.message, /npm install -g edge-book@latest/);
      return true;
    },
  );
});

test("lockfile in the install root blocks concurrent runs and is released afterwards", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const root = await fakeInstallRoot("0.17.0");
  await fs.writeFile(path.join(root, SELF_UPDATE_LOCK), String(process.pid), "utf8");
  await assert.rejects(
    selfUpdate(store, {
      running: "0.17.0",
      fetchImpl: fakeRegistry("0.18.0").fetchImpl,
      installRoot: root,
      npmInstall: async () => undefined,
      verify: async () => "0.18.0",
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "update_in_progress");
      return true;
    },
  );
  await fs.rm(path.join(root, SELF_UPDATE_LOCK));
  const out = await selfUpdate(store, {
    running: "0.17.0",
    fetchImpl: fakeRegistry("0.18.0").fetchImpl,
    installRoot: root,
    npmInstall: async () => undefined,
    verify: async () => "0.18.0",
  });
  assert.equal(out.status, "updated");
  await assert.rejects(fs.stat(path.join(root, SELF_UPDATE_LOCK)), "lock must be released after the run");
});

test("--if-stale respects the kill switch and the notify mode (no automatic update)", async () => {
  for (const mode of ["off", "notify"] as const) {
    const store = new EdgeBookStore({ home: await initHome() });
    await store.updateConfig({ auto_update: mode });
    const installs: string[] = [];
    const out = await selfUpdate(store, {
      ifStale: true,
      running: "0.17.0",
      fetchImpl: fakeRegistry("0.18.0").fetchImpl,
      installRoot: await fakeInstallRoot("0.17.0"),
      npmInstall: async (spec) => { installs.push(spec); },
      verify: async () => "0.18.0",
    });
    assert.equal(out.status, "skipped", `auto_update=${mode} must gate the cron path`);
    assert.equal(out.text, "", "cron form stays silent");
    assert.equal(installs.length, 0);
  }
});

test("policy: cross-major drift under auto → no automatic update (nudge path owns it); explicit run still updates", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const installs: string[] = [];
  const deps = {
    running: "1.2.0",
    fetchImpl: fakeRegistry("2.0.0").fetchImpl,
    installRoot: await fakeInstallRoot("1.2.0"),
    npmInstall: async (spec: string) => { installs.push(spec); },
    verify: async () => "2.0.0",
  };
  const auto = await selfUpdate(store, { ifStale: true, ...deps });
  assert.equal(auto.status, "skipped", "cross-major under auto downgrades to the notify nudge");
  assert.equal(installs.length, 0);
  const explicit = await selfUpdate(store, deps);
  assert.equal(explicit.status, "updated", "an explicit self-update is the human/agent decision");
  assert.deepEqual(installs, ["edge-book@2.0.0"]);
});

test("registry unreachable: --if-stale exits silently, explicit run reports the failure", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const offline = fakeRegistry(new Error("offline"));
  const quiet = await selfUpdate(store, { ifStale: true, running: "0.17.0", fetchImpl: offline.fetchImpl });
  assert.equal(quiet.status, "current");
  assert.equal(quiet.text, "");
  await assert.rejects(
    selfUpdate(store, { running: "0.17.0", fetchImpl: fakeRegistry(new Error("offline")).fetchImpl }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "registry_unreachable");
      return true;
    },
  );
});

test("--dry-run reports the would-be update without installing", async () => {
  const store = new EdgeBookStore({ home: await initHome() });
  const installs: string[] = [];
  const out = await selfUpdate(store, {
    dryRun: true,
    running: "0.17.0",
    fetchImpl: fakeRegistry("0.18.0").fetchImpl,
    installRoot: await fakeInstallRoot("0.17.0"),
    npmInstall: async (spec) => { installs.push(spec); },
  });
  assert.equal(out.status, "dry_run");
  assert.match(out.text, /0\.17\.0/);
  assert.match(out.text, /0\.18\.0/);
  assert.equal(installs.length, 0);
});

test("resolveInstallRoot walks up to the node_modules/edge-book prefix root", async () => {
  const root = await fakeInstallRoot("0.17.0");
  const moduleFile = path.join(root, "node_modules", "edge-book", "dist", "edge-book.js");
  assert.equal(resolveInstallRoot(moduleFile), root);
  assert.equal(resolveInstallRoot("/some/dev/checkout/src/self-update.ts"), null, "a git checkout is not an npm install");
});

// ── CLI surface ─────────────────────────────────────────────────────────────

test("edge-book version prints the running package version", async () => {
  const result = await handleCli(["version"]);
  assert.equal(result.text, await runningVersion());
  assert.match(result.text, /^\d+\.\d+\.\d+/);
});

test("edge-book self-update --if-stale is wired through handleCli (injectable deps)", async () => {
  const home = await initHome();
  const result = await handleCli(["self-update", "--if-stale", "--home", home], {
    selfUpdateDeps: { running: "1.0.0", fetchImpl: fakeRegistry("1.0.0").fetchImpl },
  });
  assert.equal(result.text, "", "current → exit 0, silent");
  const updated = await handleCli(["self-update", "--home", home], {
    selfUpdateDeps: {
      running: "0.17.0",
      fetchImpl: fakeRegistry("0.18.0").fetchImpl,
      installRoot: await fakeInstallRoot("0.17.0"),
      npmInstall: async () => undefined,
      verify: async () => "0.18.0",
    },
  });
  assert.match(updated.text, /0\.17\.0 → 0\.18\.0/);
});
