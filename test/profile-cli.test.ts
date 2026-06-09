import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore } from "../src/edge-book.ts";

async function home(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-cli-"));
}

test("profile set --bio --social and visibility round-trips via show", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h }); // init --name = agent display_name (unchanged)
  await handleCli(["profile", "set", "--name", "Alice", "--bio", "Builder", "--social", "telegram=@alice"], { home: h }); // profile set --name = human name
  await handleCli(["profile", "visibility", "bio=off", "telegram=public"], { home: h });
  const res = await handleCli(["profile", "show"], { home: h });
  const j = res.json as any;
  assert.equal(j.display_name, "Agent A");
  assert.equal(j.name, "Alice");
  assert.equal(j.visibility.bio, "off");
  assert.equal(j.visibility.telegram, "public");
  assert.deepEqual(j.socials, [{ label: "telegram", value: "@alice" }]);
});

// ─── M2: bare profile set must be rejected ───────────────────────────────────

test("bare 'profile set' with no flags throws missing_arg", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h });
  await assert.rejects(
    () => handleCli(["profile", "set"], { home: h }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "missing_arg");
      return true;
    },
  );
});

// ─── M1: profile visibility must reject unknown/typo'd keys ─────────────────

test("profile visibility rejects a typo'd key not in known fields or socials", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h });
  // Set a real social so we can confirm only that label would be accepted.
  await handleCli(["profile", "set", "--name", "Alice", "--social", "telegram=@alice"], { home: h });
  await assert.rejects(
    () => handleCli(["profile", "visibility", "boi=off"], { home: h }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "unknown_visibility_field");
      assert.match(err.message, /boi/);
      return true;
    },
  );
});

test("profile visibility accepts '*' wildcard key", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h });
  await handleCli(["profile", "set", "--name", "Alice", "--social", "telegram=@alice"], { home: h });
  // Should not throw.
  await assert.doesNotReject(() => handleCli(["profile", "visibility", "*=public"], { home: h }));
});

test("profile visibility accepts a set social label", async () => {
  const h = await home();
  await handleCli(["init", "--name", "Agent A"], { home: h });
  await handleCli(["profile", "set", "--name", "Alice", "--social", "twitter=alice"], { home: h });
  // 'twitter' is a current social label — should be accepted.
  await assert.doesNotReject(() => handleCli(["profile", "visibility", "twitter=off"], { home: h }));
});

test("friend apply-response prints a deliverable profile_share envelope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-ar-"));
  const aliceHome = path.join(root, "alice");
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await handleCli(["init", "--name", "Alice Agent"], { home: aliceHome });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  await handleCli(["profile", "set", "--name", "Alice"], { home: aliceHome });
  await bob.setProfile({ name: "Bob" });

  const alice = new EdgeBookStore({ home: aliceHome });
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  const request = await alice.createFriendRequest(bobCard);
  await bob.receiveFriendRequest(request);
  const accept = await bob.acceptFriend(aliceCard.agent_id);
  const acceptPath = path.join(root, "accept.json");
  await fs.writeFile(acceptPath, JSON.stringify(accept), "utf8");

  const res = await handleCli(["friend", "apply-response", acceptPath], { home: aliceHome });
  const j = res.json as any;
  assert.equal(j.type, "profile_share");
  assert.equal(j.to_agent_id, bobCard.agent_id);
});
