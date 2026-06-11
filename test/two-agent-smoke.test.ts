import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSmoke } from "../scripts/lib/two-agent-smoke.ts";

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-smoke-"));
}

test("runSmoke drives two on-disk agents through the full interaction surface, all green", async () => {
  const dir = await tmp();
  const result = await runSmoke({ dir });
  assert.equal(result.ok, true, `failing steps: ${result.steps.filter((s) => !s.ok).map((s) => s.name).join(", ")}`);
  assert.ok(result.steps.length >= 8, "expected a substantive step list");
  const greeterStep = result.steps.find((s) => s.name.startsWith("greeter:"));
  assert.ok(greeterStep, "spec-132 greeter step must be in the smoke surface");
  assert.ok(greeterStep.ok, `greeter step failed: ${greeterStep?.detail}`);
  // agents persisted on disk for inspection
  assert.ok((await fs.stat(path.join(result.agents.alice, "identity.json"))).isFile());
  assert.ok((await fs.stat(path.join(result.agents.bob, "identity.json"))).isFile());
});

test("the smoke framework actually DETECTS breakage (does not rubber-stamp)", async () => {
  const dir = await tmp();
  // After the friend handshake, corrupt Alice's message.friend grant so the
  // grant signature no longer verifies — the message-send step must report ok:false.
  const result = await runSmoke({
    dir,
    hooks: {
      afterFriend: async (ctx) => {
        const grants = await ctx.alice.grants();
        const id = Object.keys(grants).find((k) => grants[k].scopes.includes("message.friend"));
        if (id) {
          grants[id].expires_at = "2999-01-01T00:00:00.000Z"; // mutate without re-signing
          await ctx.alice.saveGrants(grants);
        }
      },
    },
  });
  assert.equal(result.ok, false, "a tampered grant must make the run fail");
  const messageStep = result.steps.find((s) => s.name.includes("message"));
  assert.ok(messageStep && messageStep.ok === false, "the privileged-message step should be the one that fails");
});
