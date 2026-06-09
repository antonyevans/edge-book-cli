import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";
import { startEdgeBookServer } from "../src/http.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-api-fr-"));
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

// Target Alice's invite string, the way GET /api/invite emits it.
async function aliceInvite(root: string): Promise<{ invite: string; aliceId: string }> {
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.local", ownerLabel: "Alice" });
  const card = await alice.writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(card), "utf8").toString("base64url")}`;
  return { invite, aliceId: card.agent_id };
}

test("POST /api/friend/request creates a friend_request from an invite and returns response_envelope", async () => {
  const root = await tempRoot();
  const { invite, aliceId } = await aliceInvite(root);
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob" });

  const server = await startEdgeBookServer({ home: bob.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const res = await fetch(`${baseUrl}/api/friend/request`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ invite }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { response_envelope: MessageEnvelope | null; contact: { relationship_state: string } };
    assert.ok(body.response_envelope, "returns the friend_request envelope for the host to relay");
    assert.equal(body.response_envelope!.type, "friend_request");
    assert.equal(body.response_envelope!.to_agent_id, aliceId);
    assert.equal(body.contact.relationship_state, "request_sent");
    assert.equal((await bob.contacts())[aliceId].relationship_state, "request_sent");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/friend/request is idempotent — already-friends does not re-request", async () => {
  const root = await tempRoot();
  const { invite, aliceId } = await aliceInvite(root);
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob" });
  const aliceCard = JSON.parse(Buffer.from(invite.slice("edgebook:invite:".length), "base64url").toString("utf8"));
  await bob.upsertContactFromCard(aliceCard, "friend");

  const server = await startEdgeBookServer({ home: bob.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const headers = await login(baseUrl);
    const res = await fetch(`${baseUrl}/api/friend/request`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ invite }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { response_envelope: MessageEnvelope | null; contact: { relationship_state: string } };
    assert.equal(body.response_envelope, null, "no new request when already friends");
    assert.equal(body.contact.relationship_state, "friend");
    assert.equal((await bob.contacts())[aliceId].relationship_state, "friend");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/friend/request rejects a malformed invite (400) and requires auth (401)", async () => {
  const root = await tempRoot();
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await bob.init({ handle: "bob.local", ownerLabel: "Bob" });
  const server = await startEdgeBookServer({ home: bob.home, host: "127.0.0.1", port: 0 });
  const baseUrl = baseUrlOf(server);
  try {
    const noAuth = await fetch(`${baseUrl}/api/friend/request`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: "edgebook:invite:zzz" }),
    });
    assert.equal(noAuth.status, 401);

    const headers = await login(baseUrl);
    const bad = await fetch(`${baseUrl}/api/friend/request`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ invite: "not-an-invite" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await closeServer(server);
  }
});
