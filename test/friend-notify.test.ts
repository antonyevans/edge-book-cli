import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("spec-139: pendingFriendRequests lists ALL request_received, even after mark-notified", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  let pending = await bob.pendingFriendRequests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].peer_agent_id, aliceCard.agent_id);
  assert.equal(pending[0].display_name, "Alice Agent");
  assert.equal(pending[0].notified_at, undefined, "not yet notified");
  await bob.markFriendRequestNotified(aliceCard.agent_id);
  pending = await bob.pendingFriendRequests();
  assert.equal(pending.length, 1, "notified request is STILL pending (awaiting accept/decline)");
  assert.ok(pending[0].notified_at, "notified_at is now set so callers can tell new from seen");
});

test("spec-139: unnotifiedFriendRequests (friend pending --new) drops marked entries", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  assert.equal((await bob.unnotifiedFriendRequests()).length, 1, "listed before mark-notified");
  await bob.markFriendRequestNotified(aliceCard.agent_id);
  assert.equal((await bob.unnotifiedFriendRequests()).length, 0, "empty after mark-notified");
  assert.equal((await bob.pendingFriendRequests()).length, 1, "plain pending still lists it");
});

test("spec-139: notify_on_friend_request:false suppresses only the --new surface", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.updateConfig({ notify_on_friend_request: false });
  assert.deepEqual(await bob.unnotifiedFriendRequests(), [], "notifier surface stays silent");
  assert.equal((await bob.pendingFriendRequests()).length, 1, "the request itself stays visible");
});

test("accepted/other states never appear as pending", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.markFriendRequestNotified(aliceCard.agent_id);
  await bob.acceptFriend(aliceCard.agent_id);
  assert.deepEqual(await bob.pendingFriendRequests(), [], "gone after accept, notified or not");
  assert.deepEqual(await bob.unnotifiedFriendRequests(), []);
});

test("re-sent friend request re-surfaces after notified_at was stamped", async () => {
  // Regression: stale notified_at must NOT permanently suppress a second request.
  // Lifecycle: Alice requests → Bob notified → Bob revokes → Alice re-requests →
  // Bob must see length 1 again.
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();

  // Step 1 — first request: Bob sees it on the notifier surface (length 1)
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  assert.equal((await bob.unnotifiedFriendRequests()).length, 1, "first request is un-notified");

  // Step 2 — Bob marks notified: off the notifier surface (length 0)
  await bob.markFriendRequestNotified(aliceCard.agent_id);
  assert.equal((await bob.unnotifiedFriendRequests()).length, 0, "marked as notified — not on the --new surface");

  // Step 3 — Bob revokes the relationship (simulates relationship returning to non-friend)
  await bob.revoke(aliceCard.agent_id);

  // Step 4 — Alice sends a fresh request (createFriendRequest produces a new message_id each call)
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));

  // Step 5 — The stale notified_at must be gone; Bob must be re-notified
  assert.equal((await bob.unnotifiedFriendRequests()).length, 1, "re-sent request re-surfaces after notified_at cleared");
});

import { handleCli } from "../src/cli.ts";

test("CLI friend pending --json surfaces real note and requested_at from inbox", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-note-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  const bobCard = await bob.writeCard();
  // Alice sends a friend request WITH a note (2nd arg to createFriendRequest)
  const envelope = await alice.createFriendRequest(bobCard, "lets connect");
  await bob.receiveFriendRequest(envelope);

  const result = await handleCli(["friend", "pending", "--json"], { home: bob.home });
  const j = result.json as any[];
  assert.equal(j.length, 1);
  assert.equal(j[0].note, "lets connect", "note should be surfaced from inbox envelope");
  assert.ok(j[0].requested_at, "requested_at should be non-empty");
  assert.ok(j[0].contact_created_at, "contact_created_at should be present");
  assert.equal(j[0].agent_id, (await alice.identity()).agent_id);
});

test("CLI friend pending --json surfaces the NEWEST note when a peer requests twice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-note2-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard, "first note"));
  // Ensure a strictly later created_at so "latest wins" is deterministic (ms-resolution timestamps).
  await new Promise((r) => setTimeout(r, 5));
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard, "second note"));

  const result = await handleCli(["friend", "pending", "--json"], { home: bob.home });
  const j = result.json as any[];
  assert.equal(j.length, 1, "still one pending contact");
  assert.equal(j[0].note, "second note", "the most recent request note wins");
});

test("spec-139 CLI: plain `friend pending` keeps listing after mark-notified, with notified_at in the JSON", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-cli-"));
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await handleCli(["init", "--name", "Bob Agent"], { home: bobHome });
  const bob = new EdgeBookStore({ home: bobHome });
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));

  const list = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  const j = list.json as any[];
  assert.equal(j.length, 1);
  assert.equal(j[0].agent_id, aliceCard.agent_id);
  assert.equal(j[0].notified_at, undefined, "not notified yet");

  await handleCli(["friend", "mark-notified", aliceCard.agent_id], { home: bobHome });
  const after = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  const a = after.json as any[];
  assert.equal(a.length, 1, "still pending until accept/decline");
  assert.ok(a[0].notified_at, "entry carries notified_at");

  // After accept it is gone from pending entirely.
  await bob.acceptFriend(aliceCard.agent_id);
  const accepted = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  assert.equal((accepted.json as any[]).length, 0);
});

test("spec-139 CLI: `friend pending --new` is the notifier surface (mark-notified dedups)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-cli-new-"));
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await handleCli(["init", "--name", "Bob Agent"], { home: bobHome });
  const bob = new EdgeBookStore({ home: bobHome });
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));

  const fresh = await handleCli(["friend", "pending", "--new", "--json"], { home: bobHome });
  assert.equal((fresh.json as any[]).length, 1, "listed before mark-notified");

  await handleCli(["friend", "mark-notified", aliceCard.agent_id], { home: bobHome });
  assert.equal(((await handleCli(["friend", "pending", "--new", "--json"], { home: bobHome })).json as any[]).length, 0, "empty after mark-notified");
  assert.equal(((await handleCli(["friend", "pending", "--json"], { home: bobHome })).json as any[]).length, 1, "plain pending unaffected");
});

test("spec-139 CLI: notify_on_friend_request=false → --new returns [], plain pending still lists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-cli-off-"));
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await handleCli(["init", "--name", "Bob Agent"], { home: bobHome });
  const bob = new EdgeBookStore({ home: bobHome });
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  await bob.updateConfig({ notify_on_friend_request: false });

  assert.deepEqual((await handleCli(["friend", "pending", "--new", "--json"], { home: bobHome })).json, []);
  assert.equal(((await handleCli(["friend", "pending", "--json"], { home: bobHome })).json as any[]).length, 1);
});
