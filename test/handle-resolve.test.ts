import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";
import { resolveTarget, makeRegistryProvider } from "../src/resolver.ts";

async function initStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-res-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Owner" });
  await s.setHandle("antony-evans");
  return s;
}

test("friend antony-evans resolves a relay-served card", async () => {
  const s = await initStore();
  const card = await s.writeCard();
  const srv = http.createServer((req, res) => {
    if (req.url === "/handle/antony-evans") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(card)); }
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const provider = makeRegistryProvider(async (t) => {
    const h = t.startsWith("registry:") ? t.slice("registry:".length) : t;
    return `${base}/handle/${h}`;
  });
  const out = await resolveTarget(s, "antony-evans", { providers: [provider] });
  assert.equal(out.status, "resolved");
  assert.equal(out.agent_id, card.agent_id);
  const miss = await resolveTarget(s, "ghost", { providers: [provider] });
  assert.equal(miss.status, "not_found");
  await new Promise<void>((r) => srv.close(() => r()));
});

test("a relay-served card with a forged signature surfaces loudly (not silently not_found)", async () => {
  const s = await initStore();
  const card = await s.writeCard();
  // Corrupt the signature to a wrong-but-valid base64url value → signature
  // verification fails → validateCard throws invalid_card (NOT card_fetch_failed).
  const forged = { ...card, signature: Buffer.from("not-the-real-signature").toString("base64url") };
  const srv = http.createServer((req, res) => {
    if (req.url === "/handle/forged") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(forged)); }
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const provider = makeRegistryProvider(async (t) => {
    const h = t.startsWith("registry:") ? t.slice("registry:".length) : t;
    return `${base}/handle/${h}`;
  });
  // A forged served card must NOT be silently downgraded to not_found — it must throw.
  await assert.rejects(
    () => resolveTarget(s, "forged", { providers: [provider] }),
    (err: unknown) =>
      err instanceof EdgeBookError && /invalid_card|card_expired/.test(err.code),
  );
  await new Promise<void>((r) => srv.close(() => r()));
});
