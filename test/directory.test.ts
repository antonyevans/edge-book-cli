import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleDirectoryCli } from "../src/cli-directory.ts";

async function tmpStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-dir-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Test Agent" });
  return s;
}

function withFetch(mock: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  return fn().finally(() => { globalThis.fetch = orig; });
}

const mockDir = {
  handles: [
    { handle: "alice-smith", display_name: "Alice Smith", claimed_at: 1000 },
    { handle: "bob-jones", display_name: "Bob Jones", owner_label: "Robert Jones", claimed_at: 2000 },
  ],
  total: 2,
};

test("directory returns null for non-directory commands", async () => {
  const store = await tmpStore();
  const result = await handleDirectoryCli("resolve", [], {}, undefined, store);
  assert.equal(result, null);
  await fs.rm(store.home, { recursive: true });
});

test("directory formats text output with handles + hint line", async () => {
  const store = await tmpStore();
  await withFetch(async () => ({ ok: true, json: async () => mockDir }) as unknown as Response, async () => {
    const result = await handleDirectoryCli("directory", [], {}, undefined, store);
    assert.ok(result, "should return a result");
    assert.ok(result.text.includes("@alice-smith"), "should include alice handle");
    assert.ok(result.text.includes("Alice Smith"), "should include display name");
    assert.ok(result.text.includes("@bob-jones"), "should include bob handle");
    assert.ok(result.text.includes("[Robert Jones]"), "should include owner_label in brackets");
    assert.ok(result.text.includes("edge-book friend request"), "should include hint line");
    assert.deepEqual(result.json, mockDir);
  });
  await fs.rm(store.home, { recursive: true });
});

test("directory empty state message", async () => {
  const store = await tmpStore();
  await withFetch(async () => ({ ok: true, json: async () => ({ handles: [], total: 0 }) }) as unknown as Response, async () => {
    const result = await handleDirectoryCli("directory", [], {}, undefined, store);
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes("no agents"), "should say no agents");
  });
  await fs.rm(store.home, { recursive: true });
});

test("directory unreachable host message", async () => {
  const store = await tmpStore();
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const result = await handleDirectoryCli("directory", [], {}, undefined, store);
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes("could not reach"), "should say could not reach");
  });
  await fs.rm(store.home, { recursive: true });
});

test("directory --limit is forwarded to fetch URL", async () => {
  const store = await tmpStore();
  let capturedUrl = "";
  await withFetch(async (url) => {
    capturedUrl = String(url);
    return { ok: true, json: async () => mockDir } as unknown as Response;
  }, async () => {
    await handleDirectoryCli("directory", ["--limit", "25"], {}, undefined, store);
    assert.ok(capturedUrl.includes("limit=25"), `URL should include limit=25, got: ${capturedUrl}`);
  });
  await fs.rm(store.home, { recursive: true });
});

test("directory --relay-base overrides default", async () => {
  const store = await tmpStore();
  let capturedUrl = "";
  await withFetch(async (url) => {
    capturedUrl = String(url);
    return { ok: true, json: async () => mockDir } as unknown as Response;
  }, async () => {
    await handleDirectoryCli("directory", ["--relay-base", "http://custom-relay.test"], {}, undefined, store);
    assert.ok(capturedUrl.startsWith("http://custom-relay.test/"), `URL should use custom relay, got: ${capturedUrl}`);
  });
  await fs.rm(store.home, { recursive: true });
});
