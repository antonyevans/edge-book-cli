import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeRegistryProvider, defaultProviders, DEFAULT_RELAY_BASE, resolveTarget } from "../src/resolver.ts";

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

test("registry provider normalizes mixed-case handle before slug check", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-norm-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "antony-evans" });
  const bobCard = await bob.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;

  let capturedSlug = "";
  const provider = makeRegistryProvider(async (slug) => {
    capturedSlug = slug;
    return slug === "antony-evans" ? invite : null;
  });

  // "Antony-evans" (capital A) should normalize to "antony-evans"
  const result = await provider.resolve(alice, "Antony-evans");
  assert.equal(capturedSlug, "antony-evans");
  assert.ok(result?.card?.agent_id === bobCard.agent_id);

  // "@Antony-Evans" should normalize to "antony-evans"
  capturedSlug = "";
  const result2 = await provider.resolve(alice, "@Antony-Evans");
  assert.equal(capturedSlug, "antony-evans");
  assert.ok(result2?.card?.agent_id === bobCard.agent_id);
});

test("defaultProviders without relay base uses DEFAULT_RELAY_BASE for registry lookups", async () => {
  assert.equal(DEFAULT_RELAY_BASE, "https://edge-book-host.fly.dev");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-resolver-default-relay-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "antony-evans" });
  const bobCard = await bob.writeCard();

  const originalFetch = globalThis.fetch;
  let fetchedUrl = "";
  globalThis.fetch = async (url: string | URL | Request) => {
    fetchedUrl = url.toString();
    if (fetchedUrl.includes("/handle/antony-evans")) {
      return new Response(JSON.stringify(bobCard), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const providers = defaultProviders(); // no relay base arg
    const result = await resolveTarget(alice, "antony-evans", { providers });
    assert.match(fetchedUrl, /https:\/\/edge-book-host\.fly\.dev\/handle\/antony-evans/);
    assert.equal(result.status, "resolved");
    assert.equal(result.agent_id, bobCard.agent_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
