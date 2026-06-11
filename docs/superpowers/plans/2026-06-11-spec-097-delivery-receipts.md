# Delivery Receipts (spec-097 / ea-claude-130) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the "Dispatched successfully" lie. The sender learns at send time whether the recipient's agent is connected (`recipient_live` on `mailbox_send_ok`), and at any later time can ask the host for per-message truth (`mailbox_status`: queued / delivered / acked / unknown) via a local outbox ledger and a new `edge-book outbox` command — making a June-9-style stale queue self-diagnosing without `fly ssh`.

**Architecture:** Host side: `StoredMailboxMessage` gains a host-internal `delivered_at` stamp (set by a new `markDelivered` store method called from `deliverQueued`), authorized acks are recorded into a new bounded `receipts` ledger in `state.json` before deletion, and the recipient→live-channel resolution is extracted into `resolveLiveChannel()` shared by `mailbox_send` (liveness answer computed before the ack), `mailbox_status` (sender-only auth, fail closed to `unknown`), and `deliverQueued`. CLI side: every successful `--deliver` appends to a 200-entry `outbox.json` JSON array via one shared `deliverViaMailboxRecorded` helper that also renders honest Sent/Queued/legacy wording; `edge-book outbox` opens one transient connection, sends a single `mailbox_status` (≤50 newest ids), and degrades to local-only output on the old-host error frame (fast path) or RPC timeout (lost-frame path).

**Tech stack:**
- **Host repo** (`~/claude/edge-book-host`): TypeScript ESM with **`.js`-suffix relative imports** (compiled style, run via `tsx`), `node:test` via `tsx --test`, **test files are explicitly listed in `package.json` `test` script** (new files MUST be registered there), `npm run lint` = `eslint` (flat config, whole repo).
- **CLI repo** (`~/claude/edge-book-cli`): TypeScript ESM with **`.ts`-suffix relative imports**, `npm test` = `node --test test/*.test.ts` (glob auto-discovers new test files), `npm run lint` = `eslint src` (tests not linted, but keep them clean), `npm run typecheck` = `tsc -p . --noEmit`, README autosync (`npm run sync-readme` to regenerate, `npm run sync-readme:check` as gate; `test/commands-doc.test.ts` has a drift guard that fails if a `command === "..."` appears in `cli.ts` without a `COMMAND_GROUPS` row).

**Spec:** `~/claude/edge-book-cli/docs/spec-097-delivery-receipts.md` (judge-approved, normative — §A relay state, §B wire protocol, §C sender CLI, §D compatibility/rollout).

**Repos + branches (TWO repos, coordinated):**
- Host: `~/claude/edge-book-host`, branch `feat/097-receipts` (`cd ~/claude/edge-book-host && git checkout main && git pull && git checkout -b feat/097-receipts`)
- CLI: `~/claude/edge-book-cli`, branch `feat/097-receipts` (`cd ~/claude/edge-book-cli && git checkout main && git pull && git checkout -b feat/097-receipts`)

**ROLLOUT ORDER IS NORMATIVE (spec §D):** the host PR merges and deploys to Fly **BEFORE** the CLI publishes to npm. All changes are additive in both directions (old client + new host: extra field ignored, RPC unused; new client + old host: field absent → legacy wording, `mailbox_status` → error-frame/timeout → graceful local-only outbox), but the only order in which nobody ever sees a regression is host-first. Do host tasks H1–H4 first, then CLI tasks C1–C6; Task C6 contains the deploy→publish checklist.

**Key wiring facts (verified against source — do not re-derive):**
- Host unknown-frame branch (`src/channels.ts:364-366`) **already echoes `ref`**: `this.send(ws, { type: "error", error: "unknown_message_type", ref: typeof type === "string" ? type : null })`. So a deployed OLD host answers a `mailbox_status` frame with `{type:"error", error:"unknown_message_type", ref:"mailbox_status"}` — the spec's fast-path degradation signal is real. (Spec §C.3 says this error frame "falls through unhandled in handleMessage (dialout.ts:442)" — in fact dialout.ts:442 explicitly swallows it with `if (frameType === "error") return;`. Same net effect — the pending RPC times out — and this plan replaces that line.)
- CLI pending-RPC mechanism (`src/dialout.ts`): THREE maps. `pendingSessionRevokes` (legacy, sessions_revoke only, line 120), `pendingMailboxSends` (mailbox_send_ok/err, line 131), and the **generic `pendingRpc`** (line 126) keyed by `request_id`, fed by `private rpc(type, extra, expect, timeoutMs)` (line 194-205) which times out with `EdgeBookError("host_rpc_timeout", ...)`. Frames resolve `pendingRpc` only through the type-whitelist at line 391 (`sessions_list_ok` / `session_revoke_one_ok`). `mailbox_status` piggybacks on `pendingRpc`/`rpc()`: add the two new types to the whitelist, add `rpcType` to the map entries so the request_id-less old-host `error` frame can reject pending entries **by type**.
- Host `mailbox_send` handler (`src/channels.ts:301-322`) sends `mailbox_send_ok` and *then* calls `deliverQueued(to)` — liveness must be computed before the ack send (spec §B.1 normative ordering).
- Host `deliverQueued` (`src/channels.ts:396-419`) does the recipient resolution inline (channel_id lookup, then DID-alias scan over the in-memory `channels` Map) and only then `primaryConn()`. `resolveLiveChannel` extracts both steps; the store has **no** liveness concept.
- `mailboxForRecipient` (`src/store.ts:168-177`) strips host-internal fields via `out.map(({ expires_at: _omit, ...wire }) => wire)` — `delivered_at` joins that strip list (spec §A.1 normative), which is exactly why the stamp must be a store method (`markDelivered`) writing `state.mailbox[id]` directly, not a write to the returned wire objects.
- `mailbox_ack` auth (`src/channels.ts:326-342`) checks `peekMailboxRecipient(id)` against `channel.channel_id` / `channel.agent_did` BEFORE calling `store.ackMailbox(id)` — so receipt recording can live inside `ackMailbox` (it only runs post-auth) and stays correct for the purge path (purge deletes without ack → no receipt, state becomes `unknown`, which is right).
- `store.purge()` (`src/store.ts:140-154`) takes `now: number = Date.now()` — the receipts-TTL loop joins it and is directly testable with a future `now`.
- Host test registration: `package.json` `test` script is an explicit file list — `test/mailbox-receipts.test.ts` must be appended to it.
- CLI `--deliver` mailbox call sites (ALL go through `deliverEnvelopeViaMailbox`): `src/cli-social.ts` lines 68 (friend request), 89 (friend accept), 106 (friend apply-response), 169 (friend auto-accept loop), 217 (object share), 229 (object revoke), 298 (escalation raise), 322 (escalation answer); plus `broadcastPost` in `src/cli-shared.ts:110-125` (post broadcast). One shared helper (`deliverViaMailboxRecorded` in cli-shared.ts) records the outbox entry and renders wording so all NINE sites record without nine copies.
- `MessageEnvelope` (cli `src/types.ts:326-339`) carries `type` and `to_agent_id` — everything the outbox entry needs. `EdgeBookStore.home` is public (`edge-book.ts:63`). Contacts are keyed by `peer_agent_id` and carry `display_name` (used by `deliverToPeer`, cli-shared.ts:92-103).
- CLI house JSON helpers (`src/fs-json.ts`): `readJson(file, fallback)` (ENOENT→fallback, retry-on-SyntaxError), `writeJson(file, value)` (atomic temp+rename), `resolveHome(home?)` (arg > `EDGE_BOOK_HOME` > `~/.openclaw/edge-book`), `now()` (ISO). `outbox.json` registers in `src/store-files.ts` (the persisted-format registry) as a sibling of `identity.json`/`candidates.json` etc.
- `EDGE_BOOK_STALE_QUEUE_MS` parsing lives in `src/store-outbox.ts` (`staleQueueMs()`), next to the ledger it judges — single owner, env-tunable, default 10 minutes.
- `edge-book outbox` is a new top-level `if (command === "outbox")` branch in `handleCli`'s flat if-chain (`src/cli.ts`, insert after the `sessions` block ~line 186); it MUST get a `COMMAND_GROUPS` row in `src/commands-doc.ts` or the drift guard fails.
- CLI fakes: `test/mvp-mailbox.test.ts:16-78` `FakeMailboxHost`/`FakeSocket`. Do NOT modify that file — `test/outbox.test.ts` defines extended copies (`FakeStatusHost` with `recipient_live` on send acks, a `mailbox_status` handler, and three modes: `receipts` / `legacy-error` / `legacy-silent`).

**Spec test list → task map** (every bullet from spec "Tests"):
- Host: `recipient_live` false/true on send → **H2**; sender `mailbox_status` queued→delivered→acked + random-id unknown → **H2** (keystone-extended); third-agent + recipient auth → unknown → **H2**; restart-safety (receipt + `delivered_at` survive reload) → **H1**; ledger bounds (TTL purge, cap eviction) → **H1**; `/metrics` shape unchanged (existing observability tests stay green) → **H3/H4 gates** (+ additive `receipts_ledger_size` test in **H3**).
- CLI: `--deliver` vs `recipient_live:false` → Queued/NOT connected/never Delivered + ledger entry → **C3**; `recipient_live:true` → Sent wording → **C3**; old-host shape → legacy wording + `outbox` exits 0 with unknown states → **C3/C5**; `outbox` stale-queued → loud warning + `--json` round-trip → **C4**; outbox cap 201→200 → **C1**; old-host error-frame fast path (no timeout wait) → **C5**.
- End-to-end offline→reconnect→ack with status at each stage → **H2** (host repo, TestAgent pattern, per spec). Live verification against the deployed host → **C6** acceptance checklist.

---

## HOST TASKS (repo: `~/claude/edge-book-host`, branch `feat/097-receipts`)

## Task H1: Store — `delivered_at`, receipts ledger (record/lookup/purge/cap), strip list

**Files:**
- Modify: `src/store.ts` (StoredMailboxMessage ~line 65, State ~line 77, EMPTY ~line 88, `load()` ~line 113, `purge()` ~line 140, `mailboxForRecipient` strip ~line 176, `ackMailbox` ~line 186; new methods after `ackMailbox`)
- Create: `test/mailbox-receipts.test.ts` (store-unit half; H2 appends the wire half)
- Modify: `package.json` (append `test/mailbox-receipts.test.ts` to the `test` script file list)

**Steps:**

- [ ] **Write the failing store-unit tests.** Create `test/mailbox-receipts.test.ts`:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostStore } from "../src/store.js";

// ── spec-097 Part 1: store-unit tests (delivered_at + receipts ledger) ───────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ebh-receipts-"));
}

const TTL_MS = 60_000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function enqueue(store: HostStore, id: string, ts: number): void {
  store.enqueueMailbox({ id, to: "chan-B", from: "chan-A", blob: "AA==", ts }, TTL_MS);
}

test("markDelivered stamps delivered_at once; redelivery does not move it", () => {
  const store = new HostStore(tmpDir());
  enqueue(store, "m1", 1000);
  store.markDelivered("m1", 2000);
  store.markDelivered("m1", 3000); // redelivery on reconnect — first write wins
  assert.equal(store.getMailboxMessage("m1")?.delivered_at, 2000);
  // Unknown id is a safe no-op.
  store.markDelivered("nope", 2000);
});

test("wire shape from mailboxForRecipient never carries delivered_at or expires_at", () => {
  const store = new HostStore(tmpDir());
  enqueue(store, "m1", 1000);
  store.markDelivered("m1", 2000);
  const wire = store.mailboxForRecipient("chan-B", null, 1500);
  assert.equal(wire.length, 1);
  assert.ok(!("delivered_at" in wire[0]!), "delivered_at stripped from wire shape");
  assert.ok(!("expires_at" in wire[0]!), "expires_at stripped from wire shape");
});

test("ackMailbox records a receipt {acked_at,to,from} before deleting the message", () => {
  const store = new HostStore(tmpDir());
  enqueue(store, "m1", 1000);
  const to = store.ackMailbox("m1", 5000);
  assert.equal(to, "chan-B");
  assert.equal(store.getMailboxMessage("m1"), null, "message deleted on ack");
  assert.deepEqual(store.getReceipt("m1"), { acked_at: 5000, to: "chan-B", from: "chan-A" });
  assert.equal(store.receiptsCount(), 1);
  // Duplicate ack stays a no-op and does not resurrect or re-stamp.
  assert.equal(store.ackMailbox("m1", 9000), null);
  assert.equal(store.getReceipt("m1")?.acked_at, 5000);
});

test("restart-safety: acked receipt and delivered_at survive a store reload", () => {
  const dir = tmpDir();
  const store = new HostStore(dir);
  enqueue(store, "m-acked", 1000);
  enqueue(store, "m-pushed", 1000);
  store.ackMailbox("m-acked", 5000);
  store.markDelivered("m-pushed", 6000);
  store.flushNow();
  const reloaded = new HostStore(dir);
  assert.deepEqual(reloaded.getReceipt("m-acked"), { acked_at: 5000, to: "chan-B", from: "chan-A" });
  assert.equal(reloaded.getMailboxMessage("m-pushed")?.delivered_at, 6000);
});

test("receipts ledger TTL: purge drops entries older than EDGE_BOOK_RECEIPT_TTL_MS (default 7d)", () => {
  const store = new HostStore(tmpDir());
  const now = Date.now();
  enqueue(store, "m-old", now);
  enqueue(store, "m-new", now);
  store.ackMailbox("m-old", now);
  store.ackMailbox("m-new", now + SEVEN_DAYS); // acked much later — survives the sweep below
  store.purge(now + SEVEN_DAYS + 1);
  assert.equal(store.getReceipt("m-old"), null, "expired receipt purged");
  assert.ok(store.getReceipt("m-new"), "fresh receipt survives");
});

test("receipts ledger cap: insert over 10_000 evicts the oldest by acked_at", () => {
  const store = new HostStore(tmpDir());
  for (let i = 0; i <= 10_000; i++) {
    enqueue(store, `m${i}`, i);
    store.ackMailbox(`m${i}`, i); // acked_at = i — strictly increasing order
  }
  assert.equal(store.receiptsCount(), 10_000, "ledger held at cap");
  assert.equal(store.getReceipt("m0"), null, "oldest entry evicted");
  assert.ok(store.getReceipt("m10000"), "newest entry present");
});
```

- [ ] **Register the file + run red.** In `package.json`, append ` test/mailbox-receipts.test.ts` to the end of the `test` script's file list. Then:

```bash
cd ~/claude/edge-book-host && npx tsx --test test/mailbox-receipts.test.ts
```

Expected failure: TypeScript/runtime errors — `store.markDelivered is not a function`, `store.getMailboxMessage is not a function`, `store.getReceipt is not a function` (the methods don't exist yet).

- [ ] **Implement.** In `src/store.ts`:

After the imports (line 15), add the bounds constants:

```ts
// Receipts ledger bounds (spec-097): acked entries expire after the TTL
// (purged by the existing purge() sweep) and the ledger is capped at insert
// time — Record carries no order, so eviction sorts by acked_at.
const RECEIPT_TTL_MS = Number(process.env.EDGE_BOOK_RECEIPT_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
const RECEIPT_CAP = Number(process.env.EDGE_BOOK_RECEIPT_CAP) || 10_000;
```

Extend `StoredMailboxMessage` (line 65-67):

```ts
export interface StoredMailboxMessage extends MailboxMessage {
  expires_at: number;
  // Epoch ms of the FIRST mailbox_deliver push (spec-097). Absent = never
  // pushed to a live socket. Host-internal — stripped from wire shapes
  // alongside expires_at. At-least-once redelivery keeps the first stamp.
  delivered_at?: number;
}
```

After `HandleRecord` (line 75), add:

```ts
// What survives an ack (spec-097): enough for the SENDER (`from` is the
// channel_id the host stamped at enqueue) to learn "acked", nothing more.
export interface ReceiptEntry {
  acked_at: number;
  to: string;
  from: string;
}
```

In `interface State` (line 77-86), after `handles`:

```ts
  // Receipts ledger keyed by mailbox message id (spec-097). Survives restart.
  receipts: Record<string, ReceiptEntry>;
```

In `EMPTY` (line 88-95), add `receipts: {}`. In `load()` (line 113-120), add `receipts: parsed.receipts || {}`.

In `purge()` (line 140-154), after the mailbox loop:

```ts
    for (const [k, v] of Object.entries(this.state.receipts)) {
      if (v.acked_at + RECEIPT_TTL_MS <= now) delete this.state.receipts[k];
    }
```

In `mailboxForRecipient` (line 176), extend the strip list:

```ts
    // Strip the host-internal fields — the wire shape is {id,to,from,blob,ts}.
    return out.map(({ expires_at: _omit, delivered_at: _omit2, ...wire }) => wire);
```

Replace `ackMailbox` (line 186-192) with:

```ts
  // Delete a delivered+acked message. Returns the channel it was addressed to,
  // or null if unknown (idempotent — a duplicate ack is a no-op). Records the
  // receipt BEFORE the delete (spec-097) so the sender can still see "acked".
  // Caller (channels.ts mailbox_ack) has already verified the acker is the
  // addressed recipient — this method assumes an authorized ack.
  ackMailbox(id: string, now: number = Date.now()): string | null {
    const m = this.state.mailbox[id];
    if (!m) return null;
    this.state.receipts[id] = { acked_at: now, to: m.to, from: m.from };
    this.enforceReceiptCap();
    delete this.state.mailbox[id];
    this.scheduleFlush();
    return m.to;
  }
```

After `ackMailbox`, add the new methods:

```ts
  // Stamp the FIRST delivery push (spec-097). First write wins — redelivery on
  // reconnect must not move the timestamp. Writes state.mailbox[id] directly
  // because mailboxForRecipient returns stripped wire copies.
  markDelivered(id: string, now: number = Date.now()): void {
    const m = this.state.mailbox[id];
    if (!m || m.delivered_at !== undefined) return;
    m.delivered_at = now;
    this.scheduleFlush();
  }

  // Read one queued message in its host-internal shape (mailbox_status lookups).
  getMailboxMessage(id: string): StoredMailboxMessage | null {
    return this.state.mailbox[id] ?? null;
  }

  getReceipt(id: string): ReceiptEntry | null {
    return this.state.receipts[id] ?? null;
  }

  receiptsCount(): number {
    return Object.keys(this.state.receipts).length;
  }

  // Cap enforcement at insert time (spec-097 §A.2): when over cap, sort by
  // acked_at ascending and delete oldest until at cap.
  private enforceReceiptCap(): void {
    if (Object.keys(this.state.receipts).length <= RECEIPT_CAP) return;
    const entries = Object.entries(this.state.receipts);
    entries.sort((a, b) => a[1].acked_at - b[1].acked_at);
    for (let i = 0; i < entries.length - RECEIPT_CAP; i++) {
      const entry = entries[i];
      if (entry) delete this.state.receipts[entry[0]];
    }
  }
```

- [ ] **Green:**

```bash
cd ~/claude/edge-book-host && npx tsx --test test/mailbox-receipts.test.ts && npm run typecheck
```

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-host && git add src/store.ts test/mailbox-receipts.test.ts package.json && git commit -m "feat(receipts): delivered_at stamp + bounded receipts ledger in HostStore (spec-097 A)"
```

---

## Task H2: Channels — `resolveLiveChannel`, `recipient_live` on send ack, `mailbox_status` RPC with sender-only auth

**Files:**
- Modify: `src/channels.ts` (constant near line 27; `mailbox_send` handler 301-322; new `mailbox_status` handler after the `mailbox_ack` block ending line 343; `deliverQueued` 396-419; `resolveLiveChannel` next to `primaryConn` ~line 428)
- Modify: `test/mailbox-receipts.test.ts` (append the wire-level half)

**Steps:**

- [ ] **Write the failing wire tests.** Append to `test/mailbox-receipts.test.ts` (after the H1 unit tests). Note the shared-server pattern from `mailbox.test.ts`: helper server is a singleton per test file/process; assert per-id via `store.getMailboxMessage`/`getReceipt`, never via absolute `mailboxCount()`.

```ts
// ── spec-097 Part 2: wire-level tests (TestAgent pattern, mailbox.test.ts) ───
import { WebSocket } from "ws";
import { startServer, store } from "./helpers.js";

let serverCtx: Awaited<ReturnType<typeof startServer>> | null = null;
test.before(async () => { serverCtx = await startServer(); });
after(async () => { if (serverCtx) await serverCtx.close(); });

const KEY_A = "ed25519:receipts-A-fixed";
const KEY_B = "ed25519:receipts-B-fixed";
const KEY_C = "ed25519:receipts-C-fixed";

interface StatusEntry { id: string; state: string; queued_ms?: number; recipient_live?: boolean }
interface SendAck { id: string; recipient_live?: boolean }

// mailbox.test.ts TestAgent extended for spec-097: captures recipient_live on
// send acks and speaks the mailbox_status RPC pair.
class ReceiptAgent {
  ws: WebSocket;
  channel_id = "";
  delivers: Array<{ id: string }> = [];
  sendAcks = new Map<string, SendAck>();
  sendErrs = new Map<string, string>();
  statusOks = new Map<string, StatusEntry[]>();
  statusErrs = new Map<string, string>();
  private waiters: Array<() => void> = [];

  private constructor(ws: WebSocket) { this.ws = ws; }

  static async connect(wsUrl: string, agent_key: string, agent_did?: string): Promise<ReceiptAgent> {
    const ws = new WebSocket(wsUrl);
    const agent = new ReceiptAgent(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString()) as Record<string, unknown>;
        switch (f.type) {
          case "hello_ok":
            agent.channel_id = String(f.channel_id);
            resolve();
            break;
          case "hello_err":
            reject(new Error(String(f.error || "hello_failed")));
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "mailbox_deliver":
            agent.delivers.push({ id: String(f.id) });
            agent.wake();
            break;
          case "mailbox_send_ok":
            agent.sendAcks.set(String(f.request_id), {
              id: String(f.id),
              recipient_live: typeof f.recipient_live === "boolean" ? f.recipient_live : undefined
            });
            agent.wake();
            break;
          case "mailbox_send_err":
            agent.sendErrs.set(String(f.request_id), String(f.error));
            agent.wake();
            break;
          case "mailbox_status_ok":
            agent.statusOks.set(String(f.request_id), f.statuses as StatusEntry[]);
            agent.wake();
            break;
          case "mailbox_status_err":
            agent.statusErrs.set(String(f.request_id), String(f.error));
            agent.wake();
            break;
        }
      });
      ws.once("open", () => {
        const hello: Record<string, unknown> = { type: "hello", agent_key, version: "test", nonce: "n" };
        if (agent_did) hello.agent_did = agent_did;
        ws.send(JSON.stringify(hello));
      });
      ws.once("error", reject);
    });
    return agent;
  }

  private wake(): void { this.waiters.splice(0).forEach((w) => w()); }

  private async until(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 25); });
    }
  }

  async sendMailbox(to: string, plaintext: string, request_id: string): Promise<SendAck> {
    this.ws.send(JSON.stringify({ type: "mailbox_send", request_id, to, blob_b64: Buffer.from(plaintext, "utf8").toString("base64") }));
    await this.until(() => this.sendAcks.has(request_id) || this.sendErrs.has(request_id), `send_ok ${request_id}`);
    const err = this.sendErrs.get(request_id);
    if (err) throw new Error(err);
    return this.sendAcks.get(request_id)!;
  }

  async status(ids: string[], request_id: string): Promise<StatusEntry[]> {
    this.ws.send(JSON.stringify({ type: "mailbox_status", request_id, ids }));
    await this.until(() => this.statusOks.has(request_id) || this.statusErrs.has(request_id), `status_ok ${request_id}`);
    const err = this.statusErrs.get(request_id);
    if (err) throw new Error(err);
    return this.statusOks.get(request_id)!;
  }

  async waitDelivers(n: number): Promise<void> { await this.until(() => this.delivers.length >= n, `${n} delivers`); }
  ack(id: string): void { this.ws.send(JSON.stringify({ type: "mailbox_ack", id })); }
  close(): void { this.ws.close(); }
}

test("mailbox_send_ok reports recipient_live=false for an offline recipient, true for an online one", async () => {
  const { wsUrl } = await startServer();
  // B connects once to register its channel, then goes offline.
  const b1 = await ReceiptAgent.connect(wsUrl, KEY_B);
  const channelB = b1.channel_id;
  b1.close();
  await new Promise((r) => setTimeout(r, 50));

  const a = await ReceiptAgent.connect(wsUrl, KEY_A);
  const offlineAck = await a.sendMailbox(channelB, "to-offline-B", "rl-1");
  assert.equal(offlineAck.recipient_live, false, "B is offline at enqueue time");

  const c = await ReceiptAgent.connect(wsUrl, KEY_C);
  const onlineAck = await a.sendMailbox(c.channel_id, "to-online-C", "rl-2");
  assert.equal(onlineAck.recipient_live, true, "C is connected at enqueue time");

  a.close(); c.close();
});

// ── KEYSTONE EXTENDED (spec-097): offline → status=queued → reconnect+deliver
// → status=delivered → ack → status=acked + unknown for a random id ──────────
test("receipts keystone: sender's mailbox_status tracks queued → delivered → acked", async () => {
  const { wsUrl } = await startServer();
  const b1 = await ReceiptAgent.connect(wsUrl, KEY_B);
  const channelB = b1.channel_id;
  b1.close();
  await new Promise((r) => setTimeout(r, 50));

  const a = await ReceiptAgent.connect(wsUrl, KEY_A);
  const ack = await a.sendMailbox(channelB, "receipts-keystone", "rk-1");

  // queued: in the mailbox, never pushed.
  const s1 = await a.status([ack.id], "rk-st1");
  assert.equal(s1[0]!.state, "queued");
  assert.ok(s1[0]!.queued_ms! >= 0, "queued_ms present and non-negative");
  assert.equal(s1[0]!.recipient_live, false);

  // delivered: B reconnects → host pushes → no ack yet.
  const b2 = await ReceiptAgent.connect(wsUrl, KEY_B);
  await b2.waitDelivers(1);
  const s2 = await a.status([ack.id], "rk-st2");
  assert.equal(s2[0]!.state, "delivered");
  assert.ok(s2[0]!.queued_ms! >= 0);
  assert.equal(s2[0]!.recipient_live, true);

  // acked: gone from the mailbox, present in the ledger; optional fields omitted.
  b2.ack(ack.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.getMailboxMessage(ack.id), null, "acked message deleted from the mailbox");
  assert.ok(store.getReceipt(ack.id), "receipt recorded in the ledger");
  const s3 = await a.status([ack.id, "no-such-message-id"], "rk-st3");
  assert.equal(s3[0]!.state, "acked");
  assert.ok(!("queued_ms" in s3[0]!), "acked omits queued_ms (key absent, not null)");
  assert.ok(!("recipient_live" in s3[0]!), "acked omits recipient_live");
  assert.equal(s3[1]!.state, "unknown");
  assert.ok(!("queued_ms" in s3[1]!), "unknown omits queued_ms");

  a.close(); b2.close();
});

test("authorization fails closed: third agent AND the recipient both see unknown", async () => {
  const { wsUrl } = await startServer();
  const b1 = await ReceiptAgent.connect(wsUrl, KEY_B);
  const channelB = b1.channel_id;
  b1.close();
  await new Promise((r) => setTimeout(r, 50));

  const a = await ReceiptAgent.connect(wsUrl, KEY_A);
  const ack = await a.sendMailbox(channelB, "auth-probe", "auth-1");

  // Third agent C probing someone else's id learns nothing.
  const c = await ReceiptAgent.connect(wsUrl, KEY_C);
  const sc = await c.status([ack.id], "auth-st-c");
  assert.equal(sc[0]!.state, "unknown", "third party gets unknown, not the real state");

  // The RECIPIENT (non-sender) also gets unknown — only from === channel_id may read.
  const b2 = await ReceiptAgent.connect(wsUrl, KEY_B);
  await b2.waitDelivers(1); // delivered but NOT acked — still in the mailbox
  const sb = await b2.status([ack.id], "auth-st-b");
  assert.equal(sb[0]!.state, "unknown", "recipient gets unknown");

  // The sender still sees the truth.
  const sa = await a.status([ack.id], "auth-st-a");
  assert.equal(sa[0]!.state, "delivered");

  a.close(); b2.close(); c.close();
});

test("mailbox_status rejects malformed frames: missing ids, empty ids, >50 ids", async () => {
  const { wsUrl } = await startServer();
  const a = await ReceiptAgent.connect(wsUrl, KEY_A);

  a.ws.send(JSON.stringify({ type: "mailbox_status", request_id: "mf-1" })); // no ids
  a.ws.send(JSON.stringify({ type: "mailbox_status", request_id: "mf-2", ids: [] }));
  a.ws.send(JSON.stringify({ type: "mailbox_status", request_id: "mf-3", ids: Array.from({ length: 51 }, (_, i) => `x${i}`) }));
  const deadline = Date.now() + 2000;
  while (a.statusErrs.size < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.statusErrs.get("mf-1"), "invalid_mailbox_status");
  assert.equal(a.statusErrs.get("mf-2"), "invalid_mailbox_status");
  assert.equal(a.statusErrs.get("mf-3"), "invalid_mailbox_status");

  // Exactly 50 ids is accepted (bound is ≤50).
  const s = await a.status(Array.from({ length: 50 }, (_, i) => `x${i}`), "mf-4");
  assert.equal(s.length, 50);
  assert.ok(s.every((e) => e.state === "unknown"));

  a.close();
});
```

- [ ] **Red:**

```bash
cd ~/claude/edge-book-host && npx tsx --test test/mailbox-receipts.test.ts
```

Expected failures: `recipient_live` is `undefined` on send acks (assert.equal false/true fails); the `mailbox_status` frames are answered with `{type:"error", error:"unknown_message_type", ref:"mailbox_status"}` so `status()`/the malformed test time out (`timeout waiting for status_ok ...`).

- [ ] **Implement.** In `src/channels.ts`:

Near the other caps (after line 27 `MAILBOX_TTL_MS`):

```ts
// mailbox_status accepts at most this many ids per request (spec-097 §B.2).
const MAX_STATUS_IDS = 50;
```

Add `resolveLiveChannel` immediately above `primaryConn` (~line 428):

```ts
  // Resolve a recipient address (channel_id or DID alias) to a live channel
  // with an OPEN primary connection. Reads the in-memory `channels` Map — the
  // only place liveness exists (the store has no liveness concept). Shared by
  // the mailbox_send liveness answer, mailbox_status, and deliverQueued
  // (spec-097). Read-only.
  private resolveLiveChannel(recipient: string): { channel: Channel; primary: Connection } | undefined {
    let channel = this.channels.get(recipient);
    if (!channel) {
      for (const c of this.channels.values()) {
        if (c.agent_did === recipient) { channel = c; break; }
      }
    }
    if (!channel) return undefined;
    const primary = this.primaryConn(channel.channel_id);
    if (!primary) return undefined;
    return { channel, primary };
  }
```

Rewrite `deliverQueued` (line 396-419) to use it and stamp `delivered_at`:

```ts
  // Deliver every unacked queued envelope addressed to `recipient` (a channel_id
  // or DID alias) to its primary open connection, if any. No-op when offline —
  // messages stay queued and are redelivered on the recipient's next connect.
  // At-least-once: a message is deleted only when the recipient acks it.
  deliverQueued(recipient: string): number {
    const live = this.resolveLiveChannel(recipient);
    if (!live) return 0;
    const { channel, primary } = live;
    const queued = this.store.mailboxForRecipient(channel.channel_id, channel.agent_did);
    let sent = 0;
    for (const m of queued) {
      this.send(primary.ws, { type: "mailbox_deliver", id: m.id, from: m.from, blob_b64: m.blob, ts: m.ts });
      // Stamp the FIRST push (spec-097): "delivered" = written to a live socket
      // at least once. Redelivery keeps the first stamp (markDelivered no-ops).
      this.store.markDelivered(m.id);
      sent++;
    }
    if (sent) {
      logEvent("mailbox_deliver", { channel: cref(channel.channel_id), count: sent });
      this.counters.delivered += sent;
    }
    return sent;
  }
```

In the `mailbox_send` handler, replace lines 313-321 (from `const id = randomToken(12);` through `this.deliverQueued(to);`) with:

```ts
      const id = randomToken(12);
      const msg = { id, to, from: channel.channel_id, blob: blob_b64, ts: Date.now() };
      this.store.enqueueMailbox(msg, MAILBOX_TTL_MS);
      logEvent("mailbox_enqueue", { id, to: cref(to), from: cref(channel.channel_id) });
      this.counters.enqueued++;
      // Liveness answer (spec-097 §B.1, normative ordering): computed BEFORE
      // the ack is sent — deliverQueued below would race it otherwise.
      const recipient_live = this.resolveLiveChannel(to) !== undefined;
      this.send(ws, { type: "mailbox_send_ok", request_id, id, recipient_live });
      // Best-effort immediate delivery if the recipient is online. At-least-once
      // either way: the message stays queued until the recipient acks.
      this.deliverQueued(to);
      return;
```

Insert the `mailbox_status` handler after the `mailbox_ack` block (after line 343, before the `handle_claim` block):

```ts
    // Mailbox status (spec-097): the SENDER asks for per-message delivery state.
    // Fail closed: an id is reported only when the requesting channel's
    // channel_id equals the stored `from` (host-stamped at enqueue — never a
    // DID) — anyone else sees "unknown"; probing reveals nothing. For acked/
    // unknown, queued_ms and recipient_live are OMITTED (not null).
    if (type === "mailbox_status") {
      const request_id = String(frame.request_id || "");
      const ids = frame.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_STATUS_IDS || !ids.every((i) => typeof i === "string")) {
        this.send(ws, { type: "mailbox_status_err", request_id, error: "invalid_mailbox_status" });
        return;
      }
      const now = Date.now();
      const statuses = (ids as string[]).map((id) => {
        const queued = this.store.getMailboxMessage(id);
        if (queued && queued.from === channel.channel_id) {
          return {
            id,
            state: queued.delivered_at === undefined ? "queued" : "delivered",
            queued_ms: Math.max(0, now - queued.ts),
            recipient_live: this.resolveLiveChannel(queued.to) !== undefined
          };
        }
        const receipt = this.store.getReceipt(id);
        if (receipt && receipt.from === channel.channel_id) return { id, state: "acked" };
        return { id, state: "unknown" };
      });
      this.send(ws, { type: "mailbox_status_ok", request_id, statuses });
      return;
    }
```

- [ ] **Green (file + full suite — the keystone and observability tests must stay green):**

```bash
cd ~/claude/edge-book-host && npx tsx --test test/mailbox-receipts.test.ts && npm test && npm run typecheck
```

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-host && git add src/channels.ts test/mailbox-receipts.test.ts && git commit -m "feat(receipts): recipient_live on mailbox_send_ok + mailbox_status RPC with sender-only auth (spec-097 B)"
```

---

## Task H3: Wire-protocol doc + additive `receipts_ledger_size` metric

**Files:**
- Modify: `docs/wire-protocol.md` (mailbox section: `mailbox_send_ok` shape + new "Delivery receipts" subsection, before the "Revocation" heading)
- Modify: `src/channels.ts` (`ChannelMetrics` ~line 78, `metrics()` ~line 104)
- Modify: `src/server.ts` (`/metrics` handler ~line 405-414)
- Modify: `test/mailbox-receipts.test.ts` (one metrics test)

**Steps:**

- [ ] **Write the failing metrics test.** Append to `test/mailbox-receipts.test.ts`:

```ts
test("GET /metrics gains additive receipts_ledger_size and keeps the existing shape", async () => {
  const { baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/metrics`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(typeof body.connected_channels, "number");
  assert.equal(typeof body.mailbox_queue_depth, "number");
  assert.ok(body.deliveries && typeof body.deliveries === "object", "existing deliveries block unchanged");
  assert.equal(typeof body.receipts_ledger_size, "number", "additive receipts_ledger_size present");
});
```

- [ ] **Red:**

```bash
cd ~/claude/edge-book-host && npx tsx --test test/mailbox-receipts.test.ts
```

Expected failure: `receipts_ledger_size` is `undefined`, not a number.

- [ ] **Implement the metric.** In `src/channels.ts`, add to `ChannelMetrics` (after `mailbox_queue_depth: number;`):

```ts
  receipts_ledger_size: number;
```

and in `metrics()` (line 104-110), after `mailbox_queue_depth: this.store.mailboxCount(),`:

```ts
      receipts_ledger_size: this.store.receiptsCount(),
```

In `src/server.ts` `/metrics` handler (line 405-414), after `mailbox_queue_depth: m.mailbox_queue_depth,`:

```ts
        receipts_ledger_size: m.receipts_ledger_size,
```

- [ ] **Update `docs/wire-protocol.md`.** In the Mailbox section, replace the `mailbox_send_ok` block (the json + the line above it) with:

````markdown
Host → Agent A (durably enqueued; `from` was stamped by the host from A's
authenticated channel — a sender-supplied `from` inside the blob is NOT trusted
over it). `recipient_live` (spec-097) reports whether, at enqueue time, any
live channel claimed `to`; it is an enqueue-time snapshot, not a delivery
guarantee. Old hosts omit the field; old clients ignore it:
```json
{ "type": "mailbox_send_ok", "request_id": "<uuid>", "id": "<message_id>", "recipient_live": false }
```
````

Then insert a new subsection immediately before the `## Revocation` heading:

````markdown
## Delivery receipts (spec-097)

Per-message delivery state for the SENDER. Modeled on the `sessions_list`
request/response pair (correlated by `request_id`).

Agent → Host (≤ 50 ids per request):
```json
{ "type": "mailbox_status", "request_id": "<uuid>", "ids": ["<message_id>", "..."] }
```
Host → Agent:
```json
{ "type": "mailbox_status_ok", "request_id": "<uuid>", "statuses": [
  { "id": "...", "state": "queued",    "queued_ms": 0, "recipient_live": false },
  { "id": "...", "state": "delivered", "queued_ms": 0, "recipient_live": true },
  { "id": "...", "state": "acked" },
  { "id": "...", "state": "unknown" }
] }
```
or `{ "type": "mailbox_status_err", "request_id": "<uuid>", "error": "invalid_mailbox_status" }`
for a malformed frame (missing/empty/over-limit/non-string `ids`).

States: `queued` = in the mailbox, never pushed to a live socket. `delivered` =
pushed at least once but not acked (the push may have been lost — at-least-once
semantics, redelivery on reconnect still applies). `acked` = the recipient
acked; the message is deleted but a receipt survives in a bounded ledger
(`EDGE_BOOK_RECEIPT_TTL_MS`, default 7 days; cap `EDGE_BOOK_RECEIPT_CAP`,
default 10 000, oldest-evicted). `unknown` = neither (expired, evicted, never
existed — or not yours, see below). For `acked`/`unknown`, `queued_ms` and
`recipient_live` are ABSENT (key omitted, not null).

Authorization (fail closed): a status entry is returned only when the
requesting channel's `channel_id` equals the message's host-stamped `from`.
Anyone else — including the addressed recipient — gets `unknown` for that id;
probing reveals nothing. Known accepted limit: rotating the transport key
(`host-dialout-key.json`) changes the channel_id and forfeits visibility into
receipts for messages sent under the old key — receipts are a diagnostic
convenience, not durable history.

Compatibility: both changes are additive. A pre-receipts host answers
`mailbox_status` with the standard unknown-type error frame
(`{ "type": "error", "error": "unknown_message_type", "ref": "mailbox_status" }`);
clients MUST treat that — or an RPC timeout — as "host does not support
receipts" and degrade gracefully.
````

- [ ] **Green:**

```bash
cd ~/claude/edge-book-host && npx tsx --test test/mailbox-receipts.test.ts && npx tsx --test test/observability.test.ts && npm run typecheck
```

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-host && git add docs/wire-protocol.md src/channels.ts src/server.ts test/mailbox-receipts.test.ts && git commit -m "docs(receipts): wire-protocol mailbox_status + recipient_live; additive receipts_ledger_size metric (spec-097 B/D)"
```

---

## Task H4: Host gates — full suite, lint, typecheck

**Files:** none (verification only; fix anything that surfaces).

**Steps:**

- [ ] **Full suite** (proves the existing keystone `mailbox.test.ts` and `observability.test.ts` — the "/metrics unchanged shape" requirement — stay green alongside the new file):

```bash
cd ~/claude/edge-book-host && npm test
```

- [ ] **Lint + typecheck:**

```bash
cd ~/claude/edge-book-host && npm run lint && npm run typecheck
```

- [ ] If anything failed, fix and amend/commit with `fix(receipts): <what>`. Host branch is now ready for PR/merge/deploy — but **hold the deploy until C6** so it happens in the verified order with the live smoke.

---

## CLI TASKS (repo: `~/claude/edge-book-cli`, branch `feat/097-receipts`)

## Task C1: `src/store-outbox.ts` — the outbox ledger (JSON array, cap 200, stale threshold, age format)

**Files:**
- Create: `src/store-outbox.ts`
- Modify: `src/store-files.ts` (register `OUTBOX_FILE` in the persisted-format list, after `INBOUND_RATE_FILE`)
- Create: `test/outbox.test.ts` (ledger half; C2 adds the fakes, C3-C5 append)

**Steps:**

- [ ] **Write the failing tests.** Create `test/outbox.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OUTBOX_CAP, formatAge, readOutbox, recordOutboxEntry, staleQueueMs } from "../src/store-outbox.ts";

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-outbox-"));
}

// ── spec-097 C.1: outbox ledger ──────────────────────────────────────────────

test("recordOutboxEntry appends in order and readOutbox round-trips, including recipient_live", async () => {
  const home = await tempHome();
  await recordOutboxEntry(home, { id: "m0", to_agent_id: "did:openclaw:peer", envelope_type: "friend_request", recipient_live: false });
  await recordOutboxEntry(home, { id: "m1", to_agent_id: "did:openclaw:peer", envelope_type: "object_share", recipient_live: true });
  await recordOutboxEntry(home, { id: "m2", to_agent_id: "did:openclaw:peer", envelope_type: "object_share" }); // old host: no recipient_live
  const entries = await readOutbox(home);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.id, "m0");
  assert.equal(entries[0]!.recipient_live, false);
  assert.equal(entries[1]!.recipient_live, true);
  assert.ok(!("recipient_live" in entries[2]!), "absent field stays absent (old-host send)");
  assert.ok(entries[2]!.sent_at, "sent_at stamped");
  // outbox.json is a sibling of identity.json in the agent home.
  await fs.access(path.join(home, "outbox.json"));
});

test("outbox cap: the 201st entry evicts the oldest (drop-front)", async () => {
  const home = await tempHome();
  for (let i = 0; i <= OUTBOX_CAP; i++) {
    await recordOutboxEntry(home, { id: `m${i}`, to_agent_id: "did:openclaw:peer", envelope_type: "object_share" });
  }
  const entries = await readOutbox(home);
  assert.equal(entries.length, OUTBOX_CAP);
  assert.equal(entries[0]!.id, "m1", "m0 dropped from the front");
  assert.equal(entries[OUTBOX_CAP - 1]!.id, `m${OUTBOX_CAP}`);
});

test("staleQueueMs defaults to 10 minutes and honors EDGE_BOOK_STALE_QUEUE_MS", () => {
  const prev = process.env.EDGE_BOOK_STALE_QUEUE_MS;
  try {
    delete process.env.EDGE_BOOK_STALE_QUEUE_MS;
    assert.equal(staleQueueMs(), 10 * 60 * 1000);
    process.env.EDGE_BOOK_STALE_QUEUE_MS = "5000";
    assert.equal(staleQueueMs(), 5000);
    process.env.EDGE_BOOK_STALE_QUEUE_MS = "not-a-number";
    assert.equal(staleQueueMs(), 10 * 60 * 1000, "garbage falls back to the default");
  } finally {
    if (prev === undefined) delete process.env.EDGE_BOOK_STALE_QUEUE_MS;
    else process.env.EDGE_BOOK_STALE_QUEUE_MS = prev;
  }
});

test("formatAge renders seconds, minutes, hours, days", () => {
  assert.equal(formatAge(30_000), "30s");
  assert.equal(formatAge(5 * 60_000), "5m");
  assert.equal(formatAge(3 * 3_600_000), "3h");
  assert.equal(formatAge(2 * 86_400_000), "2d");
});
```

- [ ] **Red:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts
```

Expected failure: `Cannot find module '../src/store-outbox.ts'`.

- [ ] **Implement.** In `src/store-files.ts`, after the `INBOUND_RATE_FILE` line:

```ts
export const OUTBOX_FILE = "outbox.json"; // sender outbox ledger — JSON ARRAY, not keyed object (spec-097)
```

Create `src/store-outbox.ts`:

```ts
// Outbox ledger (spec-097): every successful --deliver records the host-assigned
// mailbox message id here so `edge-book outbox` can ask the host for per-message
// delivery state later — today the id is printed and lost. A JSON ARRAY
// (insertion-ordered; deliberately NOT the keyed-object house pattern, because
// cap eviction needs order), capped at OUTBOX_CAP by dropping the front.
import path from "node:path";
import { now, readJson, resolveHome, writeJson } from "./fs-json.ts";
import { OUTBOX_FILE } from "./store-files.ts";

export const OUTBOX_CAP = 200;
const DEFAULT_STALE_QUEUE_MS = 10 * 60 * 1000;

export interface OutboxEntry {
  /** Host-assigned mailbox message id (from mailbox_send_ok). */
  id: string;
  to_agent_id: string;
  envelope_type: string;
  /** ISO timestamp of the local send. */
  sent_at: string;
  /** Liveness answer from the send ack; absent against a pre-receipts host. */
  recipient_live?: boolean;
}

function outboxPath(home?: string): string {
  return path.join(resolveHome(home), OUTBOX_FILE);
}

export async function readOutbox(home?: string): Promise<OutboxEntry[]> {
  return readJson<OutboxEntry[]>(outboxPath(home), []);
}

// Append one entry, evicting from the FRONT beyond OUTBOX_CAP (oldest first).
export async function recordOutboxEntry(home: string | undefined, entry: Omit<OutboxEntry, "sent_at"> & { sent_at?: string }): Promise<void> {
  const entries = await readOutbox(home);
  entries.push({ sent_at: now(), ...entry });
  await writeJson(outboxPath(home), entries.slice(-OUTBOX_CAP));
}

// A message still `queued` past this threshold gets the loud stale warning
// (spec-097 §C.3 — the June 9 diagnosis, automated). Env-tunable.
export function staleQueueMs(): number {
  const raw = Number(process.env.EDGE_BOOK_STALE_QUEUE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_QUEUE_MS;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
```

- [ ] **Green:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts && npm run typecheck && npm run lint
```

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-cli && git add src/store-outbox.ts src/store-files.ts test/outbox.test.ts && git commit -m "feat(receipts): outbox.json ledger — ordered JSON array, cap 200 drop-front, stale threshold (spec-097 C.1)"
```

---

## Task C2: Dialout — surface `recipient_live`, `mailbox_status` RPC client (ok-frame + error-frame + timeout resolution)

**Files:**
- Modify: `src/dialout.ts` (new exported types after `MailboxDeliverFrame` ~line 87; `pendingRpc` map shape line 126-130; `rpc()` line 194-205; `pendingMailboxSends` line 131-135 + `sendMailbox` 224-236 + `sendEnvelope` 241-243; `handleMessage` whitelist line 391 + `mailbox_send_ok` handler 417-426 + the `error` swallow at line 442; new `mailboxStatusAndWait` method; new transient `mailboxStatus` helper after `revokeOneSession` ~line 579)
- Modify: `test/outbox.test.ts` (append fakes + dialout-level tests)

**Steps:**

- [ ] **Write the failing tests.** Append to `test/outbox.test.ts` (fakes first — these are the spec-mandated extension of the `mvp-mailbox.test.ts` FakeMailboxHost/FakeSocket pattern; that file is NOT modified):

```ts
// ── spec-097 fakes: FakeMailboxHost/FakeSocket (mvp-mailbox.test.ts pattern)
// extended with recipient_live on send acks and the mailbox_status RPC pair.
// Modes: "receipts" (new host), "legacy-error" (old host — echoes the wire-
// protocol unknown-type error frame, the REAL deployed behavior: edge-book-host
// channels.ts always echoed ref), "legacy-silent" (lost frame — forces the
// client timeout path).
import { EdgeBookDialoutClient, deliverEnvelopeViaMailbox, mailboxStatus } from "../src/dialout.ts";
import { EdgeBookStore, type MessageEnvelope } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";

type FakeHostMode = "receipts" | "legacy-error" | "legacy-silent";

class FakeStatusHost {
  channels = new Map<string, FakeSocket>(); // by channel_id AND agent_did
  queue: Array<{ id: string; to: string; from: string; blob_b64: string; ts: number }> = [];
  statuses = new Map<string, { state: string; queued_ms?: number; recipient_live?: boolean }>();
  liveRecipients = new Set<string>();
  statusRequests = 0;
  private seq = 0;

  constructor(public mode: FakeHostMode = "receipts") {}

  attach(socket: FakeSocket, channelId: string, agentDid: string): void {
    this.channels.set(channelId, socket);
    if (agentDid) this.channels.set(agentDid, socket);
    socket.host = this;
    this.deliver(channelId);
    if (agentDid) this.deliver(agentDid);
  }

  onSend(from: string, frame: { request_id: string; to: string; blob_b64: string }): void {
    const id = `m${this.seq++}`;
    this.queue.push({ id, to: frame.to, from, blob_b64: frame.blob_b64, ts: Date.now() });
    const ok: Record<string, unknown> = { type: "mailbox_send_ok", request_id: frame.request_id, id };
    if (this.mode === "receipts") {
      ok.recipient_live = this.liveRecipients.has(frame.to) || this.channels.has(frame.to);
    }
    this.channels.get(from)?.receive(ok);
    this.deliver(frame.to);
  }

  onStatus(from: string, frame: { request_id: string; ids: string[] }): void {
    this.statusRequests++;
    const socket = this.channels.get(from);
    if (!socket) return;
    if (this.mode === "legacy-silent") return;
    if (this.mode === "legacy-error") {
      // What a pre-receipts edge-book-host actually sends for an unknown type.
      socket.receive({ type: "error", error: "unknown_message_type", ref: "mailbox_status" });
      return;
    }
    const statuses = frame.ids.map((id) => ({ id, ...(this.statuses.get(id) ?? { state: "unknown" }) }));
    socket.receive({ type: "mailbox_status_ok", request_id: frame.request_id, statuses });
  }

  onAck(id: string): void {
    this.queue = this.queue.filter((m) => m.id !== id);
  }

  private deliver(to: string): void {
    const socket = this.channels.get(to);
    if (!socket) return;
    for (const m of this.queue.filter((q) => q.to === to)) {
      socket.receive({ type: "mailbox_deliver", id: m.id, from: m.from, blob_b64: m.blob_b64, ts: m.ts });
    }
  }
}

class FakeSocket {
  host?: FakeStatusHost;
  fromDid = "";
  channelId = "";
  listeners: Record<string, Array<(e?: unknown) => void>> = {};
  readyState = 1;

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.type === "hello") {
      this.fromDid = frame.agent_did || "";
      this.channelId = `chan-${this.fromDid}`;
      queueMicrotask(() => {
        this.receive({ type: "hello_ok", channel_id: this.channelId, server_time: new Date().toISOString() });
        this.host?.attach(this, this.channelId, this.fromDid);
      });
    }
    if (frame.type === "mailbox_send") this.host?.onSend(this.channelId, frame);
    if (frame.type === "mailbox_status") this.host?.onStatus(this.channelId, frame);
    if (frame.type === "mailbox_ack") this.host?.onAck(frame.id);
  }
  close(): void { this.emit("close"); }
  addEventListener(event: string, handler: (e?: unknown) => void): void { (this.listeners[event] ||= []).push(handler); }
  emit(event: string, value?: unknown): void { for (const h of this.listeners[event] || []) h(value); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

function factoryFor(host: FakeStatusHost): (url: string) => FakeSocket {
  return (_url: string) => { const s = new FakeSocket(); s.host = host; queueMicrotask(() => s.emit("open")); return s; };
}

// Two friended agent homes wired to one fake host (mvp-mailbox.test.ts setup).
async function friendedPair(host: FakeStatusHost): Promise<{ root: string; aliceHome: string; bobHome: string; bobId: string; factory: (url: string) => FakeSocket }> {
  const root = await tempHome();
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const bobStore = new EdgeBookStore({ home: bobHome });
  await aliceStore.init({ handle: "alice.local", ownerLabel: "Alice" });
  await bobStore.init({ handle: "bob.local", ownerLabel: "Bob" });
  const aliceCard = await aliceStore.writeCard();
  const bobCard = await bobStore.writeCard();
  await bobStore.receiveFriendRequest(await aliceStore.createFriendRequest(bobCard));
  await aliceStore.applyFriendResponse(await bobStore.acceptFriend(aliceCard.agent_id));
  const bobId = (await bobStore.identity()).agent_id;
  return { root, aliceHome, bobHome, bobId, factory: factoryFor(host) };
}

// ── spec-097 C.2: dialout client ─────────────────────────────────────────────

test("send ack surfaces recipient_live through deliverEnvelopeViaMailbox (false / true / absent)", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  // Recipient not connected and not in liveRecipients → false.
  const env1 = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack1 = await deliverEnvelopeViaMailbox({ home: aliceHome, host: "ws://fake", socketFactory: factory, envelope: env1 });
  assert.equal(ack1.recipient_live, false);

  // Host says the recipient is live → true.
  host.liveRecipients.add(bobId);
  const env2 = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack2 = await deliverEnvelopeViaMailbox({ home: aliceHome, host: "ws://fake", socketFactory: factory, envelope: env2 });
  assert.equal(ack2.recipient_live, true);

  // Old host omits the field → absent on the resolved ack.
  const legacyHost = new FakeStatusHost("legacy-error");
  const env3 = await aliceStore.shareObjectEnvelope(bobId, object.object_id);
  const ack3 = await deliverEnvelopeViaMailbox({ home: aliceHome, host: "ws://fake", socketFactory: factoryFor(legacyHost), envelope: env3 });
  assert.ok(ack3.id);
  assert.ok(!("recipient_live" in ack3), "old host: recipient_live absent, not false");
});

test("mailboxStatusAndWait resolves statuses from mailbox_status_ok", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, factory } = await friendedPair(host);
  host.statuses.set("m0", { state: "queued", queued_ms: 1234, recipient_live: false });
  host.statuses.set("m1", { state: "acked" });
  const statuses = await mailboxStatus({ home: aliceHome, host: "ws://fake", socketFactory: factory, ids: ["m0", "m1", "m2"] });
  assert.ok(statuses, "receipts host answers");
  assert.deepEqual(statuses![0], { id: "m0", state: "queued", queued_ms: 1234, recipient_live: false });
  assert.deepEqual(statuses![1], { id: "m1", state: "acked" });
  assert.deepEqual(statuses![2], { id: "m2", state: "unknown" });
});

test("old-host error frame (ref=mailbox_status) resolves the pending RPC to null FAST — no timeout wait", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, factory } = await friendedPair(host);
  const started = Date.now();
  // Default timeout is 5s; the error-frame fast path must beat it by a mile.
  const statuses = await mailboxStatus({ home: aliceHome, host: "ws://fake", socketFactory: factory, ids: ["m0"] });
  assert.equal(statuses, null, "degrades to local-only");
  assert.ok(Date.now() - started < 2000, `resolved in ${Date.now() - started}ms — error frame fast path, not the 5s timeout`);
  assert.equal(host.statusRequests, 1, "exactly one mailbox_status was attempted");
});

test("lost-frame path: a silent host resolves to null after the RPC timeout", async () => {
  const host = new FakeStatusHost("legacy-silent");
  const { aliceHome, factory } = await friendedPair(host);
  const statuses = await mailboxStatus({ home: aliceHome, host: "ws://fake", socketFactory: factory, ids: ["m0"], timeoutMs: 100 });
  assert.equal(statuses, null, "timeout degrades to local-only, same as the error frame");
});
```

- [ ] **Red:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts
```

Expected failures: `mailboxStatus` is not exported from `../src/dialout.ts` (SyntaxError on import); after stubbing nothing else, `recipient_live` assertions would also fail since `sendMailbox` resolves `{ id }` only.

- [ ] **Implement.** In `src/dialout.ts`:

After `MailboxDeliverFrame` (line 87), add the exported types:

```ts
// Resolved mailbox_send acknowledgement (spec-097). recipient_live reports
// whether any live channel claimed the recipient at enqueue time; absent when
// the host predates receipts.
export interface MailboxSendAck {
  id: string;
  recipient_live?: boolean;
}

// One entry from mailbox_status_ok (spec-097). queued_ms/recipient_live are
// present only for queued/delivered (key omitted otherwise).
export interface MailboxStatusEntry {
  id: string;
  state: "queued" | "delivered" | "acked" | "unknown";
  queued_ms?: number;
  recipient_live?: boolean;
}
```

Extend the generic RPC map (line 126-130) with the request type, so a
request_id-less old-host `error` frame can fail pending entries by type:

```ts
  // Generic request_id-keyed RPC waiters (sessions_list / session_revoke_one /
  // mailbox_status). rpcType lets an old host's {type:"error", ref:"<type>"}
  // frame — which carries NO request_id — reject pending requests of that type.
  private pendingRpc = new Map<string, {
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    rpcType: string;
  }>();
```

In `rpc()` (line 201), store it: replace
`this.pendingRpc.set(request_id, { resolve, reject, timer });` with

```ts
      this.pendingRpc.set(request_id, { resolve, reject, timer, rpcType: type });
```

Retype `pendingMailboxSends` (line 131-135):

```ts
  private pendingMailboxSends = new Map<string, {
    resolve: (ack: MailboxSendAck) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
```

Update `sendMailbox` (line 224-236) signature + promise type only — body otherwise unchanged:

```ts
  // Low-level: hand an opaque blob to the host for delivery to `to` (a peer DID
  // or channel_id). Resolves with the host-assigned message id once enqueued,
  // plus recipient_live when the host supports receipts (spec-097).
  async sendMailbox(to: string, blob: Buffer | Uint8Array, timeoutMs = 5_000): Promise<MailboxSendAck> {
    const request_id = crypto.randomUUID();
    const blob_b64 = Buffer.from(blob).toString("base64");
    const ack = new Promise<MailboxSendAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMailboxSends.delete(request_id);
        reject(new EdgeBookError("mailbox_send_timeout", "Timed out waiting for mailbox_send_ok"));
      }, timeoutMs);
      this.pendingMailboxSends.set(request_id, { resolve, reject, timer });
    });
    this.send({ type: "mailbox_send", request_id, to, blob_b64 });
    return ack;
  }
```

Update `sendEnvelope` (line 241-243) return type to `Promise<MailboxSendAck>` (body unchanged).

Add `mailboxStatusAndWait` after `revokeOneSessionAndWait` (line 190):

```ts
  // Ask the host for per-message delivery state (spec-097). Returns null when
  // the host predates receipts — detected by the unknown-type error frame
  // (fast path) or the RPC timeout (lost-frame path); both degrade the same.
  async mailboxStatusAndWait(ids: string[], timeoutMs = 5_000): Promise<MailboxStatusEntry[] | null> {
    try {
      const frame = await this.rpc("mailbox_status", { ids }, "mailbox_status_ok", timeoutMs);
      if ((frame as { type?: string }).type === "mailbox_status_err") {
        throw new EdgeBookError("mailbox_status_failed", String((frame as { error?: string }).error || "mailbox_status rejected"));
      }
      return ((frame as { statuses?: MailboxStatusEntry[] }).statuses) ?? [];
    } catch (error) {
      if (error instanceof EdgeBookError && (error.code === "host_rpc_timeout" || error.code === "host_unsupported_rpc")) return null;
      throw error;
    }
  }
```

In `handleMessage`, extend the generic-RPC whitelist (line 391) to:

```ts
    if ((frame as { type?: string }).type === "sessions_list_ok" || (frame as { type?: string }).type === "session_revoke_one_ok"
      || (frame as { type?: string }).type === "mailbox_status_ok" || (frame as { type?: string }).type === "mailbox_status_err") {
```

Update the `mailbox_send_ok` handler (line 417-426) to pass `recipient_live` through (absent stays absent — never coerce to false):

```ts
    if (frameType === "mailbox_send_ok") {
      const ack = frame as unknown as { request_id?: string; id?: string; recipient_live?: boolean };
      const pending = this.pendingMailboxSends.get(ack.request_id || "");
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMailboxSends.delete(ack.request_id || "");
        pending.resolve({
          id: ack.id || "",
          ...(typeof ack.recipient_live === "boolean" ? { recipient_live: ack.recipient_live } : {})
        });
      }
      return;
    }
```

Replace the `error` swallow (line 442, `if (frameType === "error") return;`) with:

```ts
    if (frameType === "error") {
      // An old host answers an unknown frame type with {type:"error", error:
      // "unknown_message_type", ref:"<type>"} and NO request_id. Fail every
      // pending RPC of that type so callers degrade immediately instead of
      // waiting out the timeout (spec-097 §C.3 fast path).
      const ref = (frame as unknown as { ref?: string | null }).ref;
      if (typeof ref === "string") {
        for (const [request_id, pending] of [...this.pendingRpc]) {
          if (pending.rpcType !== ref) continue;
          clearTimeout(pending.timer);
          this.pendingRpc.delete(request_id);
          pending.reject(new EdgeBookError("host_unsupported_rpc", `Host does not support ${ref}`));
        }
      }
      return;
    }
```

Update `deliverEnvelopeViaMailbox` (line 545) return type to `Promise<MailboxSendAck>` (body unchanged), and add the transient helper after `revokeOneSession` (line 579):

```ts
// Query per-message delivery state via a transient dial-out connection
// (spec-097). Returns null when the host does not support receipts.
export async function mailboxStatus(options: DialoutClientOptions & { ids: string[]; timeoutMs?: number }): Promise<MailboxStatusEntry[] | null> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try { return await client.mailboxStatusAndWait(options.ids, options.timeoutMs ?? 5_000); } finally { await client.stop(); }
}
```

- [ ] **Green:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts test/mvp-mailbox.test.ts test/dialout.test.ts && npm run typecheck && npm run lint
```

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-cli && git add src/dialout.ts test/outbox.test.ts && git commit -m "feat(receipts): surface recipient_live from send ack; mailbox_status RPC client with error-frame fast path + timeout degradation (spec-097 C.2)"
```

---

## Task C3: Honest send wording + outbox recording on every `--deliver` path (one shared helper)

**Files:**
- Modify: `src/cli-shared.ts` (new `deliverViaMailboxRecorded` after `deliverToPeer` ~line 103; rewire `broadcastPost` ~line 110-125; import `recordOutboxEntry`, `MessageEnvelope`)
- Modify: `src/cli-social.ts` (all 8 `deliverEnvelopeViaMailbox` call sites: lines 68, 89, 106, 169, 217, 229, 298, 322; swap the import)
- Modify: `test/outbox.test.ts` (append)

**Steps:**

- [ ] **Write the failing tests.** Append to `test/outbox.test.ts`:

```ts
// ── spec-097 C.3: honest --deliver wording + ledger recording ────────────────

test("--deliver with recipient_live=false prints Queued/NOT connected, never Delivered, and records the ledger entry", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  const result = await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.match(result.text, /Queued/);
  assert.match(result.text, /NOT connected/);
  assert.match(result.text, /edge-book outbox/);
  assert.doesNotMatch(result.text, /Delivered/, "the word Delivered no longer appears at enqueue time");

  const entries = await readOutbox(aliceHome);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, "m0", "host-assigned id recorded");
  assert.equal(entries[0]!.envelope_type, "object_share");
  assert.equal(entries[0]!.to_agent_id, bobId);
  assert.equal(entries[0]!.recipient_live, false);
});

test("--deliver with recipient_live=true prints the Sent wording", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  host.liveRecipients.add(bobId);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  const result = await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.match(result.text, /Sent/);
  assert.match(result.text, /recipient's agent is connected/);
  const entries = await readOutbox(aliceHome);
  assert.equal(entries[0]!.recipient_live, true);
});

test("old-host send (no recipient_live) keeps the legacy wording and still records the entry", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });

  const result = await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  assert.match(result.text, /Shared object .* over the mailbox \(host id m0\)/, "graceful degradation: current wording unchanged");
  const entries = await readOutbox(aliceHome);
  assert.equal(entries.length, 1);
  assert.ok(!("recipient_live" in entries[0]!));
});

test("friend request --deliver over the mailbox uses honest wording and records the entry", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobHome, factory } = await friendedPair(host);
  // A fresh pair NOT yet friended for a clean friend_request; reuse bob's card file.
  const bobStore = new EdgeBookStore({ home: bobHome });
  const bobCard = await bobStore.writeCard();
  const root = await tempHome();
  const carolHome = path.join(root, "carol");
  const carolStore = new EdgeBookStore({ home: carolHome });
  await carolStore.init({ handle: "carol.local", ownerLabel: "Carol" });
  const cardPath = path.join(root, "bob-card.json");
  await fs.writeFile(cardPath, JSON.stringify(bobCard), "utf8");

  const result = await handleCli(["friend", "request", cardPath, "--deliver", "--host", "ws://fake"],
    { home: carolHome, socketFactory: factory });

  assert.match(result.text, /Queued|Sent/, "state-accurate wording on the friend path too");
  assert.doesNotMatch(result.text, /Delivered/);
  const entries = await readOutbox(carolHome);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.envelope_type, "friend_request");
});
```

NOTE: `friend request --deliver` falls through to the mailbox only when the card carries no direct/relay transport (cli-social.ts:59-67) — the default `writeCard()` of a dial-out-only agent has none, so the fall-through fires. If this assumption breaks at red/green time, check `card.transports` in the test and strip direct/relay entries from the card JSON before writing `cardPath`.

- [ ] **Red:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts
```

Expected failures: text still says `Delivered ... over the mailbox` on the receipts host (wording assertions fail) and `readOutbox` returns `[]` (no recording).

- [ ] **Implement the shared helper.** In `src/cli-shared.ts`, extend the dialout import (line 7-8) to also bring `MailboxSendAck` is not needed — the helper infers it. Add `recordOutboxEntry` and `MessageEnvelope` imports:

```ts
import { recordOutboxEntry } from "./store-outbox.ts";
import type { MessageEnvelope } from "./edge-book.ts";
```

(`EdgeBookError, EdgeBookStore` are already imported from `./edge-book.ts` — merge the type import there: `import { EdgeBookError, EdgeBookStore, type MessageEnvelope } from "./edge-book.ts";`.)

Add after `deliverToPeer` (line 103):

```ts
// Deliver over the host mailbox, record the outbox ledger entry, and render
// honest state wording (spec-097 §C.2): "Sent" when the recipient's agent is
// live, "Queued" when not, and the caller's legacy wording when the host
// predates receipts (recipient_live absent from the ack). Every mailbox
// --deliver path routes through here so all of them record without copies.
export async function deliverViaMailboxRecorded(
  envelope: MessageEnvelope,
  opts: { home?: string; host: string; socketFactory?: CliContext["socketFactory"] },
  legacyText: (id: string) => string,
): Promise<{ id: string; recipient_live?: boolean; text: string }> {
  const ack = await deliverEnvelopeViaMailbox({ home: opts.home, host: opts.host, socketFactory: opts.socketFactory, envelope });
  await recordOutboxEntry(opts.home, {
    id: ack.id,
    to_agent_id: envelope.to_agent_id,
    envelope_type: envelope.type,
    ...(typeof ack.recipient_live === "boolean" ? { recipient_live: ack.recipient_live } : {})
  });
  if (ack.recipient_live === true) {
    return { ...ack, text: `Sent ${envelope.type} to ${envelope.to_agent_id} — recipient's agent is connected (host id ${ack.id}).` };
  }
  if (ack.recipient_live === false) {
    return { ...ack, text: `Queued ${envelope.type} to ${envelope.to_agent_id} — recipient's agent is NOT connected; it will arrive when they reconnect. Check later: edge-book outbox (host id ${ack.id}).` };
  }
  return { ...ack, text: legacyText(ack.id) };
}
```

Rewire `broadcastPost` (line 110-125): replace the
`await deliverEnvelopeViaMailbox({ home: store.home, host, socketFactory, envelope });` line with:

```ts
    await deliverViaMailboxRecorded(envelope, { home: store.home, host, socketFactory },
      (id) => `Delivered post_publish (host id ${id})`);
```

- [ ] **Rewire all 8 cli-social.ts call sites.** Change the import at line 9 from `deliverEnvelopeViaMailbox` to `deliverViaMailboxRecorded` from `./cli-shared.ts` (merge into the existing cli-shared import at line 7; delete the `./dialout.ts` import line if nothing else uses it). Then:

**friend request (line 66-69)** →

```ts
        // Dial-out agent (no inbound endpoint): deliver over the host mailbox.
        const hostUrl = parseHost(args, ctx);
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Delivered friend_request to ${card.agent_id} over the mailbox (host id ${id})`);
        return { text: outcome.text, json: envelope };
```

**friend accept (line 87-90)** →

```ts
          // Dial-out peer (no inbound endpoint): deliver over the host mailbox.
          const hostUrl = parseHost(args, ctx);
          const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
            (id) => `Delivered friend_response to ${peer} over the mailbox (host id ${id})`);
          return { text: outcome.text, json: envelope };
```

**friend apply-response (line 105-107)** →

```ts
          const hostUrl = parseHost(args, ctx);
          const outcome = await deliverViaMailboxRecorded(followUp, { home, host: hostUrl, socketFactory: ctx.socketFactory },
            (id) => `delivered profile_share to ${followUp.to_agent_id} over the mailbox (host id ${id})`);
          return { text: `Applied response; ${outcome.text}`, json: followUp };
```

**friend auto-accept loop (line 168-169)** — machine path, JSON output unchanged, recording still wanted →

```ts
              // Dial-out peer (no inbound endpoint): deliver over the host mailbox.
              await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
                (id) => `Delivered ${envelope.type} (host id ${id})`);
```

**object share (line 216-219)** →

```ts
      if (deliver) {
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Shared object ${objectId} to ${peer} over the mailbox (host id ${id})`);
        return { text: outcome.text, json: envelope };
      }
```

**object revoke (line 228-231)** →

```ts
      if (deliver) {
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `Revoked object ${objectId} for ${peer}; forwarded over the mailbox (host id ${id})`);
        return { text: outcome.text, json: envelope };
      }
```

**escalation raise (line 297-300)** →

```ts
        if (deliver) {
          const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
            (id) => `delivered to ${to} over the mailbox (host id ${id})`);
          return { text: `Raised escalation ${escalation.escalation_id}; ${outcome.text}`, json: envelope };
        }
```

**escalation answer (line 321-324)** →

```ts
      if (envelope && deliver) {
        const outcome = await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
          (id) => `routed response to ${envelope.to_agent_id} over the mailbox (host id ${id})`);
        return { text: `Answered ${escalationId}; ${outcome.text}`, json: { ...escalation, response_envelope: envelope } };
      }
```

- [ ] **Green (new file + the existing social/dialout suites that exercise these paths):**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts test/dialout-friend-relay.test.ts test/dialout-escalation-relay.test.ts test/cli-object.test.ts test/greeter.test.ts && npm run typecheck && npm run lint
```

(If any existing test asserts the exact legacy "Delivered ... over the mailbox" string against a fake host that now reports `recipient_live`, update that fake/assertion to the honest wording — the spec makes the old wording incorrect by definition. Note any such change in the commit body.)

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-cli && git add src/cli-shared.ts src/cli-social.ts test/outbox.test.ts && git commit -m "feat(receipts): honest Sent/Queued send wording + outbox recording on every mailbox --deliver path (spec-097 C.2)"
```

---

## Task C4: `edge-book outbox` command + commands-doc + README regen

**Files:**
- Modify: `src/cli.ts` (imports; new `outbox` branch after the `sessions` block, ~line 186)
- Modify: `src/commands-doc.ts` ("Hosted reader" group, after the `sessions revoke` row ~line 110)
- Modify: `README.md` (regenerated by `npm run sync-readme` — do not hand-edit)
- Modify: `test/outbox.test.ts` (append)

**Steps:**

- [ ] **Write the failing tests.** Append to `test/outbox.test.ts`:

```ts
// ── spec-097 C.3: the `edge-book outbox` command ─────────────────────────────

test("outbox prints per-entry state and a LOUD warning for stale-queued mail; --json round-trips", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  // Send one (records m0), then make the host report it stale-queued.
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });
  host.statuses.set("m0", { state: "queued", queued_ms: 11 * 60 * 1000, recipient_live: false });

  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.match(result.text, /object_share/);
  assert.match(result.text, /queued/);
  assert.match(result.text, /⚠ undelivered for /, "loud stale warning present");
  assert.match(result.text, /different identity; ask them for a fresh invite/, "the June 9 diagnosis, automated");

  const jsonResult = await handleCli(["outbox", "--json", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  const parsed = JSON.parse(jsonResult.text) as { entries: Array<{ id: string; state: string; stale: boolean; queued_ms?: number }> };
  assert.equal(parsed.entries[0]!.id, "m0");
  assert.equal(parsed.entries[0]!.state, "queued");
  assert.equal(parsed.entries[0]!.stale, true);
  assert.equal(parsed.entries[0]!.queued_ms, 11 * 60 * 1000);
});

test("outbox warns when recipient_live=false even under the stale-time threshold", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });
  host.statuses.set("m0", { state: "queued", queued_ms: 5_000, recipient_live: false });

  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.match(result.text, /⚠ undelivered/, "recipient_live=false alone triggers the warning");
});

test("outbox shows contact display names where known and acked state for delivered mail", async () => {
  const host = new FakeStatusHost("receipts");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });
  host.statuses.set("m0", { state: "acked" });

  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.match(result.text, /acked/);
  const contacts = await aliceStore.contacts();
  const display = contacts[bobId]?.display_name;
  assert.ok(display, "test pair has a contact display name");
  assert.ok(result.text.includes(display!), "recipient shown by display name, not bare DID");
  assert.doesNotMatch(result.text, /⚠/, "acked mail never warns");
});

test("outbox with an empty ledger says so and exits cleanly", async () => {
  const home = await tempHome();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "lonely.local" });
  const result = await handleCli(["outbox", "--host", "ws://fake"], { home, socketFactory: factoryFor(new FakeStatusHost("receipts")) });
  assert.match(result.text, /Outbox is empty/);
});
```

- [ ] **Red:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts
```

Expected failure: `EdgeBookError: unknown_command` (the `outbox` branch doesn't exist).

- [ ] **Implement.** In `src/cli.ts`, extend the dialout import (line 21) with `mailboxStatus` and add:

```ts
import type { MailboxStatusEntry } from "./dialout.ts";
import { formatAge, readOutbox, staleQueueMs } from "./store-outbox.ts";
```

Insert the command branch after the `sessions` block (after line 186, before `relay`):

```ts
  if (command === "outbox") {
    // Delivery receipts (spec-097): one transient connection, a single
    // mailbox_status for the recorded ids, honest per-entry state. Against a
    // pre-receipts host (error frame or timeout) it degrades to the local
    // ledger with unknown states — exit 0 either way.
    const asJson = takeBoolFlag(args, "--json");
    const hostUrl = parseHost(args, ctx);
    const entries = await readOutbox(home);
    if (entries.length === 0) {
      return { text: "Outbox is empty — nothing has been sent with --deliver yet.", json: { entries: [] } };
    }
    // Newest 50: the wire bound on mailbox_status ids.
    const recent = entries.slice(-50);
    let statuses: MailboxStatusEntry[] | null = null;
    try {
      statuses = await mailboxStatus({ home, host: hostUrl, socketFactory: ctx.socketFactory, ids: recent.map((e) => e.id) });
    } catch {
      statuses = null; // connection failure degrades like an old host: local-only
    }
    const byId = new Map((statuses ?? []).map((s) => [s.id, s]));
    const contacts = await store.contacts();
    const staleMs = staleQueueMs();
    const report = recent.map((entry) => {
      const status = byId.get(entry.id);
      const state = statuses === null ? "unknown (host does not support receipts)" : (status?.state ?? "unknown");
      const age = formatAge(Date.now() - Date.parse(entry.sent_at));
      const stale = status?.state === "queued" && ((status.queued_ms ?? 0) > staleMs || status.recipient_live === false);
      return {
        ...entry,
        to_display_name: contacts[entry.to_agent_id]?.display_name || entry.to_agent_id,
        age,
        state,
        ...(status?.queued_ms !== undefined ? { queued_ms: status.queued_ms } : {}),
        ...(status?.recipient_live !== undefined ? { recipient_live: status.recipient_live } : {}),
        stale: Boolean(stale)
      };
    });
    const lines = report.map((r) => {
      const base = `${r.id}  ${r.envelope_type}  → ${r.to_display_name}  (${r.age} ago)  ${r.state}`;
      return r.stale
        ? `${base}\n  ⚠ undelivered for ${r.age} — the recipient's agent may be running under a different identity; ask them for a fresh invite.`
        : base;
    });
    return { text: asJson ? JSON.stringify({ entries: report }, null, 2) : lines.join("\n"), json: { entries: report } };
  }
```

In `src/commands-doc.ts`, add to the "Hosted reader" group after the `sessions revoke` row (~line 110):

```ts
      {
        usage: "outbox [--json] [--host <wss-url>]",
        desc: "Delivery state of recently sent envelopes (queued / delivered / acked) with stale-queue warnings",
      },
```

Regenerate the README:

```bash
cd ~/claude/edge-book-cli && npm run sync-readme
```

- [ ] **Green:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts test/commands-doc.test.ts && npm run sync-readme:check && npm run typecheck && npm run lint
```

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-cli && git add src/cli.ts src/commands-doc.ts README.md test/outbox.test.ts && git commit -m "feat(receipts): edge-book outbox command — single mailbox_status, stale-queue warning, --json, old-host degradation (spec-097 C.3)"
```

---

## Task C5: Old-host degradation suite for the `outbox` command

**Files:**
- Modify: `test/outbox.test.ts` (append; no src changes expected — these tests pin behavior already built in C2/C4. If one fails, fix the src and note it.)

**Steps:**

- [ ] **Write the tests** (red only if C2/C4 left a gap — run them as the proof either way). Append:

```ts
// ── spec-097 §D: old-host degradation for the outbox command ─────────────────

test("outbox against an old host (error frame) prints local-only unknown states immediately, exit 0", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  const started = Date.now();
  // handleCli resolving (not throwing) IS exit 0 — runCli only sets exitCode on throw.
  const result = await handleCli(["outbox", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  assert.ok(Date.now() - started < 2000, "error-frame fast path: no 5s timeout wait");
  assert.match(result.text, /unknown \(host does not support receipts\)/);
  assert.match(result.text, /object_share/, "local ledger entries still listed");
  assert.doesNotMatch(result.text, /⚠/, "no stale warning without host truth");
});

test("outbox --json against an old host marks every entry unknown-unsupported", async () => {
  const host = new FakeStatusHost("legacy-error");
  const { aliceHome, bobId, factory } = await friendedPair(host);
  const aliceStore = new EdgeBookStore({ home: aliceHome });
  const object = await aliceStore.createObject({ title: "t", body: "b" });
  await handleCli(["object", "share", bobId, object.object_id, "--deliver", "--host", "ws://fake"],
    { home: aliceHome, socketFactory: factory });

  const result = await handleCli(["outbox", "--json", "--host", "ws://fake"], { home: aliceHome, socketFactory: factory });
  const parsed = JSON.parse(result.text) as { entries: Array<{ state: string; stale: boolean }> };
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]!.state, "unknown (host does not support receipts)");
  assert.equal(parsed.entries[0]!.stale, false);
});
```

- [ ] **Run:**

```bash
cd ~/claude/edge-book-cli && node --test test/outbox.test.ts
```

Expected: green if C2/C4 are correct (these pin the degradation contract); fix src and re-run if not.

- [ ] **Commit:**

```bash
cd ~/claude/edge-book-cli && git add test/outbox.test.ts && git commit -m "test(receipts): pin old-host degradation — error-frame fast path, local-only outbox, exit 0 (spec-097 D)"
```

---

## Task C6: Final gates (both repos) + live verification checklist

**Files:** none (verification + release choreography).

**Steps:**

- [ ] **Host gates (again, from a clean tree):**

```bash
cd ~/claude/edge-book-host && npm test && npm run lint && npm run typecheck && npm run build
```

- [ ] **CLI gates:**

```bash
cd ~/claude/edge-book-cli && npm test && npm run lint && npm run typecheck && npm run sync-readme:check && npm run build
```

- [ ] **Live verification checklist (spec Acceptance — NORMATIVE ORDER, host before npm):**

  1. [ ] Host PR merged to `main`; **deploy to Fly first**: `cd ~/claude/edge-book-host && fly deploy`. Confirm `curl -s https://edge-book-host.fly.dev/metrics | grep receipts_ledger_size` returns the new additive field and `/healthz` is green.
  2. [ ] **Old-client compat against the new host** (old client ↔ new host): with the currently-published `edge-book` npm version, run one `--deliver` against the deployed host — output unchanged (it ignores `recipient_live`), delivery works.
  3. [ ] CLI PR merged; bump version (`0.13.x` → next minor per house convention) and `npm publish` **only after step 1 is verified live**.
  4. [ ] **June-9 repro (the acceptance keystone):** from a live agent, send mail to a DID no channel claims (e.g. a retired identity's DID): the send prints `Queued — recipient's agent is NOT connected…`; wait past 10 min OR `EDGE_BOOK_STALE_QUEUE_MS=1000 edge-book outbox` → the loud `⚠ undelivered…fresh invite` warning shows. **No `fly ssh` required.**
  5. [ ] **Happy path live:** send between two live agents (e.g. the two-agent smoke pair with `--host`), recipient acks, `edge-book outbox` shows `acked`.
  6. [ ] New client ↔ old host degradation was proven by test (C5); no live check possible once the host is upgraded — record that in the PR.
  7. [ ] Update EA task `ea-claude-130` and memory (`MEMORY.md` Active Builds line: delivery receipts spec-097 shipped).

---

## Self-review (walk before declaring done)

**Spec §A (relay per-message state):**
- [ ] A.1 `delivered_at` set first-time-only via store method `markDelivered` called from `deliverQueued` per socket write; joins the `{expires_at: _omit, ...}` strip list; absent = never pushed → H1 (store) + H2 (`deliverQueued` stamp).
- [ ] A.2 receipts ledger `{acked_at, to, from}` recorded on authorized ack before delete; `receipts` key in `State`; TTL via extended `purge()` (`EDGE_BOOK_RECEIPT_TTL_MS`, 7d default); cap 10 000 at insert time, oldest-by-`acked_at` evicted; persisted in state.json → H1.
- [ ] A.3 aggregate counters and `/metrics` unchanged; additive `receipts_ledger_size` added → H3 (+ H4 full-suite proves observability tests green).

**Spec §B (wire protocol):**
- [ ] B.1 `recipient_live` on `mailbox_send_ok`, computed BEFORE the ack send via extracted `resolveLiveChannel` reading the in-memory `channels` Map; `deliverQueued` reuses it; read-only, delivery behavior unchanged → H2.
- [ ] B.2 `mailbox_status`/`mailbox_status_ok` modeled on `sessions_list`; ≤50 ids; states queued/delivered/acked/unknown; `queued_ms`/`recipient_live` present for queued/delivered, ABSENT (key omitted) for acked/unknown → H2.
- [ ] B.2 auth fail-closed: only `from === channel_id` sees state; third party AND recipient get `unknown`; key-rotation limit accepted (documented in wire-protocol.md) → H2 + H3.
- [ ] B.2 malformed → `mailbox_status_err {request_id, error}` → H2.

**Spec §C (sender CLI):**
- [ ] C.1 `src/store-outbox.ts`, `outbox.json` JSON array in the agent home (registered in store-files.ts), `{id, to_agent_id, envelope_type, sent_at, recipient_live}`, cap 200 drop-front, every successful `--deliver` appends (all 8 cli-social sites + broadcastPost via one helper) → C1 + C3.
- [ ] C.2 honest wording: `Sent — recipient's agent is connected…` / `Queued — … NOT connected … Check later: edge-book outbox …` / legacy unchanged when field absent; "Delivered" never claimed at enqueue time against a receipts host → C3.
- [ ] C.3 `edge-book outbox`: one transient connection, single `mailbox_status` (newest ≤50 ids), per-entry line with contact display name, loud warning on `queued_ms > EDGE_BOOK_STALE_QUEUE_MS` (default 10 min, parsed in store-outbox.ts) OR `recipient_live === false`, `--json`, old-host → local-only + exit 0; degradation via BOTH the `error`-frame fast path (real old-host behavior: channels.ts echoes `ref`) AND RPC timeout → C2 + C4 + C5.
- [ ] C.4 transient-connection model unchanged; `mailbox_status` rides the existing `pendingRpc`/`rpc()` request_id mechanism → C2.

**Spec §D (compatibility & rollout):**
- [ ] All additive; old client + new host and new client + old host proven by tests (H2 frames are supersets; C2/C3/C5 legacy modes) → H2/C2/C3/C5.
- [ ] wire-protocol.md updated in the same host PR → H3. Host deploy BEFORE npm publish → C6 checklist.

**Spec Tests list, item by item:**
- [ ] Host: send offline→`recipient_live:false` / online→`true` → H2 test 1. ✓
- [ ] Host: sender status queued (`queued_ms ≥ 0`, `recipient_live:false`) → delivered (after reconnect push, no ack) → acked (gone from mailbox, in ledger) → random id unknown → H2 keystone-extended. ✓
- [ ] Host: third agent → unknown; recipient → unknown → H2 auth test. ✓
- [ ] Host: restart-safety (receipt + `delivered_at` survive reload) → H1 reload test. ✓
- [ ] Host: ledger bounds (TTL purge; cap evicts oldest) → H1. ✓
- [ ] Host: `/metrics` shape unchanged / observability green → H3 test + H4 full suite. ✓
- [ ] CLI: `--deliver` + `recipient_live:false` → Queued/NOT connected/never Delivered + ledger entry → C3. ✓
- [ ] CLI: `recipient_live:true` → Sent wording → C3. ✓
- [ ] CLI: old-host shape → legacy wording; `outbox` exit 0 with unknown states → C3 + C5. ✓
- [ ] CLI: `outbox` queued + stale `queued_ms` → loud warning; `--json` round-trips → C4. ✓
- [ ] CLI: outbox cap 201st evicts oldest → C1. ✓
- [ ] CLI: old-host error frame → immediate local-only, no timeout wait → C2 (RPC level) + C5 (command level). ✓
- [ ] E2E offline→reconnect→ack with status at each stage lives in the host repo (TestAgent), NOT the two-agent smoke (no new smoke step — its harness has no mid-test disconnect); live verification is the C6 acceptance item. ✓
- [ ] Both repos: suites, lint, README sync green → H4 + C6. ✓
