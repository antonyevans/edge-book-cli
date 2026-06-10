import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";
import { resolveTarget, makeRegistryProvider } from "../src/resolver.ts";

test("an expired relay-served card fails discovery loudly, never resolves", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-expiry-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Owner" });
  await s.setHandle("antony-evans");
  const card = await s.writeCard();

  // Serve the card with a past expiry. Mutating expires_at also breaks the
  // signature, so validateCard could reject via card_expired OR invalid_card.
  // In practice card_expired fires: validateCard checks expiry (lines 13-18 of
  // cards.ts) BEFORE signature verification (line 22), so the expiry rejection
  // wins. Either way discovery fails closed, which is the invariant under test.
  const expired = { ...card, expires_at: "2020-01-01T00:00:00.000Z" };
  const srv = http.createServer((req, res) => {
    if (req.url === "/handle/antony-evans") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(expired));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const provider = makeRegistryProvider(async (t) => {
    const h = t.startsWith("registry:") ? t.slice("registry:".length) : t;
    return `${base}/handle/${h}`;
  });

  await assert.rejects(
    () => resolveTarget(s, "antony-evans", { providers: [provider] }),
    (err: unknown) =>
      err instanceof EdgeBookError && /card_expired|invalid_card/.test(err.code),
  );
  await new Promise<void>((r) => srv.close(() => r()));
});
