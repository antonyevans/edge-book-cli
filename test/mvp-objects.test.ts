import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookError, EdgeBookStore } from "../src/edge-book.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-mvp-objects-"));
}

// Alice + Bob friended; Carol initialized but NOT friended/granted.
async function makeParties(root: string) {
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const carol = new EdgeBookStore({ home: path.join(root, "carol") });
  const aliceId = (await alice.init({ handle: "alice.local", ownerLabel: "Alice" })).agent_id;
  const bobId = (await bob.init({ handle: "bob.local", ownerLabel: "Bob" })).agent_id;
  const carolId = (await carol.init({ handle: "carol.local", ownerLabel: "Carol" })).agent_id;
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  return { alice, bob, carol, aliceId, bobId, carolId };
}

test("object share over envelope: Bob reads only with an active grant; revoke denies; Carol never sees it", async () => {
  const root = await tempRoot();
  const { alice, bob, carol, bobId, carolId } = await makeParties(root);

  // Alice creates one shared object (request + one attachment).
  const object = await alice.createObject({
    title: "Review the venue contract",
    body: "Two liability clauses need a second pair of eyes before Friday.",
    attachment: { filename: "contract.pdf", mime: "application/pdf", bytes: Buffer.from("PDF-BYTES") }
  });
  assert.equal(object.type, "request");
  assert.equal(object.attachment?.filename, "contract.pdf");
  // R4: no status/state/verification field on the object.
  for (const banned of ["status", "state", "delivered", "verified", "paid"]) {
    assert.ok(!(banned in object), `object must not carry '${banned}' (R4)`);
  }

  // Nothing shared by default — before any grant, nobody but Alice can read.
  assert.equal(await alice.canReadObject(object.object_id, bobId), false, "no grant yet → Bob cannot read");

  // Alice shares to Bob: deliver the signed object_share envelope (mailbox blob).
  const shareEnv = await alice.shareObjectEnvelope(bobId, object.object_id);
  assert.equal(shareEnv.type, "object_share");
  await bob.receiveObjectShare(shareEnv);

  // Bob can now read (fail-closed canRead passes) and the open is audited.
  assert.equal(await bob.canReadObject(object.object_id, bobId), true);
  const readByBob = await bob.readObject(object.object_id, bobId);
  assert.equal(readByBob.request.title, object.request.title);
  assert.equal(readByBob.attachment?.size, object.attachment?.size, "attachment delivered");
  assert.deepEqual((await bob.sharedObjectsFor()).map((o) => o.object_id), [object.object_id]);

  // Carol was never granted and never received it: fail-closed denial.
  assert.equal(await carol.canReadObject(object.object_id, carolId), false);
  assert.equal((await carol.objects())[object.object_id], undefined, "Carol never received the object");
  assert.equal((await carol.sharedObjectsFor()).length, 0);

  // Alice revokes; forward the revoke to Bob. After that Bob is denied.
  const revokeEnv = await alice.revokeObjectEnvelope(bobId, object.object_id);
  assert.equal(await alice.canReadObject(object.object_id, bobId), false, "Alice's grant now revoked");
  await bob.receiveObjectRevoke(revokeEnv);
  assert.equal(await bob.canReadObject(object.object_id, bobId), false, "Bob denied after revoke (forward-looking)");
  await assert.rejects(() => bob.readObject(object.object_id, bobId), (e) => e instanceof EdgeBookError && e.code === "access_denied");

  // Full audit chain present on both sides.
  const aliceActions = (await alice.auditEvents()).map((e) => e.action);
  assert.ok(aliceActions.includes("object.create"));
  assert.ok(aliceActions.includes("grant.issue"));
  assert.ok(aliceActions.includes("grant.revoke"));
  const bobActions = (await bob.auditEvents()).map((e) => e.action);
  assert.ok(bobActions.includes("object.receive"));
  assert.ok(bobActions.includes("object.access"));
});

test("one grant binds exactly one object; a grant for object A does not unlock object B", async () => {
  const root = await tempRoot();
  const { alice, bob, bobId } = await makeParties(root);
  const a = await alice.createObject({ title: "A", body: "first" });
  const b = await alice.createObject({ title: "B", body: "second" });
  await bob.receiveObjectShare(await alice.shareObjectEnvelope(bobId, a.object_id));
  assert.equal(await bob.canReadObject(a.object_id, bobId), true);
  assert.equal(await bob.canReadObject(b.object_id, bobId), false, "grant for A must not unlock B");
});

test("issuing an object grant requires the object to exist (fail-closed)", async () => {
  const root = await tempRoot();
  const { alice, bobId } = await makeParties(root);
  await assert.rejects(() => alice.issueObjectGrant(bobId, "obj_missing"), (e) => e instanceof EdgeBookError && e.code === "unknown_object");
});
