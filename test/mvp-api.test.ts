import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-mvp-api-"));
}
function baseUrlOf(server: { address(): unknown }): string {
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: { close(cb: (e?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
}
async function login(baseUrl: string): Promise<Record<string, string>> {
  const r = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth_method: "dev-bypass" }) });
  const b = await r.json() as { session_id: string; csrf_token: string };
  return { "x-openclaw-session": b.session_id, "x-openclaw-csrf": b.csrf_token };
}

// Build Alice (owner) + Bob friended, then Alice shares one object to Bob; the
// test drives BOB's local API (the reader for Bob's agent).
async function setup(root: string) {
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.local", ownerLabel: "Alice" });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const bobId = (await bob.identity()).agent_id;
  const object = await alice.createObject({
    title: "Review the venue contract",
    body: "Two clauses need eyes.",
    attachment: { filename: "contract.pdf", mime: "application/pdf", bytes: Buffer.from("HELLO-PDF") }
  });
  await bob.receiveObjectShare(await alice.shareObjectEnvelope(bobId, object.object_id));
  return { alice, bob, object };
}

test("GET /api/shared-objects returns grant-gated objects; /attachment serves the file", async () => {
  const root = await tempRoot();
  const { bob, object } = await setup(root);
  const server = await startEdgeBookServer({ home: bob.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const listed = await fetch(`${baseUrl}/api/shared-objects`, { headers }).then((r) => r.json()) as { objects: Array<Record<string, unknown>> };
    assert.equal(listed.objects.length, 1, "Bob sees the one shared object");
    assert.equal(listed.objects[0].object_id, object.object_id);
    assert.equal(listed.objects[0].grant_scope, "object.read");
    // R4: no status/state/verification field leaks through the API.
    for (const banned of ["status", "state", "delivered", "verified", "paid"]) {
      assert.ok(!(banned in listed.objects[0]), `shared object must not expose '${banned}' (R4)`);
    }

    const att = await fetch(`${baseUrl}/api/shared-objects/${encodeURIComponent(object.object_id)}/attachment`, { headers });
    assert.equal(att.status, 200);
    assert.equal(att.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await att.arrayBuffer()).toString("utf8"), "HELLO-PDF");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/invite returns the owner's signed card + an importable invite link + deeplink", async () => {
  const root = await tempRoot();
  const { bob } = await setup(root);
  const server = await startEdgeBookServer({ home: bob.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const invite = await fetch(`${baseUrl}/api/invite`, { headers }).then((r) => r.json()) as Record<string, string>;
    assert.match(invite.invite_url, /^edgebook:invite:/);
    assert.ok(invite.agent_id.startsWith("did:openclaw:"));
    assert.ok(invite.card, "card present");
    // deeplink_url is the tappable /add URL (spec-095)
    assert.match(invite.deeplink_url, /\/add#i=/);
    // No PRIVATE key material leaks (the card legitimately carries the public key).
    assert.doesNotMatch(JSON.stringify(invite), /private_key|PRIVATE KEY/);
  } finally {
    await closeServer(server);
  }
});

test("a non-granted owner's reader shows no shared objects", async () => {
  const root = await tempRoot();
  // Carol is initialized but nobody shared anything with her.
  const carol = new EdgeBookStore({ home: path.join(root, "carol") });
  await carol.init({ handle: "carol.local", ownerLabel: "Carol" });
  const server = await startEdgeBookServer({ home: carol.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const listed = await fetch(`${baseUrl}/api/shared-objects`, { headers }).then((r) => r.json()) as { objects: unknown[] };
    assert.equal(listed.objects.length, 0);
  } finally {
    await closeServer(server);
  }
});
