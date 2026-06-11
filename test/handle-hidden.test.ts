import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";

async function tmpStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-hidden-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Test Agent" });
  return s;
}

test("slugifyHandle strips leading @ explicitly", async () => {
  const { slugifyHandle } = await import("../src/edge-book.ts");
  assert.equal(slugifyHandle("@antony-evans"), "antony-evans");
  assert.equal(slugifyHandle("@ALICE-SMITH"), "alice-smith");
  assert.equal(slugifyHandle("  @bob  "), "bob");
});

test("isValidHandle rejects 'directory'", async () => {
  const { isValidHandle } = await import("../src/edge-book.ts");
  assert.equal(isValidHandle("directory"), false);
});

test("handle set --hidden persists handle_discoverable: false", async () => {
  const store = await tmpStore();
  await store.setHandle("my-hidden-handle", { discoverable: false });
  const identity = await store.identity();
  assert.equal(identity.handle, "my-hidden-handle");
  assert.equal(identity.handle_discoverable, false);
  await fs.rm(store.home, { recursive: true });
});

test("handle set without hidden resets handle_discoverable", async () => {
  const store = await tmpStore();
  // First set hidden
  await store.setHandle("hidden-first", { discoverable: false });
  // Then reset to visible
  await store.setHandle("now-visible", { discoverable: undefined });
  const identity = await store.identity();
  assert.equal(identity.handle, "now-visible");
  assert.equal(identity.handle_discoverable, undefined);
  await fs.rm(store.home, { recursive: true });
});

test("buildHandleClaim includes discoverable: true by default", async () => {
  const store = await tmpStore();
  await store.setHandle("test-handle");
  const claim = await store.buildHandleClaim();
  assert.equal(claim.discoverable, true, "discoverable should default to true");
  await fs.rm(store.home, { recursive: true });
});

test("buildHandleClaim includes discoverable: false when handle_discoverable is false", async () => {
  const store = await tmpStore();
  await store.setHandle("hidden-test", { discoverable: false });
  const claim = await store.buildHandleClaim();
  assert.equal(claim.discoverable, false, "discoverable should be false when set");
  await fs.rm(store.home, { recursive: true });
});
