import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookError, EdgeBookStore } from "../src/edge-book.ts";

// ea-openclaw-031 Pass 1 — friend-graph grant hardening.
// Spec ea-openclaw-030 access check #6: a grant must have a verifiable issuer
// signature to authorize friend-gated access. Grants are signed on issue but
// were never verified on use; a tampered grant (mutated after signing, so its
// stored signature no longer matches its payload) must fail closed.

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-grant-"));
}

async function befriend(root: string) {
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  return { alice, bob, aliceCard, bobCard };
}

test("message send is denied when the peer-issued grant was tampered after signing", async () => {
  const root = await tempRoot();
  const { alice, bobCard } = await befriend(root);

  // Tamper alice's stored copy of bob's message.friend grant without re-signing.
  const grants = await alice.grants();
  const id = Object.keys(grants).find((k) => grants[k].scopes.includes("message.friend"));
  assert.ok(id, "expected a message.friend grant from the handshake");
  grants[id].expires_at = "2999-01-01T00:00:00.000Z";
  await alice.saveGrants(grants);

  await assert.rejects(
    () => alice.sendPrivilegedMessage(bobCard.agent_id, { text: "forged" }),
    (error) => error instanceof EdgeBookError && error.code === "invalid_grant_signature"
  );
});

test("message send still works with an intact peer-issued grant", async () => {
  const root = await tempRoot();
  const { alice, bobCard } = await befriend(root);
  await assert.doesNotReject(() => alice.sendPrivilegedMessage(bobCard.agent_id, { text: "ok" }));
});

test("feed read is denied when the self-issued grant was tampered after signing", async () => {
  const root = await tempRoot();
  const { alice, bobCard } = await befriend(root);
  await alice.issueGrant(bobCard.agent_id, ["feed.read.friends"]);

  // Privilege-escalate the self-issued feed grant by adding a scope post-signing.
  const grants = await alice.grants();
  const id = Object.keys(grants).find(
    (k) => grants[k].issuer_agent_id !== bobCard.agent_id && grants[k].scopes.includes("feed.read.friends")
  );
  assert.ok(id, "expected a self-issued feed.read.friends grant");
  grants[id].scopes = [...grants[id].scopes, "message.friend"];
  await alice.saveGrants(grants);

  await assert.rejects(
    () => alice.visiblePostsForPeer(bobCard.agent_id),
    (error) => error instanceof EdgeBookError && error.code === "invalid_grant_signature"
  );
});

test("feed read still works with an intact self-issued grant", async () => {
  const root = await tempRoot();
  const { alice, bobCard } = await befriend(root);
  await alice.issueGrant(bobCard.agent_id, ["feed.read.friends"]);
  await assert.doesNotReject(() => alice.visiblePostsForPeer(bobCard.agent_id));
});
