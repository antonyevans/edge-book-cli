import assert from "node:assert/strict";
import test from "node:test";
import { nextAction, type ResolverResult } from "../src/resolver.ts";

test("nextAction suggests a friend request for a resolved card", () => {
  const result: ResolverResult = {
    status: "resolved",
    provenance: { source: "card_url", confidence: "high", display_name: "Bob", reason: "fetched card" },
    next_action: "",
  };
  assert.equal(nextAction(result, "https://bob.example/card"), "friend request https://bob.example/card --deliver");
});

test("nextAction tells the user to approve a candidate", () => {
  const result: ResolverResult = {
    status: "approval_required",
    candidates: [{ candidate_id: "cand_x", source: "index", confidence: "low", display_name: "Maybe Bob", reason: "index opportunity", approved: false, created_at: "2026-06-08T00:00:00.000Z" }],
    next_action: "",
  };
  assert.equal(nextAction(result, "index:op1"), "candidates list   # then: friend request cand_x");
});
