import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli, runCli } from "../src/cli.ts";
import { writeCandidate } from "../src/resolver.ts";

test("CLI resolve verifies an invite and reports resolved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cli-resolve-"));
  const bobHome = path.join(root, "bob");
  const aliceHome = path.join(root, "alice");
  await handleCli(["init", "--home", bobHome, "--handle", "bob.openclaw.local"]);
  await handleCli(["init", "--home", aliceHome, "--handle", "alice.openclaw.local"]);
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;

  const result = await handleCli(["resolve", "--home", aliceHome, invite]);
  const json = result.json as { status: string; agent_id?: string };
  assert.equal(json.status, "resolved");
  assert.equal(json.agent_id, bobCard.agent_id);
});

test("CLI candidates list is empty on a fresh store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cli-cand-"));
  await handleCli(["init", "--home", root, "--handle", "a.openclaw.local", "--no-greeter"]);
  const result = await handleCli(["candidates", "list", "--home", root]);
  assert.deepEqual((result.json as { candidates: unknown[] }).candidates, []);
});

test("CLI candidates list --json prints the candidates as JSON, not the table", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cli-cand-json-"));
  await handleCli(["init", "--home", root, "--handle", "a.openclaw.local", "--no-greeter"]);
  const store = new EdgeBookStore({ home: root });
  const cand = await writeCandidate(store, { source: "index", confidence: "low", display_name: "Bob", reason: "op1" });

  const log = t.mock.method(console, "log", () => undefined);
  await runCli(["candidates", "list", "--home", root, "--json"]);
  const out = log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  const parsed = JSON.parse(out) as { candidates: Array<{ candidate_id: string }> };
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].candidate_id, cand.candidate_id);
});

test("CLI friend request on a candidate id promotes it to a verified contact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-book-cli-promote-"));
  const bobHome = path.join(root, "bob");
  const aliceHome = path.join(root, "alice");
  await handleCli(["init", "--home", bobHome, "--handle", "bob.openclaw.local"]);
  await handleCli(["init", "--home", aliceHome, "--handle", "alice.openclaw.local"]);
  const bobCard = await new EdgeBookStore({ home: bobHome }).writeCard();
  const invite = `edgebook:invite:${Buffer.from(JSON.stringify(bobCard), "utf8").toString("base64url")}`;

  const alice = new EdgeBookStore({ home: aliceHome });
  const cand = await writeCandidate(alice, { source: "index", confidence: "low", display_name: "Bob", reason: "op1", card_url: invite });

  const result = await handleCli(["friend", "request", "--home", aliceHome, cand.candidate_id]);
  const envelope = result.json as { type: string };
  assert.equal(envelope.type, "friend_request");
  const contacts = await alice.contacts();
  assert.ok(contacts[bobCard.agent_id], "contact created from promoted candidate");
});
