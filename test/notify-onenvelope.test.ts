import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { EdgeBookStore } from "../src/edge-book.ts";
import { makeNotifyOnEnvelope } from "../src/notify.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-onenv-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob, root };
}

test("makeNotifyOnEnvelope fires the notify hook only for applied envelopes", async () => {
  const { alice, bob, root } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  const out = path.join(root, "hook.txt");
  const handler = makeNotifyOnEnvelope(bob, `cat >> ${JSON.stringify(out)}`);

  await handler(env, { applied: false });
  assert.equal(existsSync(out), false, "un-applied envelope must not notify");

  await handler(env, { applied: true });
  assert.match(await fs.readFile(out, "utf8"), /wants to connect/, "applied envelope notifies via the hook");
});

test("makeNotifyOnEnvelope with no command is a no-op (never throws)", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  const env = await alice.createFriendRequest(bobCard, "hi");
  await bob.receiveFriendRequest(env);
  const handler = makeNotifyOnEnvelope(bob, undefined);
  await handler(env, { applied: true }); // must not throw
  assert.ok(true);
});
