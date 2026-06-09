import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeRegistryProvider } from "../src/resolver.ts";

test("registry provider resolves handle -> card url -> verified card", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-reg-"));
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await bob.init({ handle: "bob.openclaw.local" });
  await alice.init({ handle: "alice.openclaw.local" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  const provider = makeRegistryProvider(async (handle) => (handle === "registry:bob" ? invite : null));

  const result = await provider.resolve(alice, "registry:bob");
  assert.equal(result?.card?.agent_id, bobCard.agent_id);
  assert.equal(result?.provenance.source, "registry");
});

test("registry provider returns null for a non-registry target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-reg2-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local" });
  const provider = makeRegistryProvider(async () => null);
  assert.equal(await provider.resolve(alice, "https://x/card"), null);
});
