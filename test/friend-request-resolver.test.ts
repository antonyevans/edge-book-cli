// spec-138 — resolver-routed friend request targets.
// `friend request <target>` must route non-candidate, non-card-location targets
// through resolveTarget(), so the canonical `resolve <handle>` →
// `friend request <handle> --deliver` sequence works, and a non-resolvable
// target surfaces as an EdgeBookError (target_not_resolvable) — never a raw
// fs ENOENT.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { resolveFriendRequestCard } from "../src/cli-social.ts";
import { makeIndexProvider, writeCandidate } from "../src/resolver.ts";

async function pairHomes(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const bobHome = path.join(root, "bob");
  const aliceHome = path.join(root, "alice");
  await handleCli(["init", "--home", bobHome, "--handle", "bobby", "--no-greeter"]);
  await handleCli(["init", "--home", aliceHome, "--handle", "alice-agent", "--no-greeter"]);
  return { root, bobHome, aliceHome };
}

function withFetchMock(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => impl(url.toString(), init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("friend request on a registry handle resolves and creates the request (resolve → friend request sequence)", async () => {
  const { bobHome, aliceHome } = await pairHomes("eb-freq-registry-");
  const bob = new EdgeBookStore({ home: bobHome });
  await bob.updateConfig({ relay_url: "http://relay.test" });
  const bobCard = await bob.writeCard();

  const posted: string[] = [];
  const restore = withFetchMock((url, init) => {
    if (url.includes("/handle/bobby")) return new Response(JSON.stringify(bobCard), { status: 200 });
    if (url.includes("/relay/") && init?.method === "POST") {
      posted.push(url);
      return new Response(JSON.stringify({ ok: true, queued: 1 }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  try {
    // The exact canonical sequence the onboarding copy teaches:
    const resolved = await handleCli(["resolve", "--home", aliceHome, "bobby"]);
    assert.equal((resolved.json as { status: string }).status, "resolved");

    const result = await handleCli(["friend", "request", "--home", aliceHome, "bobby", "--deliver"]);
    const envelope = result.json as { type: string; to_agent_id: string };
    assert.equal(envelope.type, "friend_request");
    assert.equal(envelope.to_agent_id, bobCard.agent_id);
    assert.equal(posted.length, 1, "envelope was sent via the relay transport");

    const alice = new EdgeBookStore({ home: aliceHome });
    const contacts = await alice.contacts();
    assert.equal(contacts[bobCard.agent_id]?.relationship_state, "request_sent");
  } finally {
    restore();
  }
});

test("friend request on a non-existent handle → target_not_resolvable, never ENOENT", async () => {
  const { aliceHome } = await pairHomes("eb-freq-notfound-");
  const restore = withFetchMock(() => new Response(null, { status: 404 }));
  try {
    await assert.rejects(
      handleCli(["friend", "request", "--home", aliceHome, "nobody-here"]),
      (error: unknown) => {
        assert.ok(error instanceof EdgeBookError, `expected EdgeBookError, got ${String(error)}`);
        assert.equal(error.code, "target_not_resolvable");
        assert.match(error.message, /invite/i, "error points at sharing an invite link");
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("friend request on a path-shaped missing file → target_not_resolvable, never ENOENT", async () => {
  const { aliceHome, root } = await pairHomes("eb-freq-badpath-");
  await assert.rejects(
    handleCli(["friend", "request", "--home", aliceHome, path.join(root, "does-not-exist", "card.json")]),
    (error: unknown) => {
      assert.ok(error instanceof EdgeBookError, `expected EdgeBookError, got ${String(error)}`);
      assert.equal(error.code, "target_not_resolvable");
      return true;
    },
  );
});

test("regression: friend request still accepts a card file path", async () => {
  const { bobHome, aliceHome, root } = await pairHomes("eb-freq-file-");
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const cardPath = path.join(root, "bob-card.json");
  await fs.writeFile(cardPath, JSON.stringify(bobCard), "utf8");

  const result = await handleCli(["friend", "request", "--home", aliceHome, cardPath]);
  assert.equal((result.json as { type: string }).type, "friend_request");
});

test("regression: friend request still accepts an invite with an embedded #code=", async () => {
  const { bobHome, aliceHome } = await pairHomes("eb-freq-invite-");
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}#code=secret123`;

  const result = await handleCli(["friend", "request", "--home", aliceHome, invite]);
  const envelope = result.json as { type: string; body: { invite_code?: string } };
  assert.equal(envelope.type, "friend_request");
  assert.equal(envelope.body.invite_code, "secret123");
});

test("regression: friend request still accepts a card URL", async () => {
  const { bobHome, aliceHome } = await pairHomes("eb-freq-url-");
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const restore = withFetchMock((url) =>
    url === "https://bob.example/card.json"
      ? new Response(JSON.stringify(bobCard), { status: 200 })
      : new Response(null, { status: 404 }));
  try {
    const result = await handleCli(["friend", "request", "--home", aliceHome, "https://bob.example/card.json"]);
    assert.equal((result.json as { type: string }).type, "friend_request");
  } finally {
    restore();
  }
});

test("regression: friend request still promotes a candidate id (resolver untouched for candidates)", async () => {
  const { bobHome, aliceHome } = await pairHomes("eb-freq-cand-");
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;
  const alice = new EdgeBookStore({ home: aliceHome });
  const cand = await writeCandidate(alice, { source: "index", confidence: "low", display_name: "Bob", reason: "op1", card_url: invite });

  const result = await handleCli(["friend", "request", "--home", aliceHome, cand.candidate_id]);
  assert.equal((result.json as { type: string }).type, "friend_request");
  assert.ok((await alice.contacts())[bobCard.agent_id], "contact created from promoted candidate");
});

test("resolver approval_required target → approval_required domain error naming the candidate id", async () => {
  // defaultProviders carries no index provider, so the CLI cannot reach
  // approval_required today — exercise the branch through the exported helper
  // with an index provider, the same way resolveTarget produces candidates.
  const { aliceHome } = await pairHomes("eb-freq-approval-");
  const alice = new EdgeBookStore({ home: aliceHome });
  const provider = makeIndexProvider(async () => [
    { message: "Bob wants to collaborate", accept_url: "https://i/accept", socials: { edge_book_card: "https://bob/card.json" } },
  ]);
  await assert.rejects(
    resolveFriendRequestCard(alice, "index:bob", [provider]),
    (error: unknown) => {
      assert.ok(error instanceof EdgeBookError, `expected EdgeBookError, got ${String(error)}`);
      assert.equal(error.code, "approval_required");
      assert.match(error.message, /candidates list/, "error names the next command");
      assert.match(error.message, /friend request cand_/, "error carries the candidate id");
      return true;
    },
  );
});
