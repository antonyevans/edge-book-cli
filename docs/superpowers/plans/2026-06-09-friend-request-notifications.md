# Friend-Request Notifications (Plan B + D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a friend_request arrives, the agent notifies its human on their usual channel (Telegram via Hermes; later OpenClaw), and the human can accept by replying — with no double-notifications and a per-agent off switch.

**Architecture:** edge-book stays transport-free. It exposes a **data surface** — `friend pending` lists `request_received` contacts not yet notified (dedup via a `notified_at` stamp), gated by a `notify_on_friend_request` config flag (default on). The actual notification is a host **cron whose body is a natural-language prompt** that polls `friend pending`, messages the human on their last-active channel, and runs `friend accept` on a "yes" reply — exactly the pattern the escalation feature and agentvillage's digest crons already use. Plan D ships the same prompt as an OpenClaw `heartbeat.md`.

**Tech Stack:** TypeScript (ESM, node20), `node --test`, `tsup`. No new deps. This plan was adapted after the ea-claude-094 escalation feature shipped; it deliberately reuses escalation's idempotent-sweep idiom and adds NO transport code (escalation confirmed edge-book→host stays opaque-relay only).

**Base branch:** branch off `main` (which now contains friend-profiles-core). If the escalation branch (`feat/094-human-escalation`) has merged to main by start time, nothing changes for this plan — B touches none of escalation's files.

**Scope:** Phase B (edge-book-cli data surface + Hermes cron artifact). Phase D (OpenClaw heartbeat bundle) at the end — same prompt, different runtime.

**Reuse note (from escalation analysis):** copy the load-mutate-save sweep shape of `expireEscalations` (`src/edge-book.ts`) for the `notified_at` stamp; mirror the `{ text, json }` CLI return convention used everywhere (e.g. `escalation list`). Do NOT add an envelope type, grant, or dial-out path — B is read-only + one timestamp.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/edge-book.ts` | store + types | Add `notified_at` to `AgentContactRecord`; preserve it in `upsertContactFromCard`; add `notify_on_friend_request?` to `EdgeBookConfig`; add `pendingFriendRequests()` + `markFriendRequestNotified()` |
| `src/cli.ts` | CLI | Add `friend pending [--json]` and `friend mark-notified <peer>`; `notify-config --on|--off` (thin wrapper over `updateConfig`) |
| `skills/edge-book/prompts/friend-requests.md` | the cron/heartbeat prompt body (shared by Hermes + OpenClaw) | create |
| `skills/edge-book/SKILL.md`, `skills/edge-book/openclaw.plugin.json`, `skills/edge-book/heartbeat.md` | Plan D OpenClaw bundle | create (Phase D) |
| `test/friend-notify.test.ts` | unit tests for the data surface | create |
| `README` (notifications section) | document the `hermes cron create` install command | update |

---

## PHASE B — edge-book-cli data surface

### Task 1: `notified_at` field + preserve across card refresh

**Files:** `src/edge-book.ts` (`AgentContactRecord` ~line 63-83; `upsertContactFromCard` ~line 704-737)

- [ ] **Step 1:** Add to `AgentContactRecord`, after `friend_profile?` (added by friend-profiles):

```typescript
  // ISO timestamp the human was last notified of this inbound request ("" = not
  // yet notified). Drives friend-request notification dedup.
  notified_at?: string;
```

- [ ] **Step 2:** In `upsertContactFromCard`, preserve it across refresh — add to the `next` record object alongside the existing `friend_profile` carry-over:

```typescript
      ...(existing?.notified_at ? { notified_at: existing.notified_at } : {}),
```

- [ ] **Step 3:** Build gate: `npm run build` (must succeed — repo has no tsc). Run `node --test test/edge-book.test.ts` to confirm no regression.

- [ ] **Step 4:** Commit: `feat(notify): add notified_at to contact record + preserve on refresh`

### Task 2: `notify_on_friend_request` config flag

**Files:** `src/edge-book.ts` (`EdgeBookConfig` ~line 21-24; `updateConfig` ~line 602-609)

- [ ] **Step 1:** Add to `EdgeBookConfig`:

```typescript
  // Default ON (treat undefined as true). When false, pendingFriendRequests()
  // returns [] so the notifier cron stays silent.
  notify_on_friend_request?: boolean;
```

- [ ] **Step 2:** Extend `updateConfig` to persist it — add inside the method, after the `relay_url` line:

```typescript
    if (input.notify_on_friend_request !== undefined) next.notify_on_friend_request = input.notify_on_friend_request;
```

- [ ] **Step 3:** Build + commit: `feat(notify): notify_on_friend_request config flag (default on)`

### Task 3: `pendingFriendRequests()` + `markFriendRequestNotified()`

**Files:** `src/edge-book.ts` (add store methods near `receiveFriendRequest`); `test/friend-notify.test.ts` (new)

- [ ] **Step 1: Write the failing test.** Create `test/friend-notify.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";

async function pair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-"));
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  const bob = new EdgeBookStore({ home: path.join(root, "bob") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await bob.init({ handle: "bob.openclaw.local", displayName: "Bob Agent" });
  return { alice, bob };
}

test("pendingFriendRequests lists un-notified request_received; mark dedups", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  let pending = await bob.pendingFriendRequests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].peer_agent_id, aliceCard.agent_id);
  assert.equal(pending[0].display_name, "Alice Agent");
  await bob.markFriendRequestNotified(aliceCard.agent_id);
  pending = await bob.pendingFriendRequests();
  assert.equal(pending.length, 0, "marked request is no longer pending");
});

test("notify_on_friend_request:false suppresses the list", async () => {
  const { alice, bob } = await pair();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.updateConfig({ notify_on_friend_request: false });
  assert.deepEqual(await bob.pendingFriendRequests(), []);
});

test("accepted/other states never appear as pending", async () => {
  const { alice, bob } = await pair();
  const aliceCard = await alice.writeCard();
  const bobCard = await bob.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(bobCard));
  await bob.acceptFriend(aliceCard.agent_id);
  assert.deepEqual(await bob.pendingFriendRequests(), []);
});
```

- [ ] **Step 2:** Run `node --test test/friend-notify.test.ts` → FAIL (methods undefined).

- [ ] **Step 3: Implement** (in `EdgeBookStore`, near `receiveFriendRequest`):

```typescript
  // Inbound friend requests the human hasn't been told about yet. Empty when the
  // agent has notifications disabled. Read-only — the notifier cron consumes this.
  async pendingFriendRequests(): Promise<AgentContactRecord[]> {
    const config = await this.config();
    if (config.notify_on_friend_request === false) return [];
    const contacts = await this.contacts();
    return Object.values(contacts).filter(
      (c) => c.relationship_state === "request_received" && !c.notified_at,
    );
  }

  // Stamp a request as notified so it won't surface again (idempotent sweep,
  // mirrors expireEscalations).
  async markFriendRequestNotified(peerAgentId: string): Promise<void> {
    const contacts = await this.contacts();
    const contact = contacts[peerAgentId];
    if (!contact) throw new EdgeBookError("unknown_contact", `Unknown contact: ${peerAgentId}`);
    if (contact.notified_at) return;
    contact.notified_at = now();
    contact.updated_at = now();
    contacts[peerAgentId] = contact;
    await this.saveContacts(contacts);
    await this.audit("friend.notified", peerAgentId, {});
  }
```

- [ ] **Step 4:** Run `node --test test/friend-notify.test.ts` → PASS. Then full suite `node --test test/*.test.ts` → no regressions.

- [ ] **Step 5:** Commit: `feat(notify): pendingFriendRequests + markFriendRequestNotified`

### Task 4: CLI `friend pending` / `friend mark-notified` / `notify-config`

**Files:** `src/cli.ts` (the `friend` command block ~line 260-325; usage text); `test/friend-notify.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Append, using `handleCli` (the testable entry; `home` via `ctx.home`, result `{text,json}`):

```typescript
import { handleCli } from "../src/cli.ts";

test("CLI friend pending --json lists, mark-notified dedups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-notify-cli-"));
  const bobHome = path.join(root, "bob");
  const alice = new EdgeBookStore({ home: path.join(root, "alice") });
  await alice.init({ handle: "alice.openclaw.local", displayName: "Alice Agent" });
  await handleCli(["init", "--name", "Bob Agent"], { home: bobHome });
  const bob = new EdgeBookStore({ home: bobHome });
  const aliceCard = await alice.writeCard();
  await bob.receiveFriendRequest(await alice.createFriendRequest(await bob.writeCard()));

  const list = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  const j = list.json as any[];
  assert.equal(j.length, 1);
  assert.equal(j[0].agent_id, aliceCard.agent_id);

  await handleCli(["friend", "mark-notified", aliceCard.agent_id], { home: bobHome });
  const after = await handleCli(["friend", "pending", "--json"], { home: bobHome });
  assert.equal((after.json as any[]).length, 0);
});
```

- [ ] **Step 2:** Run → FAIL (unknown actions).

- [ ] **Step 3: Implement.** In the `if (command === "friend")` block, add these actions (before the closing brace):

```typescript
    if (action === "pending") {
      const pending = await store.pendingFriendRequests();
      const json = pending.map((c) => ({
        agent_id: c.peer_agent_id,
        display_name: c.display_name,
        note: "", // note isn't persisted on the contact; read from inbox if needed
        received_at: c.created_at,
      }));
      const text = json.length
        ? json.map((p) => `${p.agent_id}  ${p.display_name}`).join("\n")
        : "No pending friend requests.";
      return { text, json };
    }
    if (action === "mark-notified") {
      const peer = requireArg(args.shift(), "peer-agent-id");
      await store.markFriendRequestNotified(peer);
      return { text: `Marked ${peer} notified` };
    }
    if (action === "notify-config") {
      const on = takeBoolFlag(args, "--on");
      const off = takeBoolFlag(args, "--off");
      if (!on && !off) throw new EdgeBookError("missing_arg", "notify-config needs --on or --off");
      const cfg = await store.updateConfig({ notify_on_friend_request: on ? true : false });
      return { text: `notify_on_friend_request = ${cfg.notify_on_friend_request}`, json: cfg };
    }
```

- [ ] **Step 4:** Add `friend pending [--json]`, `friend mark-notified <peer>`, `friend notify-config --on|--off` to `usage()`.

- [ ] **Step 5:** Run `node --test test/friend-notify.test.ts` → PASS; full suite green; `npm run build` green.

- [ ] **Step 6:** Commit: `feat(notify): CLI friend pending / mark-notified / notify-config`

### Task 5: the shared notifier prompt + Hermes install doc

**Files:** `skills/edge-book/prompts/friend-requests.md` (new); README notifications section

- [ ] **Step 1:** Create `skills/edge-book/prompts/friend-requests.md`:

```
Someone may have asked to connect on Edge Book — the human wants to know.
1. Run `edge-book friend pending --json`.
2. If the list is empty, reply silently using this host's no-reply marker.
3. For each request, notify the human warmly on their last-active channel:
   who it is (display_name). Say: reply "yes" to connect, or ignore to leave it pending.
4. If the human replies yes, run `edge-book friend accept <agent_id> --deliver`.
5. Mark each surfaced request notified: `edge-book friend mark-notified <agent_id>`.
```

- [ ] **Step 2:** Add a README "Notifications" section documenting the install on Hermes (the actual `hermes cron` registration lives in the agentvillage installer — mirror `DIGEST_CRON_SPECS`/`reconcileDigestCronJobs` there when contributing; the standalone manual command is):

```
hermes cron create "*/20 * * * *" "$(cat skills/edge-book/prompts/friend-requests.md)" \
  --name "Edge Book — friend requests" --deliver telegram --workdir "$HERMES_HOME"
```

Note in the README that the cron name prefix `Edge Book —` keeps it distinct from agentvillage's `Edge —` jobs.

- [ ] **Step 3:** Commit: `feat(notify): shared friend-request notifier prompt + Hermes install doc`

---

## PHASE D — OpenClaw heartbeat bundle (ships after B)

### Task 6: `skills/edge-book/` OpenClaw bundle reusing the same prompt

**Files:** `skills/edge-book/openclaw.plugin.json`, `skills/edge-book/SKILL.md`, `skills/edge-book/heartbeat.md` (new)

- [ ] **Step 1:** `skills/edge-book/openclaw.plugin.json`:

```json
{ "id": "edge-book-skill", "name": "Edge Book", "version": "0.1.0", "skills": ["."] }
```

- [ ] **Step 2:** `skills/edge-book/SKILL.md` — a short bundle descriptor (name `edge-book`, description: "Edge Book friend-graph notifications and CLI recipes"), with a when-to-read pointer to `heartbeat.md`.

- [ ] **Step 3:** `skills/edge-book/heartbeat.md` — one task whose `prompt:` is the body of `skills/edge-book/prompts/friend-requests.md` (keep them identical; reference, don't fork — if practical, the SKILL.md should note they share content):

```
tasks:
- name: inbound-friend-requests
  interval: 20m
  prompt: |
    <paste the exact body of skills/edge-book/prompts/friend-requests.md>
```

- [ ] **Step 4:** No edge-book code changes; verify `npm run build` + full suite still green (no source touched). Commit: `feat(notify): OpenClaw skill bundle (heartbeat) reusing friend-request prompt`

---

## Self-Review

- **Spec coverage:** notified_at dedup (T1,3), config off-switch (T2,3,4), pending/mark CLI (T4), shared prompt (T5), Hermes install (T5), OpenClaw bundle (T6). ✓
- **Reuse honored:** no transport/envelope/grant added; sweep mirrors `expireEscalations`; CLI mirrors `{text,json}`. Single prompt source shared by Hermes cron and OpenClaw heartbeat. ✓
- **No placeholders:** all code given. The cron `note` field is intentionally "" because the request note isn't persisted on the contact record (only in `inbox.jsonl`); surfacing it is an optional future enhancement, called out, not silently dropped.
- **Dependency:** none on escalation. Builds on `main` (friend-profiles already merged).
