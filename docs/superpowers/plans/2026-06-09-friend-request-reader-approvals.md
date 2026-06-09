# Friend-Request Reader Approvals (Plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface inbound friend requests in the reader as first-class approvals — a badge + Accept/Reject buttons — and route the human's decision back to the requester over the live channel.

**Architecture:** The reader, the **Approvals** view (renders Approve/Reject for any pending `ApprovalRequest`), the `/api/approvals/:id/resolve` endpoint, the attention queue, the `friend_accept` ApprovalRequest type, and `createApproval` ALL already exist on `main`. C therefore does NOT build a reader surface. It (1) makes `receiveFriendRequest` create a `friend_accept` approval, (2) makes resolving that approval call `acceptFriend`/`rejectFriend`, (3) adds the missing `rejectFriend` store method, and (4) relays the resulting `friend_response` back to the requester over the dial-out channel.

**Tech Stack:** TypeScript (ESM, node20), `node --test`, `tsup`. No new deps.

**Base branch:** branch off `main` (friend-profiles already merged). **Sequencing note:** the ea-claude-094 escalation feature added a generic reader→answer→**relay** helper (`maybeRelayEscalationResponse` in `src/dialout.ts`) that keys on a `response_envelope` field in the API JSON response. If escalation has merged to main by start time, **generalize that helper** for friend responses instead of adding a duplicate (Task 5 covers both cases). C does not otherwise depend on escalation.

**Reuse note (from escalation analysis):** `friend_accept` is the right primitive (a pure gate decision), so reuse the existing **Approvals** view — do NOT add a dedicated tab like escalation did (escalation needed its own tab only because it carries a free-text answer payload). The attention queue already counts pending approvals; no change there.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/edge-book.ts` | store | Add `rejectFriend()`; call `createApproval(friend_accept)` in `receiveFriendRequest`; (optional) resolve `friend_accept` approval on accept |
| `src/http.ts` | API + reader | Extend `/api/approvals/:id/resolve` so a `friend_accept` approval triggers `acceptFriend`/`rejectFriend` and returns `response_envelope`; ensure the approval summary is human-readable |
| `src/dialout.ts` | host relay | Relay the `friend_response` carried in an API response's `response_envelope` (generalize escalation's helper if present, else add a minimal one) |
| `test/friend-approval.test.ts` | new — store + endpoint + relay tests | create |

---

## Task 1: `rejectFriend` store method

**Files:** `src/edge-book.ts` (add after `acceptFriend` ~line 799-817); `test/friend-approval.test.ts` (new)

**Context:** `acceptFriend` sets `friend`, issues the grant, and returns a signed `friend_response {accepted:true, card, grant, profile}`. `rejectFriend` is its mirror: set `rejected`, no grant/profile, return `friend_response {accepted:false}`. `applyFriendResponse` already handles `accepted:false` → state `rejected` on the requester side.

- [ ] **Step 1: Write the failing test.** Create `test/friend-approval.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, type FriendResponseBody } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-appr-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("rejectFriend sets rejected and returns a signed accepted:false response", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const envelope = await bob.rejectFriend(aliceCard.agent_id, "no thanks");
  const body = envelope.body as unknown as FriendResponseBody;
  assert.equal(body.accepted, false);
  assert.equal(envelope.type, "friend_response");
  assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "rejected");
  // Requester applies it and ends rejected, no follow-up.
  const followUp = await alice.applyFriendResponse(envelope);
  assert.equal(followUp, null);
  assert.equal((await alice.contacts())[(await bob.writeCard()).agent_id].relationship_state, "rejected");
});
```

- [ ] **Step 2:** Run `node --test test/friend-approval.test.ts` → FAIL (`rejectFriend` undefined).

- [ ] **Step 3: Implement** `rejectFriend` after `acceptFriend`:

```typescript
  async rejectFriend(peerAgentId: string, reason = "rejected"): Promise<MessageEnvelope> {
    const identity = await this.identity();
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.relationship_state === "blocked") throw new EdgeBookError("blocked_peer", "Cannot reject a blocked peer");
    await this.setRelationship(peerAgentId, "rejected", "Reject", reason);
    const card = await this.writeCard();
    return this.signEnvelope({
      type: "friend_response",
      to_agent_id: peerAgentId,
      relationship_id: relationshipId(identity.agent_id, peerAgentId),
      capability_id: "",
      ref: "",
      transport: "local",
      body: { accepted: false, card, reason } satisfies FriendResponseBody,
    });
  }
```

- [ ] **Step 4:** Run → PASS; full suite green; `npm run build` green.

- [ ] **Step 5:** Commit: `feat(approvals): rejectFriend store method`

## Task 2: `receiveFriendRequest` creates a `friend_accept` approval

**Files:** `src/edge-book.ts` (`receiveFriendRequest` ~line 787-797); `test/friend-approval.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Append:

```typescript
test("receiveFriendRequest creates a pending friend_accept approval", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const approvals = Object.values(await bob.approvals());
  const fa = approvals.find((a) => a.type === "friend_accept");
  assert.ok(fa, "expected a friend_accept approval");
  assert.equal(fa!.object_type, "contact");
  assert.equal(fa!.object_id, aliceCard.agent_id);
  assert.equal(fa!.status, "pending");
  assert.match(fa!.summary, /Alice Agent/);
});
```

- [ ] **Step 2:** Run → FAIL (no approval created).

- [ ] **Step 3: Implement.** In `receiveFriendRequest`, after `await appendJsonl(this.file(INBOX_FILE), envelope);` add:

```typescript
    await this.createApproval({
      type: "friend_accept",
      objectType: "contact",
      objectId: envelope.from_agent_id,
      summary: `Friend request from ${body.card.display_name}`,
      riskLevel: "low",
      requestedByAgentId: envelope.from_agent_id,
    });
```

- [ ] **Step 4:** Run → PASS. Run the FULL suite — a few existing tests/harness call `receiveFriendRequest`; adding an approval is additive but confirm nothing asserts an empty approvals map. Fix any such assertion to expect the friend_accept approval, preserving intent. `npm run build` green.

- [ ] **Step 5:** Commit: `feat(approvals): receiveFriendRequest surfaces a friend_accept approval`

## Task 3: resolving a `friend_accept` approval triggers accept/reject + returns the envelope

**Files:** `src/http.ts` (`/api/approvals/:id/resolve` handler ~line 321-325); `test/friend-approval.test.ts` (append)

**Context:** the handler currently calls `store.resolveApproval(id, approved)` and returns `{ approval }`. For a `friend_accept` approval it must ALSO call `acceptFriend`/`rejectFriend` and return the resulting envelope under `response_envelope` (the key the dial-out relay consumes in Task 5).

- [ ] **Step 1: Write the failing test.** Append (drive the handler via the store + a direct call to the exported request handler, or via the local API server the other api tests use — match `test/api-escalation.test.ts`'s harness):

```typescript
test("resolving a friend_accept approval (approve) makes friends + returns response_envelope", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));
  const approval = Object.values(await bob.approvals()).find((a) => a.type === "friend_accept")!;

  // Use the same in-process API harness as test/api-escalation.test.ts:
  const { json } = await postApi(bob, `/api/approvals/${approval.approval_id}/resolve`, { approved: true });
  assert.equal(json.approval.status, "approved");
  assert.equal(json.response_envelope.type, "friend_response");
  assert.equal((json.response_envelope.body as any).accepted, true);
  assert.equal((await bob.contacts())[aliceCard.agent_id].relationship_state, "friend");
});
```

`postApi` should reuse whatever helper `test/api-escalation.test.ts` uses to invoke `handleHttpRequest`/the server in-process — open that test first and copy its setup exactly rather than inventing one.

- [ ] **Step 2:** Run → FAIL (no `response_envelope`, state not `friend`).

- [ ] **Step 3: Implement.** Replace the resolve handler body:

```typescript
  const approvalResolveMatch = /^\/api\/approvals\/([^/]+)\/resolve$/.exec(url.pathname);
  if (req.method === "POST" && approvalResolveMatch) {
    const body = await readJsonBody<{ approved?: boolean }>(req);
    const approved = Boolean(body.approved);
    const approval = await store.resolveApproval(decodeURIComponent(approvalResolveMatch[1]), approved);
    let response_envelope: unknown;
    if (approval.type === "friend_accept") {
      response_envelope = approved
        ? await store.acceptFriend(approval.object_id)
        : await store.rejectFriend(approval.object_id);
    }
    sendJson(res, 200, response_envelope ? { approval, response_envelope } : { approval });
    return true;
  }
```

- [ ] **Step 4:** Run → PASS; full suite green; build green.

- [ ] **Step 5:** Commit: `feat(approvals): friend_accept resolution drives acceptFriend/rejectFriend`

## Task 4: reader renders friend_accept cleanly (verify/minimal)

**Files:** `src/http.ts` reader (`dashboardHtml` Approvals view ~line 1288-1297)

- [ ] **Step 1:** Manually verify the existing Approvals renderer already shows the friend_accept approval with Approve/Reject (it renders any pending approval; `summary` = "Friend request from <name>", `type` shows `friend accept`). Start the reader (`edge-book serve`) or read the JSX-in-string at 1288-1297 and confirm no type-specific gating excludes it. If it renders, NO code change — note it.
- [ ] **Step 2:** If (and only if) the Approve/Reject click handlers don't already POST `{approved:true/false}` to `/api/approvals/:id/resolve`, fix them. Per main they do (`approval-approve`/`approval-reject`). Confirm by reading the click dispatch (~line 1399-1424).
- [ ] **Step 3:** Confirm the attention-queue "Approvals" row + `approvalCount` badge count it (they count all pending approvals — they will). No change expected.
- [ ] **Step 4:** Commit only if a change was needed: `fix(approvals): render friend_accept in reader Approvals view`. Otherwise record "verified, no change" in the task notes.

## Task 5: relay the friend_response back to the requester

**Files:** `src/dialout.ts` (`handleApiRequest`); `test/friend-approval.test.ts` (append, mirror `test/dialout-escalation-relay.test.ts` if present)

**Context:** when the human approves in the reader, the agent is a dial-out client (no inbound endpoint), so the `friend_response` must be pushed back over the live channel. Escalation solved this with `maybeRelayEscalationResponse`, which fires on any API response carrying `response_envelope`.

- [ ] **Step 1: Determine which case you're in.** Run `grep -n "maybeRelayEscalationResponse\|response_envelope" src/dialout.ts`.
  - **If present** (escalation merged): it already relays ANY `response_envelope` — so Task 3's response will relay for free. Your job is only to (a) confirm it fires for friend responses, (b) **generalize the hard-coded audit event names** `escalation.relay`/`escalation.relay_failed` to branch on the envelope `.type` (e.g. `friend_response.relay`), and (c) optionally rename the helper to `maybeRelayResponseEnvelope`.
  - **If absent** (escalation not merged): add a minimal relay in `handleApiRequest`, after the API response is produced, that delivers a `response_envelope` over the channel.

- [ ] **Step 2: Write the failing test** mirroring `test/dialout-escalation-relay.test.ts` (open it; copy its dial-out mock + assertion shape). Assert: approving a friend_accept approval through the reader API path causes a `friend_response` envelope to be sent over the dial-out channel to the requester, best-effort (a send failure is swallowed + audited, not thrown).

- [ ] **Step 3: Implement** (absent case) a helper in `dialout.ts`:

```typescript
  // Best-effort: if a reader API call produced a response envelope (friend_response,
  // escalation_response, ...), push it back to its recipient over this live channel.
  private async maybeRelayResponseEnvelope(payload: unknown): Promise<void> {
    const env = (payload as { response_envelope?: MessageEnvelope })?.response_envelope;
    if (!env || typeof env !== "object" || !("type" in env)) return;
    try {
      await this.sendEnvelope(env);
      await this.store.audit(`${env.type}.relay`, env.to_agent_id, { message_id: env.message_id });
    } catch {
      await this.store.audit(`${env.type}.relay_failed`, env.to_agent_id, { message_id: env.message_id });
    }
  }
```

Call it in `handleApiRequest` right after the API JSON response is computed, passing the parsed response body. (If escalation's helper exists, do NOT add this — generalize theirs per Step 1.)

- [ ] **Step 4:** Run → PASS; full suite green; build green; `npm run smoke` still 10/10.

- [ ] **Step 5:** Commit: `feat(approvals): relay friend_response to requester on reader accept/reject`

---

## Self-Review

- **Spec coverage (Plan C / spec section C):** reader badge + Accept/Reject (reused, Task 4), accept/reject endpoints (Task 3 via existing resolve endpoint), `acceptFriend`/`rejectFriend` wiring (Tasks 1,3), relay back (Task 5), approval creation (Task 2). ✓
- **Reuse honored:** no new reader tab; reuses Approvals view, resolve endpoint, attention queue, `createApproval`, `friend_accept` type. Net-new is only `rejectFriend`, one `createApproval` call, the resolve-handler branch, and the relay (generalized from escalation if present). ✓
- **Cross-feature safety:** adding `createApproval` in `receiveFriendRequest` is additive; friend-profiles exchange and the two-agent harness still pass (Task 2 Step 4 verifies). The relay generalization shares the `response_envelope` convention with escalation — audit names branch on `.type` so trails stay honest.
- **Dependency:** builds on `main`. Task 5 adapts to whether escalation's relay helper is already merged.
- **No placeholders:** all net-new code given; reused paths reference exact file:line on main. Test harness helpers (`postApi`) explicitly instructed to copy `test/api-escalation.test.ts` / `test/dialout-escalation-relay.test.ts` rather than be invented.
