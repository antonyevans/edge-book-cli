// spec-129: agent-led onboarding — init handoff block, --from-invite candidate,
// and the onboard.md prompt content guard.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleCli } from "../src/cli.ts";
import { loadCard, EdgeBookStore } from "../src/edge-book.ts";
import { listCandidates } from "../src/resolver.ts";

const MENTAL_MODEL =
  "Edge Book is a permissioned room between agents — you decide who comes in, what they can see, and you can take it back anytime.";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-onboarding-test-"));
}

test("init without --from-invite prints the handoff block and omits onboarding JSON", async () => {
  const home = await tempRoot();
  const result = await handleCli(["init", "--home", home, "--name", "Test Agent"]);
  assert.ok(result.text.includes("permissioned room between agents"), "mental-model line missing from init output");
  assert.ok(result.text.includes("candidates list"), "no-invite fallback (candidates list) missing");
  assert.ok(result.text.includes("skills/edge-book/prompts/onboard.md"), "pointer to onboard prompt missing");
  // Existing init guidance must survive the change.
  assert.ok(result.text.includes("Two-tier profile"));
  const json = result.json as Record<string, unknown>;
  assert.ok(json.agent_id, "identity fields must still be in JSON");
  assert.ok(!("onboarding" in json), "onboarding key must be omitted entirely without --from-invite");
});

test("init --from-invite records a promotable candidate with source invite", async () => {
  const root = await tempRoot();
  const inviterHome = path.join(root, "inviter");
  await handleCli(["init", "--home", inviterHome, "--handle", "greeter.openclaw.local", "--name", "Greeter"]);
  // Invite with a consumable code so the URL carries a #code= fragment.
  const inviteResult = await handleCli(["card", "invite", "--home", inviterHome, "--ttl-ms", "60000", "--uses", "1"]);
  const inviteUrl = (inviteResult.json as { invite_url: string }).invite_url;
  assert.ok(inviteUrl.includes("#code="), "test invite must carry a code fragment");

  const home = path.join(root, "newbie");
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--from-invite", inviteUrl]);
  const json = result.json as { agent_id?: string; onboarding?: { invite_candidate_id?: string; invite_display_name?: string } };
  assert.ok(json.agent_id, "identity created");
  assert.ok(json.onboarding?.invite_candidate_id, "onboarding.invite_candidate_id missing");
  assert.equal(json.onboarding?.invite_display_name, "Greeter");
  assert.ok(result.text.includes("Greeter"), "inviter name missing from output");
  assert.ok(
    result.text.includes(`friend request ${json.onboarding!.invite_candidate_id} --deliver`),
    "exact promotion command missing from output",
  );

  const store = new EdgeBookStore({ home });
  const candidates = await listCandidates(store);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.source, "invite");
  assert.equal(candidate.display_name, "Greeter");
  assert.ok(candidate.card_url?.startsWith("edgebook:invite:"), "card_url must be the invite string");
  assert.ok(!candidate.card_url?.includes("#"), "code fragment must be stripped before storage");
  // Promotion round-trip: the stored card_url must decode back to the inviter's card.
  const card = await loadCard(candidate.card_url!);
  assert.equal(card.display_name, "Greeter");
});

test("init --from-invite with a bad link still creates identity and writes no candidate", async () => {
  const home = await tempRoot();
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--from-invite", "edgebook:invite:!!!not-a-card!!!"]);
  const json = result.json as { agent_id?: string; onboarding?: { invite_error?: string } };
  assert.ok(json.agent_id, "a bad invite must never block identity creation");
  assert.ok(json.onboarding?.invite_error, "onboarding.invite_error missing");
  assert.ok(result.text.includes("Invite link could not be read"), "soft warning line missing");
  const store = new EdgeBookStore({ home });
  assert.equal((await listCandidates(store)).length, 0, "no candidate may be written for a bad invite");
});

test("onboard.md prompt exists, carries the mental model, and avoids infrastructure vocabulary", async () => {
  const promptPath = fileURLToPath(new URL("../skills/edge-book/prompts/onboard.md", import.meta.url));
  const exists = await fs.access(promptPath).then(() => true, () => false);
  assert.ok(exists, "skills/edge-book/prompts/onboard.md must exist");
  const text = await fs.readFile(promptPath, "utf8");
  assert.ok(text.includes(MENTAL_MODEL), "mental-model line must appear verbatim");
  for (const banned of ["Hermes", "mailbox", "envelope", "relay", "DID"]) {
    assert.ok(!text.includes(banned), `banned infrastructure word in onboard.md: ${banned}`);
  }
});
