import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCard, runFeedPrivacyHarness, runTwoAgentHarness, EdgeBookError, EdgeBookStore, validateCard } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { startEdgeBookServer } from "../src/http.ts";
import { startRelayServer } from "../src/http-relay.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-test-"));
}

function serverBaseUrl(server: { address(): unknown }): string {
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("init creates a signed valid Agent Card", async () => {
  const root = await tempRoot();
  const store = new EdgeBookStore({ home: root });
  const identity = await store.init({ handle: "test.openclaw.local", displayName: "Test Agent" });
  const card = await store.writeCard();

  assert.equal(card.agent_id, identity.agent_id);
  assert.equal(card.handle, "test.openclaw.local");
  assert.doesNotThrow(() => validateCard(card));
});

test("friend request and accept establish durable contacts and grant message.friend", async () => {
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();

  const request = await alice.createFriendRequest(bobCard);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  await alice.applyFriendResponse(accept);

  const aliceContacts = await alice.contacts();
  const bobContacts = await bob.contacts();
  assert.equal(aliceContacts[bobCard.agent_id].relationship_state, "friend");
  assert.equal(bobContacts[aliceCard.agent_id].relationship_state, "friend");
  assert.ok(await alice.findUsableGrant(bobCard.agent_id, "message.friend"));
});

test("privileged message is denied before friendship and allowed after grant", async () => {
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);

  await assert.rejects(
    () => alice.sendPrivilegedMessage(bobCard.agent_id, { text: "too soon" }),
    (error) => error instanceof EdgeBookError && error.code === "not_friend"
  );

  await bob.receiveFriendRequest(request);
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const envelope = await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "allowed" });
  await assert.doesNotReject(() => bob.receivePrivilegedMessage(envelope));
});

test("replay is rejected", async () => {
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await alice.applyFriendResponse(await bob.acceptFriend(aliceCard.agent_id));
  const envelope = await alice.sendPrivilegedMessage(bobCard.agent_id, { text: "once" });
  await bob.receivePrivilegedMessage(envelope);

  await assert.rejects(
    () => bob.receivePrivilegedMessage(envelope),
    (error) => error instanceof EdgeBookError && error.code === "replay"
  );
});

test("Agent Card refresh rejects key mismatch", async () => {
  const root = await tempRoot();
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  const mallory = new EdgeBookStore({ home: path.join(root, "mallory") });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });
  await mallory.init({ handle: "mallory.openclaw.local" });
  const bobCard = await bob.writeCard();
  const malloryCard = await mallory.writeCard();
  await alice.upsertContactFromCard(bobCard);

  const forged = { ...malloryCard, agent_id: bobCard.agent_id };
  await assert.rejects(
    () => alice.upsertContactFromCard(forged),
    (error) => error instanceof EdgeBookError && error.code === "invalid_card"
  );
});

test("CLI can initialize and export a loadable card", async () => {
  const root = await tempRoot();
  const cardPath = path.join(root, "card.json");
  await handleCli(["init", "--home", root, "--handle", "cli-agent"]);
  await handleCli(["card", "export", "--home", root, "--path", cardPath]);
  const card = await loadCard(cardPath);
  assert.equal(card.handle, "cli-agent");
});

test("doctor reports initialized store, valid card, and private identity mode", async () => {
  const root = await tempRoot();
  await handleCli(["init", "--home", root, "--handle", "doctor.openclaw.local"]);
  const result = await handleCli(["doctor", "--home", root]);
  const report = result.json as Record<string, unknown>;
  assert.equal(report.pass, true);
  assert.equal(report.card_valid, true);
  if (process.platform !== "win32") {
    assert.equal(report.private_key_mode_ok, true);
    const stat = await fs.stat(path.join(root, "identity.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test("CLI can execute file-based friend and message exchange", async () => {
  const root = await tempRoot();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const aliceCardPath = path.join(root, "alice-card.json");
  const bobCardPath = path.join(root, "bob-card.json");
  const requestPath = path.join(root, "request.json");
  const acceptPath = path.join(root, "accept.json");
  const messagePath = path.join(root, "message.json");

  await handleCli(["init", "--home", aliceHome, "--handle", "alice.openclaw.local"]);
  await handleCli(["init", "--home", bobHome, "--handle", "bob.openclaw.local"]);
  await handleCli(["card", "export", "--home", aliceHome, "--path", aliceCardPath]);
  await handleCli(["card", "export", "--home", bobHome, "--path", bobCardPath]);
  const aliceCard = await loadCard(aliceCardPath);
  const bobCard = await loadCard(bobCardPath);

  const request = await handleCli(["friend", "request", "--home", aliceHome, bobCardPath]);
  await fs.writeFile(requestPath, `${JSON.stringify(request.json, null, 2)}\n`, "utf8");
  await handleCli(["friend", "receive", "--home", bobHome, requestPath]);
  const accept = await handleCli(["friend", "accept", "--home", bobHome, aliceCard.agent_id]);
  await fs.writeFile(acceptPath, `${JSON.stringify(accept.json, null, 2)}\n`, "utf8");
  await handleCli(["friend", "apply-response", "--home", aliceHome, acceptPath]);
  const sent = await handleCli(["message", "send", "--home", aliceHome, bobCard.agent_id, "--body", "hello"]);
  await fs.writeFile(messagePath, `${JSON.stringify(sent.json, null, 2)}\n`, "utf8");
  await handleCli(["message", "receive", "--home", bobHome, messagePath]);

  const bobInbox = await new EdgeBookStore({ home: bobHome }).inbox();
  assert.equal(bobInbox.at(-1)?.type, "privileged_message");
});

test("direct HTTP transport delivers request, accept, and privileged message", async () => {
  const root = await tempRoot();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: aliceHome });
  const bob = new EdgeBookStore({ home: bobHome });
  await alice.init({ handle: "alice.openclaw.local" });
  await bob.init({ handle: "bob.openclaw.local" });

  const aliceServer = await startEdgeBookServer({ home: aliceHome, host: "127.0.0.1", port: 0 });
  const bobServer = await startEdgeBookServer({ home: bobHome, host: "127.0.0.1", port: 0 });
  try {
    const aliceBase = serverBaseUrl(aliceServer);
    const bobBase = serverBaseUrl(bobServer);
    await alice.updateConfig({ direct_url: `${aliceBase}/edge-book/envelopes` });
    await bob.updateConfig({ direct_url: `${bobBase}/edge-book/envelopes` });
    const bobCardPath = path.join(root, "bob-card.json");
    const bobCard = await bob.writeCard(`${bobBase}/edge-book/card`);
    await fs.writeFile(bobCardPath, `${JSON.stringify(bobCard, null, 2)}\n`, "utf8");

    await handleCli(["friend", "request", "--home", aliceHome, bobCardPath, "--deliver"]);
    const aliceCard = await alice.writeCard(`${aliceBase}/edge-book/card`);
    await handleCli(["friend", "accept", "--home", bobHome, aliceCard.agent_id, "--deliver"]);
    await handleCli(["message", "send", "--home", aliceHome, bobCard.agent_id, "--body", "hello over http", "--deliver"]);

    const bobInbox = await bob.inbox();
    assert.equal(bobInbox.at(-1)?.type, "privileged_message");
    assert.equal((bobInbox.at(-1)?.body as { text?: string }).text, "hello over http");
  } finally {
    await closeServer(aliceServer);
    await closeServer(bobServer);
  }
});

test("relay transport queues and pulls friend request and response", async () => {
  const root = await tempRoot();
  const relayServer = await startRelayServer({ host: "127.0.0.1", port: 0, store: path.join(root, "relay") });
  try {
    const relayBase = serverBaseUrl(relayServer);
    const aliceHome = path.join(root, "alice");
    const bobHome = path.join(root, "bob");
    const alice = new EdgeBookStore({ home: aliceHome });
    const bob = new EdgeBookStore({ home: bobHome });
    await alice.init({ handle: "alice.openclaw.local", relayUrl: relayBase });
    await bob.init({ handle: "bob.openclaw.local", relayUrl: relayBase });
    const aliceCard = await alice.writeCard();
    const bobCard = await bob.writeCard();
    const bobCardPath = path.join(root, "bob-card.json");
    await fs.writeFile(bobCardPath, `${JSON.stringify(bobCard, null, 2)}\n`, "utf8");

    await handleCli(["friend", "request", "--home", aliceHome, bobCardPath, "--deliver"]);
    await handleCli(["inbox", "pull", "--home", bobHome, "--relay", relayBase]);
    assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "request_received");

    await handleCli(["friend", "accept", "--home", bobHome, aliceCard.agent_id, "--deliver"]);
    await handleCli(["inbox", "pull", "--home", aliceHome, "--relay", relayBase]);
    assert.equal((await alice.contacts())[bobCard.agent_id].relationship_state, "friend");
  } finally {
    await closeServer(relayServer);
  }
});

test("two-agent harness passes", async () => {
  const result = await runTwoAgentHarness(await tempRoot());
  assert.equal(result.passed, true);
});

test("feed privacy harness allows friend and denies non-friend revoked and blocked peers", async () => {
  const result = await runFeedPrivacyHarness(await tempRoot());
  assert.equal(result.passed, true);
  assert.deepEqual(result.assertions, {
    friendAllowed: true,
    nonFriendDenied: true,
    revokedFeedDenied: true,
    blockedFeedDenied: true,
    blockedMessageDenied: true,
    blockedRequestDenied: true,
    blockedRefreshDenied: true
  });
  assert.deepEqual(result.denial_codes, {
    nonFriend: "not_friend",
    revokedFeed: "not_friend",
    blockedFeed: "blocked",
    blockedMessage: "blocked",
    blockedRequest: "blocked_peer",
    blockedRefresh: "blocked_peer"
  });
});

test("owner_label sharing is opt-in: off by default, rides the card when enabled, and lands in the contact", async () => {
  // Owner (Alice) sets her human name but does NOT share it by default.
  const aliceRoot = await tempRoot();
  const alice = new EdgeBookStore({ home: aliceRoot });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await alice.setProfile({ ownerLabel: "Alice Human" });

  const privateCard = await alice.writeCard();
  assert.equal(privateCard.owner_label, undefined, "owner_label must NOT be on the card by default");
  validateCard(privateCard); // signature still valid

  // Opt in -> owner_label now rides the (still valid) signed card.
  await alice.setProfile({ shareOwnerLabel: true });
  const sharedCard = await alice.writeCard();
  assert.equal(sharedCard.owner_label, "Alice Human");
  validateCard(sharedCard);

  // A contact (Bob) who imports the shared card stores the human name.
  const bobRoot = await tempRoot();
  const bob = new EdgeBookStore({ home: bobRoot });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  const contact = await bob.upsertContactFromCard(sharedCard, "friend");
  assert.equal(contact.owner_label, "Alice Human");
  assert.equal(contact.display_name, "Alice Agent");

  // Turning sharing back off drops it from the card and from a refreshed contact.
  await alice.setProfile({ shareOwnerLabel: false });
  const reCard = await alice.writeCard();
  assert.equal(reCard.owner_label, undefined);
  const reContact = await bob.upsertContactFromCard(reCard, "friend");
  assert.equal(reContact.owner_label, undefined);
});
