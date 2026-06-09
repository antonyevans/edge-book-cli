# Edge Book Abuse Floor (ea-claude-087) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Make the friend-request/object-share surface safe for an OPEN network — throttle inbound floods, let the human report (with optional auto-block), and provide a per-agent switch to flip from open (default) to invite-only.

**Decision (from owner):** default **OPEN** (anyone who resolves the agent may friend-request), with a config switch to turn open off → **invite-only** (unsolicited requests dropped unless they present a valid invite code). Build the full floor now.

**Architecture:** All agent-side in `edge-book-cli` (the host is a dumb relay; the agent owns who it accepts). Inbound throttle + invite-only gate insert at the top of `receiveFriendRequest` / `receiveObjectShare` (after `verifyEnvelope`, before any state mutation). Report is a new local record + optional `block()`. Invite codes are minted by `card invite` and consumed on receipt when invite-only.

**Tech Stack:** TS (ESM, node20), `node --test`, `tsup`. No new deps. Base: branch off `main` (currently `63f0686`, all friend-request features + escalation shipped). Baseline suite green (181/181).

**Existing anchors (read before coding):**
- `receiveFriendRequest` (`src/edge-book.ts:995`), `receiveObjectShare` (~`:1831`), `block` (~`:1196`), `EdgeBookConfig`/`updateConfig`, `createFriendRequest` (~`:976`), `card invite` CLI (`src/cli.ts`, builds `edgebook:invite:<b64 card>`), `loadCard` (`src/edge-book.ts:2788`), `FriendRequestBody { card, note }`, `audit()`, `now()`, `randomId`, `writeJson`/`readJson`. Throttle/report/invite-codes each get their own JSON file via the established `readJson(file, fallback)` pattern.

---

## File Structure

| File | Change |
|---|---|
| `src/edge-book.ts` | `EdgeBookConfig` adds throttle params + `open_friend_requests`; `FriendRequestBody` adds optional `invite_code`; new `ReportRecord` + `InviteCode` types; throttle check + invite gate in `receiveFriendRequest`/`receiveObjectShare`; `reportPeer()`, `reports()`; `mintInviteCode()`, `inviteCodes()`, internal `consumeInviteCode()` |
| `src/cli.ts` | `report <peer> [--reason] [--block]`; `friend policy --open\|--invite-only`; `card invite [--code] [--ttl-ms] [--uses]` mints+embeds a code; `createFriendRequest`/`friend request` extracts the code from an invite link and passes it |
| `test/abuse-floor.test.ts` | new — throttle, report, invite-only gate, open default |

---

## Task 1: Config + types

**Files:** `src/edge-book.ts`

- [ ] **Step 1:** Extend `EdgeBookConfig`:

```typescript
  // Abuse floor. open_friend_requests default true (treat undefined as true):
  // accept unsolicited friend requests. false => invite-only (drop unsolicited
  // requests that carry no valid invite code and have no prior relationship).
  open_friend_requests?: boolean;
  // Inbound throttle (per peer and global) for friend_request + object_share.
  // Defaults applied in code when unset.
  inbound_max_per_peer?: number;   // default 5
  inbound_max_global?: number;     // default 60
  inbound_window_ms?: number;      // default 3600000 (1h)
```

- [ ] **Step 2:** Add types near other interfaces:

```typescript
export interface ReportRecord {
  report_id: string;
  peer_agent_id: string;
  reason: string;
  blocked: boolean;
  created_at: string;
  audit_refs: string[];
}

export interface InviteCode {
  code: string;
  created_at: string;
  expires_at: string; // "" = no expiry
  max_uses: number;   // 0 = unlimited
  uses: number;
}
```

- [ ] **Step 3:** Extend `FriendRequestBody`:

```typescript
export interface FriendRequestBody {
  card: AgentCard;
  note: string;
  invite_code?: string; // present when the requester used an invite link carrying a code
}
```

- [ ] **Step 4:** `updateConfig` persists the new fields (mirror the `!== undefined` guards). Add constants `REPORTS_FILE = "reports.json"`, `INVITE_CODES_FILE = "invite-codes.json"`, `INBOUND_RATE_FILE = "inbound-rate.json"`.

- [ ] **Step 5:** `npm run build`. Commit: `feat(abuse): config flags + ReportRecord/InviteCode types + invite_code on FriendRequestBody`

## Task 2: Inbound throttle (TDD)

**Files:** `src/edge-book.ts`; `test/abuse-floor.test.ts` (new)

Throttle records inbound `friend_request`/`object_share` arrival times keyed by peer, in `inbound-rate.json` (`{ [peerAgentId]: number[] }`, timestamps ms). On each inbound, prune entries older than `inbound_window_ms`, then check: peer count ≥ `inbound_max_per_peer` OR total-across-peers ≥ `inbound_max_global` → over limit.

- [ ] **Step 1: Failing test** — create `test/abuse-floor.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-abuse-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("inbound friend_request throttle drops a per-peer flood with rate_limited", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  await bob.updateConfig({ inbound_max_per_peer: 2, inbound_window_ms: 3_600_000 });
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)); // 1
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)); // 2
  await assert.rejects(
    () => bob.receiveFriendRequest(await alice.createFriendRequest(bobCard)), // 3 over
    (e) => e instanceof EdgeBookError && e.code === "rate_limited",
  );
});
```

- [ ] **Step 2:** Run → FAIL (no throttle).

- [ ] **Step 3: Implement** a private helper and call it FIRST in `receiveFriendRequest` (right after `verifyEnvelope`) and in `receiveObjectShare` (after its verify):

```typescript
  private async enforceInboundRate(peerAgentId: string): Promise<void> {
    const config = await this.config();
    const windowMs = config.inbound_window_ms ?? 3_600_000;
    const maxPeer = config.inbound_max_per_peer ?? 5;
    const maxGlobal = config.inbound_max_global ?? 60;
    const cutoff = Date.now() - windowMs;
    const all = await readJson<Record<string, number[]>>(this.file(INBOUND_RATE_FILE), {});
    for (const k of Object.keys(all)) {
      all[k] = all[k].filter((t) => t > cutoff);
      if (!all[k].length) delete all[k];
    }
    const peerCount = (all[peerAgentId] ?? []).length;
    const globalCount = Object.values(all).reduce((n, arr) => n + arr.length, 0);
    if (peerCount >= maxPeer || globalCount >= maxGlobal) {
      await this.audit("inbound.rate_limited", peerAgentId, { peerCount, globalCount });
      throw new EdgeBookError("rate_limited", "Inbound request rate limit exceeded");
    }
    all[peerAgentId] = [...(all[peerAgentId] ?? []), Date.now()];
    await writeJson(this.file(INBOUND_RATE_FILE), all);
  }
```

Call `await this.enforceInboundRate(envelope.from_agent_id);` at the top of `receiveFriendRequest` (after the `verifyEnvelope` + type check) and `receiveObjectShare`.

- [ ] **Step 4:** Run → PASS. Full suite green (existing tests send few requests per peer, under the default 5 — confirm; if any test loops >5 from one peer, raise that test's config or count). `npm run build`.

- [ ] **Step 5:** Commit: `feat(abuse): per-peer + global inbound throttle on friend_request/object_share`

## Task 3: Report + optional auto-block (TDD)

**Files:** `src/edge-book.ts`, `src/cli.ts`; `test/abuse-floor.test.ts` (append)

- [ ] **Step 1: Failing test** (append):

```typescript
test("reportPeer records evidence and can auto-block", async () => {
  const { alice, bob } = await pair();
  const aliceId = (await alice.identity()).agent_id;
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  const rec = await bob.reportPeer(aliceId, "spam", { block: true });
  assert.equal(rec.peer_agent_id, aliceId);
  assert.equal(rec.reason, "spam");
  assert.equal(rec.blocked, true);
  assert.equal((await bob.reports()).length, 1);
  assert.equal((await bob.contacts())[aliceId].relationship_state, "blocked");
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** `reports()` (reads `REPORTS_FILE` as `ReportRecord[]`, default `[]`) and:

```typescript
  async reportPeer(peerAgentId: string, reason = "", opts: { block?: boolean } = {}): Promise<ReportRecord> {
    const auditRef = await this.audit("peer.reported", peerAgentId, { reason, block: Boolean(opts.block) });
    const rec: ReportRecord = {
      report_id: randomId("report"),
      peer_agent_id: peerAgentId,
      reason,
      blocked: Boolean(opts.block),
      created_at: now(),
      audit_refs: [auditRef],
    };
    const reports = await readJson<ReportRecord[]>(this.file(REPORTS_FILE), []);
    reports.push(rec);
    await writeJson(this.file(REPORTS_FILE), reports);
    if (opts.block) {
      // block() is a no-op-safe state set; guard if the contact is unknown.
      const contacts = await this.contacts();
      if (contacts[peerAgentId]) await this.block(peerAgentId);
    }
    return rec;
  }
```

- [ ] **Step 4:** CLI `report` command in `src/cli.ts`:

```typescript
  if (command === "report") {
    const peer = requireArg(args.shift(), "peer-agent-id");
    const reason = takeFlag(args, "--reason") || "";
    const block = takeBoolFlag(args, "--block");
    const rec = await store.reportPeer(peer, reason, { block });
    return { text: `Reported ${peer}${block ? " and blocked" : ""} (report ${rec.report_id})`, json: rec };
  }
```

Add `report <peer-agent-id> [--reason <r>] [--block]` to `usage()`.

- [ ] **Step 5:** Run → PASS; full suite green; build. Commit: `feat(abuse): report peer with evidence + optional auto-block (store + CLI)`

## Task 4: Open vs invite-only gate + invite codes (TDD)

**Files:** `src/edge-book.ts`, `src/cli.ts`; `test/abuse-floor.test.ts` (append)

Semantics: when `open_friend_requests !== false` (default open) → accept (subject to throttle). When `false` (invite-only) → in `receiveFriendRequest`, accept only if the body carries a valid `invite_code` (consume it) OR the peer already has a relationship `!== "none"` (you reached out / known); else drop with `EdgeBookError("unsolicited_dropped", ...)` + audit, and do NOT create an approval/notification.

- [ ] **Step 1: Failing tests** (append):

```typescript
test("invite-only drops a cold unsolicited request; open (default) accepts it", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  // default open
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  assert.equal((await bob.pendingFriendRequests()).length, 1);
  // flip to invite-only
  const { alice: a2, bob: b2 } = await pair();
  const b2Card = await b2.writeCard();
  await b2.updateConfig({ open_friend_requests: false });
  await assert.rejects(
    () => b2.receiveFriendRequest(await a2.createFriendRequest(b2Card)),
    (e) => e instanceof EdgeBookError && e.code === "unsolicited_dropped",
  );
});

test("invite-only accepts a request carrying a valid minted invite code (single use)", async () => {
  const { alice, bob } = await pair();
  await bob.updateConfig({ open_friend_requests: false });
  const bobCard = await bob.writeCard();
  const invite = await bob.mintInviteCode({ maxUses: 1 });
  // Requester includes the code; createFriendRequest takes it as 3rd arg.
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard, "hi", invite.code)); // accepted
  assert.equal((await bob.pendingFriendRequests()).length, 1);
  // code is now consumed → a second cold request from a different peer is dropped
  const carol = new EdgeBookStore({ home: path.join(await fs.mkdtemp(path.join(os.tmpdir(), "eb-carol-")), "c") });
  await carol.init({ handle: "carol.openclaw.local", displayName: "Carol" });
  await assert.rejects(
    () => bob.receiveFriendRequest(await carol.createFriendRequest(bobCard, "hi", invite.code)),
    (e) => e instanceof EdgeBookError && e.code === "unsolicited_dropped",
  );
});
```

- [ ] **Step 2:** Run → FAIL (`mintInviteCode` missing; `createFriendRequest` 3rd arg ignored; no gate).

- [ ] **Step 3: Implement.**
  - `createFriendRequest(targetCard, note = "", inviteCode = "")` — add the 3rd param and include `...(inviteCode ? { invite_code: inviteCode } : {})` in the `FriendRequestBody`.
  - `mintInviteCode({ ttlMs?, maxUses? } = {})` — create an `InviteCode` (code `randomId("invite")`, expires_at from ttl or "", max_uses default 0=unlimited, uses 0), append to `INVITE_CODES_FILE`, return it. `inviteCodes()` reads them.
  - private `consumeInviteCode(code): Promise<boolean>` — find a code that's non-expired and under max_uses; increment `uses`; persist; return true; else false.
  - In `receiveFriendRequest`, AFTER throttle + verify, BEFORE state mutation: if `(await this.config()).open_friend_requests === false`, then `const known = (await this.contacts())[envelope.from_agent_id]?.relationship_state; const allowed = (known && known !== "none") || (body.invite_code ? await this.consumeInviteCode(body.invite_code) : false); if (!allowed) { await this.audit("inbound.unsolicited_dropped", envelope.from_agent_id, {}); throw new EdgeBookError("unsolicited_dropped", "Invite-only: unsolicited request without a valid invite code"); }`

- [ ] **Step 4:** CLI:
  - `card invite [--code] [--ttl-ms <ms>] [--uses <n>]` — when `--code` (or always, decide), call `mintInviteCode` and embed BOTH card and code in the invite link. Simplest: keep the link as the card; ALSO print the code on a second line, and teach `loadCard`/`friend request` to accept an `edgebook:invite:<b64 card>#code=<code>` form. Implementation: when minting, output `edgebook:invite:<b64card>#code=<code>`. In `friend request`, parse a trailing `#code=` off the target, strip it before `loadCard`, and pass the code to `createFriendRequest`.
  - `friend policy --open|--invite-only` → `updateConfig({ open_friend_requests })`.
  - Update `usage()`.

- [ ] **Step 5:** Run → PASS; full suite green; build; `npm run smoke` 10/10 (smoke uses default-open, unaffected; but it sends a friend_request — confirm throttle default 5 isn't tripped). Commit: `feat(abuse): open/invite-only policy + invite codes (gate + CLI)`

## Task 5: Reader report action (light)

**Files:** `src/http.ts` reader + a `/api/contacts/:id/report` endpoint

- [ ] **Step 1:** Add `POST /api/contacts/:id/report` (body `{reason?, block?}`) → `store.reportPeer(...)`, mirroring the `/api/approvals/:id/resolve` handler shape. Return `{ report }`.
- [ ] **Step 2:** In the reader Contacts (or Approvals) view, add a "Report" action button (`data-action="contact-report"`) that POSTs to it; reuse the existing action-dispatch pattern. Keep minimal.
- [ ] **Step 3:** Build + full suite + smoke green. Commit: `feat(abuse): reader report action + /api/contacts/:id/report`

(If the reader wiring proves involved, ship Tasks 1–4 and split Task 5 to a follow-up — the CLI report path is the must-have; the reader button is convenience.)

---

## Self-Review
- **Spec coverage (ea-claude-087):** inbound throttle per-peer+global with audit (T2); report CLI+store+auto-block (T3) and reader (T5); open default + invite-only switch + invite codes (T1,T4). Launch model documented = open default, off-switch to invite-only.
- **No over-reach:** throttle drops floods but defaults (5/peer/h, 60/h global) won't lock out legitimate peers; human-approval gate (097) still applies on top.
- **Cross-feature safety:** throttle/gate sit ABOVE the existing receive logic; default-open + generous limits keep all existing tests and the smoke green. `createFriendRequest`'s new 3rd param is optional (back-compatible with profiles/notifications/approvals callers and the harness).
- **No placeholders:** all code given; reader wiring (T5) references the existing `/api/.../resolve` + action-dispatch patterns and is explicitly splittable if involved.
