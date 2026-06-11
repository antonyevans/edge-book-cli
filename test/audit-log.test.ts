import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";

const SECRET_BODY = "SECRET-AUDIT-BODY-MARKER-7791";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-audit-log-"));
}

async function initializedPair(root: string): Promise<{ alice: EdgeBookStore; bob: EdgeBookStore; aliceId: string; bobId: string }> {
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const aliceId = (await alice.init({ handle: "alice.openclaw.local" })).agent_id;
  const bobId = (await bob.init({ handle: "bob.openclaw.local" })).agent_id;
  return { alice, bob, aliceId, bobId };
}

async function friendedPair(): Promise<{ alice: EdgeBookStore; bob: EdgeBookStore; aliceId: string; bobId: string }> {
  const pair = await initializedPair(await tempRoot());
  const aliceCard = await pair.alice.writeCard();
  const bobCard = await pair.bob.writeCard();
  await pair.bob.receiveFriendRequest(await pair.alice.createFriendRequest(bobCard));
  await pair.alice.applyFriendResponse(await pair.bob.acceptFriend(aliceCard.agent_id));
  return pair;
}

function assertSanitizedAudit(record: Record<string, unknown>, kind: string, actor: string, peer: string, objectId: string): void {
  assert.equal(record.kind, kind);
  assert.equal(record.action, kind);
  assert.equal(record.actor_agent_id, actor);
  assert.equal(record.peer_agent_id, peer);
  assert.equal(record.object_id, objectId);
  assert.equal(record.grant_scope, "object.read");
  assert.match(String(record.created_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!JSON.stringify(record).includes(SECRET_BODY), "audit record leaked object body");
}

test("grant created appends a sanitized audit.jsonl record", async () => {
  const { alice, bobId, aliceId } = await initializedPair(await tempRoot());
  const object = await alice.createObject({ title: "secret title", body: SECRET_BODY });
  await alice.issueObjectGrant(bobId, object.object_id);

  const record = (await alice.auditEvents()).find((event) => event.kind === "grant.issue" && event.object_id === object.object_id);
  assert.ok(record, "missing grant.issue audit record");
  assertSanitizedAudit(record, "grant.issue", aliceId, bobId, object.object_id);
  assert.equal(typeof record.grant_id, "string");
});

test("grant revoked appends a sanitized audit.jsonl record", async () => {
  const { alice, bobId, aliceId } = await friendedPair();
  const object = await alice.createObject({ title: "secret title", body: SECRET_BODY });
  await alice.shareObjectEnvelope(bobId, object.object_id);
  await alice.revokeObjectGrant(object.object_id, bobId);

  const record = (await alice.auditEvents()).find((event) => event.kind === "grant.revoke" && event.object_id === object.object_id);
  assert.ok(record, "missing grant.revoke audit record");
  assertSanitizedAudit(record, "grant.revoke", aliceId, bobId, object.object_id);
  assert.equal(typeof record.grant_ids, "string");
});

test("object shared appends a sanitized audit.jsonl record", async () => {
  const { alice, bobId, aliceId } = await friendedPair();
  const object = await alice.createObject({ title: "secret title", body: SECRET_BODY });
  await alice.shareObjectEnvelope(bobId, object.object_id);

  const record = (await alice.auditEvents()).find((event) => event.kind === "object.share" && event.object_id === object.object_id);
  assert.ok(record, "missing object.share audit record");
  assertSanitizedAudit(record, "object.share", aliceId, bobId, object.object_id);
  assert.equal(typeof record.grant_id, "string");
});

test("read denied appends a sanitized audit.jsonl record", async () => {
  const { alice, bobId, aliceId } = await initializedPair(await tempRoot());
  const object = await alice.createObject({ title: "secret title", body: SECRET_BODY });

  assert.equal(await alice.canReadObject(object.object_id, bobId), false);
  const record = (await alice.auditEvents()).find((event) => event.kind === "object.read.denied");
  assert.ok(record, "missing object.read.denied audit record");
  assertSanitizedAudit(record, "object.read.denied", aliceId, bobId, object.object_id);
});

test("audit append failures never throw into the caller", async () => {
  const root = await tempRoot();
  const bogusHome = path.join(root, "not-a-dir");
  await fs.writeFile(bogusHome, "not a directory", "utf8");
  const store = new EdgeBookStore({ home: bogusHome });
  await assert.doesNotReject(() => store.audit("grant.issue", "did:peer", { object_id: "obj_1", scope: "object.read" }));
});
