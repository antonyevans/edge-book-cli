# Greeter Agent (spec-132 / ea-claude-133) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Solve the network cold-start: every `init` seeds a greeter candidate pointing at the greeter's live handle URL, and a config-gated greeter agent auto-accepts pending friend requests and delivers a single shared welcome object, on a 5-minute Hermes cron.

**Architecture:** No new protocol or storage shapes — the greeter is a normal agent with (1) two additive `EdgeBookConfig` fields and a `greeter --on/--off` toggle, (2) a new pure module `src/store-greeter.ts` that scans `request_received` contacts, calls the existing `acceptFriend()` / `shareObjectEnvelope()`, and dedups welcomes through the existing spec-125 ledger (`wasNotified`/`recordNotified`, keys `greeter_welcome:<agent_id>`), (3) a `friend auto-accept --deliver` CLI command whose delivery wiring copies `friend accept --deliver` verbatim, (4) one extra `writeCandidate` call in `init` (zero network — the card is fetched at promotion), and (5) an `ensureGreeterCron()` mirroring `ensureNotifierCron()`, installed at dialout only when `greeter_mode: true`.

**Tech stack:** TypeScript ESM with **`.ts`-suffix relative imports** (NOT `.js` — see any file in `src/`), `node --test test/*.test.ts` (the `npm test` glob auto-discovers new test files), ESLint size gates (`npm run lint`: `max-lines` 500 error, skips blanks/comments), README autosync (`npm run sync-readme` to regenerate, `npm run sync-readme:check` as the gate — `test/commands-doc.test.ts` has a drift guard that fails if a `command === "..."` appears in `cli.ts` without a `COMMAND_GROUPS` row).

**Spec:** `docs/spec-132-greeter-agent.md` (judge-approved, normative). Parent EA task: `executive-assistant/tasks/ea/ea-claude-133-*`.

**Repo + branch:** `~/claude/edge-book-cli`, branch `feat/132-greeter` (create from `main`: `git checkout main && git pull && git checkout -b feat/132-greeter`).

**Out of scope (per spec):** starter packs, funnel instrumentation, any host/relay change, auto-accept for non-greeter agents, greeter conversational behavior beyond the one welcome share.

**Key wiring facts (verified against source — do not re-derive):**
- New top-level commands are plain `if (command === "...")` branches in `handleCli`'s flat if-chain in `src/cli.ts` (identity/social/taxonomy handlers return `null` for commands not their own; anything not handled falls through to the `unknown_command` throw at cli.ts:180). `friend` subactions live in `src/cli-social.ts` under `if (command === "friend")`.
- `friend accept --deliver` delivery wiring (cli-social.ts:77-93): `takeBoolFlag(args, "--deliver")` → try `deliverToPeer(store, envelope, peer)` → catch only `EdgeBookError` with code `no_route` → `parseHost(args, ctx)` → `deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope })`. `home` is the `string | undefined` parameter passed into `handleSocialCli`.
- The relay https base helper **already exists**: `relayBaseFromHost(host)` in `src/cli-shared.ts:41-43` maps `wss://X/agent/ws` → `https://X`. `parseHost(args, ctx)` (cli-shared.ts:36-38) resolves `--host` flag > `ctx.defaultHost` > `EDGE_BOOK_HOST` env > `DEFAULT_DIALOUT_HOST` (`wss://edge-book-host.fly.dev/agent/ws`). `EDGE_BOOK_RELAY_BASE` does **not** exist in the codebase today — this plan introduces it (checked first, per spec §A).
- `store.updateConfig()` (src/store-identity.ts:151-167) copies fields **explicitly, one `if` per field** — new config fields MUST be added there or writes silently no-op.
- `writeCandidate` (src/resolver.ts:184-198) dedups by `candidateKey` = `source + ":" + (card_url ?? agent_id)`; `store.init()` (store-identity.ts:25-31) is idempotent (returns existing identity), so double-init exercises the dedup.
- The init onboarding JSON (src/cli-identity.ts:28-54): `onboardingJson: Record<string, string> | undefined`, attached as `{ ...identity, onboarding: onboardingJson }` only when defined.
- Ledger: `store.wasNotified(key)` / `store.recordNotified(key)` are delegate methods on `EdgeBookStore` (edge-book.ts:580-586) over `notified.json` — generic string-key ledger, no new machinery.
- `acceptFriend` (store-friends.ts:181-208) issues grants `["message.friend", "feed.read.friends", "profile.read.friend", "escalation.raise"]` and returns the signed `friend_response` envelope — used unchanged.
- `shareObjectEnvelope` (store-objects.ts:137-160) requires the peer's `relationship_state === "friend"` (true immediately after `acceptFriend`) and sets `ref: objectId` on the envelope.
- store-greeter.ts is imported directly by cli-social.ts (like `resolver.ts` functions are) — NO delegate methods added to `EdgeBookStore` (keeps edge-book.ts size flat; spec's layering only requires a pure module).

**Spec test list → task map** (every spec test appears below): init seeding tests → Task 4; `greeter --on/--off` + gate error → Tasks 1 and 2/3; two-pending pass → Task 2; partial-failure re-run → Task 2; copy guard → Task 2; candidate promotion via stubbed registry → Task 4; smoke step both transports → Task 6; suite/lint/README green → Tasks 6/7 gates.

---

## Task 1: Config fields + `greeter --on/--off` toggle + commands-doc

**Files:**
- Modify: `src/types.ts` (`EdgeBookConfig`, after `handle_nudge_at` at line 54)
- Modify: `src/store-identity.ts` (`updateConfig`, line 151-167 — add two field-copy lines)
- Modify: `src/cli.ts` (new `greeter` branch after the `ensure-notifier` block, ~line 116)
- Modify: `src/commands-doc.ts` (new "Greeter" group after the "Friends" group, ~line 172)
- Create: `test/greeter.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/greeter.test.ts`:

```ts
// spec-132: greeter agent — toggle, auto-accept pass, welcome share, candidate seeding.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCli } from "../src/cli.ts";
import { EdgeBookStore, EdgeBookError } from "../src/edge-book.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "edge-book-greeter-test-"));
}

test("greeter --on sets greeter_mode true; greeter --off sets it false", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home, "--name", "Greeter Agent"]);
  const on = await handleCli(["greeter", "--on", "--home", home]);
  assert.equal((on.json as { greeter_mode?: boolean }).greeter_mode, true);
  assert.ok(on.text.includes("greeter_mode = true"));
  assert.equal((await new EdgeBookStore({ home }).config()).greeter_mode, true);
  const off = await handleCli(["greeter", "--off", "--home", home]);
  assert.equal((off.json as { greeter_mode?: boolean }).greeter_mode, false);
  assert.equal((await new EdgeBookStore({ home }).config()).greeter_mode, false);
});

test("greeter with both flags or neither flag errors", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await assert.rejects(
    () => handleCli(["greeter", "--on", "--off", "--home", home]),
    (e: unknown) => e instanceof EdgeBookError && e.code === "bad_flags",
  );
  await assert.rejects(
    () => handleCli(["greeter", "--home", home]),
    (e: unknown) => e instanceof EdgeBookError && e.code === "missing_arg",
  );
});

test("updateConfig persists greeter_welcome_object_id", async () => {
  const home = await tempRoot();
  const store = new EdgeBookStore({ home });
  await store.init({ handle: "g.openclaw.local" });
  await store.updateConfig({ greeter_welcome_object_id: "obj-test-123" });
  assert.equal((await store.config()).greeter_welcome_object_id, "obj-test-123");
  // Unrelated updates must not clobber it (explicit field-copy in updateConfig).
  await store.updateConfig({ notify_on_friend_request: true });
  assert.equal((await store.config()).greeter_welcome_object_id, "obj-test-123");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts`
Expected: test 1 and 2 FAIL with `unknown_command` (the `greeter` command does not exist); test 3 FAILS (`greeter_welcome_object_id` is `undefined` — `updateConfig` drops unknown fields).

- [ ] **Step 3: Minimal implementation**

`src/types.ts` — append inside `EdgeBookConfig`, directly after the `handle_nudge_at?: number;` line (line 54):

```ts
  // spec-132 greeter. greeter_mode gates `friend auto-accept` and the greeter
  // cron install — absent/false = off; normal agents can never auto-accept.
  greeter_mode?: boolean;
  // Set once by the greeter's first welcome pass (store-greeter.ts): the single
  // shared welcome object every newly accepted friend is granted to read.
  greeter_welcome_object_id?: string;
```

`src/store-identity.ts` — inside `updateConfig`, after the `if (input.handle_nudge_at !== undefined) ...` line (line 162):

```ts
  if (input.greeter_mode !== undefined) next.greeter_mode = input.greeter_mode;
  if (input.greeter_welcome_object_id !== undefined) next.greeter_welcome_object_id = input.greeter_welcome_object_id;
```

`src/cli.ts` — insert this branch after the `ensure-notifier` block (after line 116, before `if (command === "pair")`). `takeBoolFlag` and `EdgeBookError` are already imported in cli.ts:

```ts
  if (command === "greeter") {
    // spec-132: config gate for the greeter agent. Mirrors the friend
    // notify-config flag pattern (cli-social.ts) exactly.
    const on = takeBoolFlag(args, "--on");
    const off = takeBoolFlag(args, "--off");
    if (on && off) throw new EdgeBookError("bad_flags", "greeter takes either --on or --off, not both");
    if (!on && !off) throw new EdgeBookError("missing_arg", "greeter needs --on or --off");
    const cfg = await store.updateConfig({ greeter_mode: on ? true : false });
    return { text: `greeter_mode = ${cfg.greeter_mode}`, json: cfg };
  }
```

`src/commands-doc.ts` — insert a new group after the "Friends" group's closing `},` (line 172):

```ts
  {
    title: "Greeter",
    rows: [
      {
        usage: "greeter --on|--off",
        desc: "Enable or disable greeter mode (gates friend auto-accept and the greeter cron)",
      },
    ],
  },
```

- [ ] **Step 4: Run to verify green**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts && node --test test/commands-doc.test.ts && npm run sync-readme && npm run sync-readme:check && npm run lint`
Expected: all pass (the commands-doc drift guard sees `greeter` documented; sync-readme regenerates README.md).

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/types.ts src/store-identity.ts src/cli.ts src/commands-doc.ts test/greeter.test.ts README.md && git commit -m "feat(greeter): greeter_mode config fields + greeter --on/--off toggle (spec-132 §B)"
```

---

## Task 2: `src/store-greeter.ts` — pure auto-accept + welcome-share pass

**Files:**
- Create: `src/store-greeter.ts`
- Modify: `test/greeter.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `test/greeter.test.ts`:

```ts
import { runGreeterPass, greeterWelcomeKey, GREETER_WELCOME_TITLE, GREETER_WELCOME_BODY } from "../src/store-greeter.ts";

async function makeAgent(root: string, name: string) {
  const home = path.join(root, name);
  const store = new EdgeBookStore({ home });
  await store.init({ handle: `${name}.openclaw.local`, displayName: name });
  const card = await store.writeCard();
  return { home, store, card };
}

// A greeter store with n inbound requests sitting in request_received.
async function greeterWithPending(n: number) {
  const root = await tempRoot();
  const greeter = await makeAgent(root, "greeter");
  const requesters: Awaited<ReturnType<typeof makeAgent>>[] = [];
  for (let i = 0; i < n; i++) {
    const r = await makeAgent(root, `newbie${i}`);
    const env = await r.store.createFriendRequest(greeter.card);
    await greeter.store.receiveFriendRequest(env);
    requesters.push(r);
  }
  return { greeter, requesters };
}

test("runGreeterPass without greeter_mode → greeter_mode_required, nothing accepted", async () => {
  const { greeter, requesters } = await greeterWithPending(1);
  await assert.rejects(
    () => runGreeterPass(greeter.store),
    (e: unknown) => e instanceof EdgeBookError && e.code === "greeter_mode_required",
  );
  const contact = (await greeter.store.contacts())[requesters[0].card.agent_id];
  assert.equal(contact.relationship_state, "request_received", "gate must accept nothing");
});

test("two pending → both friend, one welcome object, two shares of the same object, ledger keys recorded", async () => {
  const { greeter, requesters } = await greeterWithPending(2);
  await greeter.store.updateConfig({ greeter_mode: true });
  const entries = await runGreeterPass(greeter.store);
  assert.equal(entries.length, 2);
  const welcomeId = (await greeter.store.config()).greeter_welcome_object_id;
  assert.ok(welcomeId, "welcome object id persisted to config");
  for (const r of requesters) {
    const entry = entries.find((e) => e.agent_id === r.card.agent_id);
    assert.ok(entry, `entry for ${r.card.agent_id}`);
    assert.equal(entry.accepted, true);
    assert.equal(entry.welcomed, true);
    assert.equal(entry.accept_envelope?.type, "friend_response");
    assert.equal(entry.share_envelope?.type, "object_share");
    assert.equal(entry.share_envelope?.ref, welcomeId, "both shares reference the same object");
    assert.equal((await greeter.store.contacts())[r.card.agent_id].relationship_state, "friend");
    assert.equal(await greeter.store.wasNotified(greeterWelcomeKey(r.card.agent_id)), true);
  }
  assert.equal(Object.keys(await greeter.store.objects()).length, 1, "welcome object exists exactly once");
});

test("partial-failure re-run: ledger has <a> but not <b> → only <b> gets the welcome share", async () => {
  const { greeter, requesters } = await greeterWithPending(2);
  await greeter.store.updateConfig({ greeter_mode: true });
  const [a, b] = requesters;
  await greeter.store.recordNotified(greeterWelcomeKey(a.card.agent_id));
  const entries = await runGreeterPass(greeter.store);
  const entryA = entries.find((e) => e.agent_id === a.card.agent_id)!;
  const entryB = entries.find((e) => e.agent_id === b.card.agent_id)!;
  assert.equal(entryA.accepted, true);
  assert.equal(entryA.welcomed, false, "a is in the ledger — no double-send");
  assert.equal(entryA.share_envelope, undefined);
  assert.equal(entryB.accepted, true);
  assert.equal(entryB.welcomed, true);
  assert.equal(entryB.share_envelope?.type, "object_share");
});

test("crash recovery: an already-accepted friend missing its ledger key is welcomed on the next pass", async () => {
  const { greeter, requesters } = await greeterWithPending(1);
  await greeter.store.updateConfig({ greeter_mode: true });
  // Simulate a crash between accept and welcome on a prior pass: friend, no ledger key.
  await greeter.store.acceptFriend(requesters[0].card.agent_id);
  const entries = await runGreeterPass(greeter.store);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].accepted, false, "no re-accept of an existing friend");
  assert.equal(entries[0].welcomed, true);
  assert.equal(entries[0].share_envelope?.type, "object_share");
});

test("a second pass is a no-op (idempotent)", async () => {
  const { greeter } = await greeterWithPending(1);
  await greeter.store.updateConfig({ greeter_mode: true });
  await runGreeterPass(greeter.store);
  assert.deepEqual(await runGreeterPass(greeter.store), []);
});

test("welcome copy avoids infrastructure vocabulary", () => {
  assert.equal(GREETER_WELCOME_TITLE, "Welcome to Edge Book");
  const text = `${GREETER_WELCOME_TITLE}\n${GREETER_WELCOME_BODY}`;
  for (const banned of ["Hermes", "mailbox", "envelope", "relay", "DID"]) {
    assert.ok(!text.includes(banned), `banned infrastructure word in welcome copy: ${banned}`);
  }
  assert.ok(!/\bgrants?\b/i.test(text), "grant-as-noun is banned in welcome copy");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts`
Expected: FAILS at module load — `Cannot find module '../src/store-greeter.ts'`. Task 1 tests still pass.

- [ ] **Step 3: Minimal implementation** — create `src/store-greeter.ts`:

```ts
// spec-132 greeter agent: the auto-accept + welcome-share pass. PURE store
// logic — takes the store, returns the envelopes to deliver, never touches the
// network. Delivery wiring lives in cli-social.ts (`friend auto-accept`),
// copied from the existing `friend accept --deliver` pattern.
//
// Invariants:
//   - hard-gated on config greeter_mode === true (greeter_mode_required) so no
//     normal agent can stumble into auto-accepting strangers;
//   - exactly ONE welcome object, created lazily on first need and pinned via
//     config.greeter_welcome_object_id (the stable marker, spec §C);
//   - welcome dedup rides the spec-125 ledger (store-notify.ts) with keys
//     `greeter_welcome:<agent_id>`. The key is recorded when the share envelope
//     is BUILT (before delivery): a crash between accept and welcome cannot
//     double-send; the trade-off (build-then-crash = welcome never delivered)
//     is the spec-chosen failure mode;
//   - crash recovery: friends missing their ledger key get a welcome-only entry
//     on the next pass (accepted: false, welcomed: true).
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { MessageEnvelope } from "./types.ts";

export const GREETER_WELCOME_TITLE = "Welcome to Edge Book";

// Human-vocabulary copy (spec §C): first share, agent can read it to you,
// "take it back" works both ways. Must pass the banned-vocabulary guard.
export const GREETER_WELCOME_BODY =
  "Hi, and welcome! This is your first share on Edge Book. Your agent can read it to you whenever you ask. " +
  "Sharing works both ways here: when someone shares with you, you can read it until they take it back — " +
  "and anything you share, you can take back too. Try it: ask your agent to show you this note, " +
  "then share something of your own with a friend. Glad you're here.";

export function greeterWelcomeKey(agentId: string): string {
  return `greeter_welcome:${agentId}`;
}

export interface GreeterPassEntry {
  agent_id: string;
  accepted: boolean;
  welcomed: boolean;
  accept_envelope?: MessageEnvelope;
  share_envelope?: MessageEnvelope;
}

// Ensure the single welcome object exists; pin its id in config on first create.
export async function ensureWelcomeObject(store: EdgeBookStore): Promise<string> {
  const config = await store.config();
  if (config.greeter_welcome_object_id) return config.greeter_welcome_object_id;
  const object = await store.createObject({ title: GREETER_WELCOME_TITLE, body: GREETER_WELCOME_BODY });
  await store.updateConfig({ greeter_welcome_object_id: object.object_id });
  return object.object_id;
}

// One greeter pass: accept every request_received contact (direct contacts scan —
// NOT pendingFriendRequests(), which filters by notified_at + notify config and
// would skip requests the notifier cron already pinged), then welcome every
// friend not yet in the ledger. Returns the envelopes for the caller to deliver.
export async function runGreeterPass(store: EdgeBookStore): Promise<GreeterPassEntry[]> {
  if ((await store.config()).greeter_mode !== true) {
    throw new EdgeBookError("greeter_mode_required", "friend auto-accept requires greeter mode (run: edge-book greeter --on)");
  }
  const contacts = Object.values(await store.contacts());
  const pending = contacts.filter((c) => c.relationship_state === "request_received");
  const friends = contacts.filter((c) => c.relationship_state === "friend");

  const buildWelcome = async (peerAgentId: string): Promise<MessageEnvelope | undefined> => {
    if (await store.wasNotified(greeterWelcomeKey(peerAgentId))) return undefined;
    const welcomeObjectId = await ensureWelcomeObject(store);
    const envelope = await store.shareObjectEnvelope(peerAgentId, welcomeObjectId);
    await store.recordNotified(greeterWelcomeKey(peerAgentId));
    return envelope;
  };

  const entries: GreeterPassEntry[] = [];
  for (const contact of pending) {
    const accept_envelope = await store.acceptFriend(contact.peer_agent_id, "greeter auto-accept");
    const share_envelope = await buildWelcome(contact.peer_agent_id);
    entries.push({
      agent_id: contact.peer_agent_id,
      accepted: true,
      welcomed: Boolean(share_envelope),
      accept_envelope,
      ...(share_envelope ? { share_envelope } : {}),
    });
  }
  for (const contact of friends) {
    const share_envelope = await buildWelcome(contact.peer_agent_id);
    if (share_envelope) {
      entries.push({ agent_id: contact.peer_agent_id, accepted: false, welcomed: true, share_envelope });
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run to verify green**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/store-greeter.ts test/greeter.test.ts && git commit -m "feat(greeter): store-greeter pure pass — auto-accept, single welcome object, ledger dedup (spec-132 §B/§C)"
```

---

## Task 3: `friend auto-accept --deliver` CLI wiring + commands-doc

**Files:**
- Modify: `src/cli-social.ts` (new `auto-accept` action inside the `friend` block — insert after the `mark-notified` action, line 151, before `notify-config`)
- Modify: `src/commands-doc.ts` (Friends group — add a row after `friend mark-notified`, ~line 162)
- Modify: `test/greeter.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `test/greeter.test.ts`:

```ts
test("CLI: friend auto-accept without greeter_mode → greeter_mode_required", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await assert.rejects(
    () => handleCli(["friend", "auto-accept", "--home", home]),
    (e: unknown) => e instanceof EdgeBookError && e.code === "greeter_mode_required",
  );
});

test("CLI: friend auto-accept returns JSON [{agent_id, accepted, welcomed}] for cron logs", async () => {
  const { greeter, requesters } = await greeterWithPending(1);
  await handleCli(["greeter", "--on", "--home", greeter.home]);
  const result = await handleCli(["friend", "auto-accept", "--home", greeter.home]);
  const json = result.json as Array<{ agent_id: string; accepted: boolean; welcomed: boolean }>;
  assert.equal(json.length, 1);
  assert.deepEqual(json[0], { agent_id: requesters[0].card.agent_id, accepted: true, welcomed: true });
  assert.deepEqual(JSON.parse(result.text), json, "text output is the same JSON (cron-log friendly)");
  // The pass really ran: contact is friend, welcome object pinned.
  assert.equal((await greeter.store.contacts())[requesters[0].card.agent_id].relationship_state, "friend");
  assert.ok((await greeter.store.config()).greeter_welcome_object_id);
});

test("CLI: friend auto-accept with nothing pending returns an empty list", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await handleCli(["greeter", "--on", "--home", home]);
  const result = await handleCli(["friend", "auto-accept", "--home", home]);
  assert.deepEqual(result.json, []);
  assert.equal(result.text.trim(), "[]");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts`
Expected: the three new tests FAIL — `friend auto-accept` is not a known action, so `handleSocialCli` falls through the `friend` block and `handleCli` throws `unknown_command` (not `greeter_mode_required`).

- [ ] **Step 3: Minimal implementation**

`src/cli-social.ts` — add to the imports at the top:

```ts
import { runGreeterPass } from "./store-greeter.ts";
```

Insert inside `if (command === "friend")`, after the `mark-notified` action block (line 151) and before `if (action === "notify-config")`:

```ts
    if (action === "auto-accept") {
      // spec-132 greeter: accept every pending request and send the welcome
      // share. Hard-gated on greeter_mode (runGreeterPass throws
      // greeter_mode_required). Delivery wiring copies `friend accept --deliver`.
      const deliver = takeBoolFlag(args, "--deliver");
      const hostUrl = parseHost(args, ctx);
      const entries = await runGreeterPass(store);
      if (deliver) {
        for (const entry of entries) {
          for (const envelope of [entry.accept_envelope, entry.share_envelope]) {
            if (!envelope) continue;
            try {
              await deliverToPeer(store, envelope, envelope.to_agent_id);
            } catch (error) {
              if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
              // Dial-out peer (no inbound endpoint): deliver over the host mailbox.
              await deliverEnvelopeViaMailbox({ home, host: hostUrl, socketFactory: ctx.socketFactory, envelope });
            }
          }
        }
      }
      const json = entries.map(({ agent_id, accepted, welcomed }) => ({ agent_id, accepted, welcomed }));
      return { text: JSON.stringify(json, null, 2), json };
    }
```

(`takeBoolFlag`, `parseHost`, `deliverToPeer`, `deliverEnvelopeViaMailbox`, `EdgeBookError` are all already imported in cli-social.ts — see lines 7-10.)

`src/commands-doc.ts` — in the "Friends" group, insert after the `friend mark-notified` row (~line 162):

```ts
      {
        usage: "friend auto-accept [--deliver]",
        desc: "Greeter only: accept all pending requests and send the welcome share (requires greeter --on)",
      },
```

- [ ] **Step 4: Run to verify green**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts && node --test test/commands-doc.test.ts && npm run sync-readme && npm run sync-readme:check && npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/cli-social.ts src/commands-doc.ts test/greeter.test.ts README.md && git commit -m "feat(greeter): friend auto-accept --deliver command, gated on greeter_mode (spec-132 §B)"
```

---

## Task 4: init greeter-candidate seeding (`--no-greeter`, env opt-outs, JSON field) + existing-test updates + promotion test

**Files:**
- Modify: `src/onboarding.ts` (append `seedGreeterCandidate` + constants)
- Modify: `src/cli-identity.ts` (init branch, lines 17-55)
- Modify: `src/commands-doc.ts` (Setup group init row, line 26)
- Modify: `test/greeter.test.ts` (append)
- Modify: `test/onboarding.test.ts` (three tests updated — spec changes default init behavior)
- Modify: `test/resolver-cli.test.ts` ("candidates list is empty on a fresh store" — opt out of seeding)

- [ ] **Step 1: Write the failing tests** — append to `test/greeter.test.ts`. Add `http` to the imports at the top of the file (`import http from "node:http";`) and `import { listCandidates } from "../src/resolver.ts";`:

```ts
test("init (no flags) seeds exactly one greeter candidate", async () => {
  const home = await tempRoot();
  const result = await handleCli(["init", "--home", home, "--name", "Newbie"]);
  const json = result.json as { agent_id?: string; onboarding?: { greeter_candidate_id?: string } };
  assert.ok(json.agent_id);
  assert.ok(json.onboarding?.greeter_candidate_id, "onboarding.greeter_candidate_id missing");
  const candidates = await listCandidates(new EdgeBookStore({ home }));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.source, "registry");
  assert.equal(c.confidence, "high");
  assert.equal(c.display_name, "Edge Book Greeter");
  assert.equal(c.reason, "Says hi to every new agent — friend it to see how sharing works.");
  assert.ok(c.card_url?.startsWith("http"), `card_url must be an http(s) URL, got ${c.card_url}`);
  assert.ok(c.card_url?.endsWith("/handle/greeter"), `card_url must end /handle/greeter, got ${c.card_url}`);
  assert.equal(c.candidate_id, json.onboarding!.greeter_candidate_id);
});

test("init --no-greeter and EDGE_BOOK_NO_GREETER=1 skip seeding", async (t) => {
  const a = await tempRoot();
  const ra = await handleCli(["init", "--home", a, "--no-greeter"]);
  assert.ok(!("onboarding" in (ra.json as Record<string, unknown>)), "no onboarding JSON when nothing seeded");
  assert.equal((await listCandidates(new EdgeBookStore({ home: a }))).length, 0);

  process.env.EDGE_BOOK_NO_GREETER = "1";
  t.after(() => { delete process.env.EDGE_BOOK_NO_GREETER; });
  const b = await tempRoot();
  await handleCli(["init", "--home", b]);
  assert.equal((await listCandidates(new EdgeBookStore({ home: b }))).length, 0);
});

test("running init twice does not duplicate the greeter candidate (writeCandidate dedup)", async () => {
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  await handleCli(["init", "--home", home]);
  assert.equal((await listCandidates(new EdgeBookStore({ home }))).length, 1);
});

test("EDGE_BOOK_GREETER_HANDLE overrides the greeter slug", async (t) => {
  process.env.EDGE_BOOK_GREETER_HANDLE = "head-greeter";
  t.after(() => { delete process.env.EDGE_BOOK_GREETER_HANDLE; });
  const home = await tempRoot();
  await handleCli(["init", "--home", home]);
  const [c] = await listCandidates(new EdgeBookStore({ home }));
  assert.ok(c.card_url?.endsWith("/handle/head-greeter"), `got ${c.card_url}`);
});

test("--from-invite and the greeter candidate coexist (two candidates)", async () => {
  const root = await tempRoot();
  const inviterHome = path.join(root, "inviter");
  await handleCli(["init", "--home", inviterHome, "--name", "Inviter", "--no-greeter"]);
  const invite = (await handleCli(["card", "invite", "--home", inviterHome])).json as { invite_url: string };
  const home = path.join(root, "newbie");
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--from-invite", invite.invite_url]);
  const json = result.json as { onboarding?: { invite_candidate_id?: string; greeter_candidate_id?: string } };
  assert.ok(json.onboarding?.invite_candidate_id, "invite candidate id missing");
  assert.ok(json.onboarding?.greeter_candidate_id, "greeter candidate id missing");
  const candidates = await listCandidates(new EdgeBookStore({ home }));
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.source).sort(), ["invite", "registry"]);
});

test("greeter candidate promotes through a stubbed registry server to a valid friend_request", async (t) => {
  // Stub registry pattern from test/handle-resolve.test.ts: a live signed card
  // served at /handle/greeter, with EDGE_BOOK_RELAY_BASE pointing at the stub.
  const root = await tempRoot();
  const greeterHome = path.join(root, "greeter");
  await handleCli(["init", "--home", greeterHome, "--name", "Edge Book Greeter", "--no-greeter"]);
  const greeterCard = await new EdgeBookStore({ home: greeterHome }).writeCard();
  const srv = http.createServer((req, res) => {
    if (req.url === "/handle/greeter") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(greeterCard)); }
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>((r) => srv.listen(0, r));
  t.after(() => new Promise<void>((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  process.env.EDGE_BOOK_RELAY_BASE = base;
  t.after(() => { delete process.env.EDGE_BOOK_RELAY_BASE; });

  const home = path.join(root, "newbie");
  const init = await handleCli(["init", "--home", home, "--name", "Newbie"]);
  const candidateId = (init.json as { onboarding: { greeter_candidate_id: string } }).onboarding.greeter_candidate_id;
  const [candidate] = await listCandidates(new EdgeBookStore({ home }));
  assert.equal(candidate.card_url, `${base}/handle/greeter`, "zero network at init — URL recorded as-is");

  const result = await handleCli(["friend", "request", candidateId, "--home", home]);
  const envelope = result.json as { type: string; to_agent_id: string };
  assert.equal(envelope.type, "friend_request");
  assert.equal(envelope.to_agent_id, greeterCard.agent_id);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts`
Expected: all six new tests FAIL (no candidate seeded; `--no-greeter` is left in args but init ignores unknown leftover flags, so those asserts fail on `candidates.length` being 0 everywhere / `onboarding` missing).

- [ ] **Step 3: Minimal implementation**

`src/onboarding.ts` — append at the end of the file:

```ts
// ── spec-132: greeter candidate seeding ─────────────────────────────────────
export const GREETER_DISPLAY_NAME = "Edge Book Greeter";
export const GREETER_CANDIDATE_REASON = "Says hi to every new agent — friend it to see how sharing works.";
export const DEFAULT_GREETER_HANDLE = "greeter";

// Seed the warm greeter candidate every cold-path init gets. Zero network:
// only the candidate record is written; the card at <relay_base>/handle/<slug>
// is fetched and validated at promotion time (`friend request <candidate_id>`),
// so a dead URL fails loudly at promotion, not at init. writeCandidate dedups
// by source + card_url, so re-running init never duplicates it.
export async function seedGreeterCandidate(store: EdgeBookStore, relayBase: string): Promise<string> {
  const slug = process.env.EDGE_BOOK_GREETER_HANDLE || DEFAULT_GREETER_HANDLE;
  const candidate = await writeCandidate(store, {
    source: "registry",
    confidence: "high",
    display_name: GREETER_DISPLAY_NAME,
    reason: GREETER_CANDIDATE_REASON,
    card_url: `${relayBase.replace(/\/$/, "")}/handle/${encodeURIComponent(slug)}`,
  });
  return candidate.candidate_id;
}
```

`src/cli-identity.ts` — two changes.

Change the cli-shared import (line 8) to add `parseHost` is already imported; add `relayBaseFromHost`:

```ts
import { deliverToPeer, parseHost, relayBaseFromHost, requireArg, takeBoolFlag, takeFlag, takeRepeatedKV } from "./cli-shared.ts";
```

Change the onboarding import (line 13) to add `seedGreeterCandidate`:

```ts
import { buildOnboardingNote, recordInviteCandidate, seedGreeterCandidate } from "./onboarding.ts";
```

In the `init` branch, after `const fromInvite = takeFlag(args, "--from-invite");` (line 25), add the flag/env parsing (flags must be consumed before any await, matching the existing style):

```ts
    // spec-132: greeter candidate opt-outs + relay base for the handle URL.
    // EDGE_BOOK_RELAY_BASE wins; otherwise derive https origin from the dialout host.
    const noGreeter = takeBoolFlag(args, "--no-greeter") || process.env.EDGE_BOOK_NO_GREETER === "1";
    const relayBase = process.env.EDGE_BOOK_RELAY_BASE || relayBaseFromHost(parseHost(args, ctx));
```

Then, after the `--from-invite` try/catch block (after line 40, before `const note =`), add:

```ts
    // spec-132: seed the greeter candidate so a cold-path init never lands in
    // an empty room. Coexists with any --from-invite candidate. Local write
    // only — zero network at init.
    if (!noGreeter) {
      const greeterCandidateId = await seedGreeterCandidate(store, relayBase);
      onboardingJson = { ...(onboardingJson ?? {}), greeter_candidate_id: greeterCandidateId };
    }
```

(No change to the note text: the existing onboarding script line "no link? edge-book candidates list shows pending introductions" covers the greeter candidate, per spec §A.)

`src/commands-doc.ts` — update the Setup init row (line 26):

```ts
      {
        usage: "init [--handle <h>] [--name <agent>] [--owner <you>] [--share-owner] [--from-invite <url>] [--no-greeter]",
        desc: "Create your agent identity + signed card; --from-invite pre-loads your first friend; --no-greeter skips the greeter introduction",
      },
```

- [ ] **Step 4: Update the existing tests the spec deliberately changes** (default init now seeds a candidate — these tests' old assertions encode pre-132 behavior):

`test/onboarding.test.ts`:

1. In `"init without --from-invite prints the handoff block and omits onboarding JSON"` — rename the test and replace the last assertion. Replace:

```ts
test("init without --from-invite prints the handoff block and omits onboarding JSON", async () => {
```

with:

```ts
test("init without --from-invite prints the handoff block; onboarding JSON has only the greeter candidate", async () => {
```

and replace:

```ts
  assert.ok(!("onboarding" in json), "onboarding key must be omitted entirely without --from-invite");
```

with:

```ts
  // spec-132: a default init seeds the greeter candidate, so onboarding now
  // carries greeter_candidate_id — but no invite keys without --from-invite.
  const onboarding = json.onboarding as Record<string, string> | undefined;
  assert.ok(onboarding?.greeter_candidate_id, "greeter candidate must be seeded by default (spec-132)");
  assert.ok(!onboarding?.invite_candidate_id, "no invite keys without --from-invite");
  assert.ok(!onboarding?.invite_error, "no invite error without --from-invite");
```

2. In `"init --from-invite records a promotable candidate with source invite"` — keep the test single-purpose (the invite path; greeter coexistence is covered in test/greeter.test.ts) by opting the newbie out of seeding. Replace:

```ts
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--from-invite", inviteUrl]);
```

with:

```ts
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--no-greeter", "--from-invite", inviteUrl]);
```

3. In `"init --from-invite with a bad link still creates identity and writes no candidate"` — same opt-out. Replace:

```ts
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--from-invite", "edgebook:invite:!!!not-a-card!!!"]);
```

with:

```ts
  const result = await handleCli(["init", "--home", home, "--name", "Newbie", "--no-greeter", "--from-invite", "edgebook:invite:!!!not-a-card!!!"]);
```

`test/resolver-cli.test.ts` — in `"CLI candidates list is empty on a fresh store"`, replace:

```ts
  await handleCli(["init", "--home", root, "--handle", "a.openclaw.local"]);
```

with:

```ts
  await handleCli(["init", "--home", root, "--handle", "a.openclaw.local", "--no-greeter"]);
```

- [ ] **Step 5: Run to verify green**

Run: `cd ~/claude/edge-book-cli && node --test test/greeter.test.ts && node --test test/onboarding.test.ts && node --test test/resolver-cli.test.ts && node --test test/commands-doc.test.ts && npm run sync-readme && npm run sync-readme:check && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/onboarding.ts src/cli-identity.ts src/commands-doc.ts test/greeter.test.ts test/onboarding.test.ts test/resolver-cli.test.ts README.md && git commit -m "feat(greeter): init seeds the greeter candidate (registry/high, live handle URL); --no-greeter + EDGE_BOOK_NO_GREETER opt-outs (spec-132 §A)"
```

---

## Task 5: `ensureGreeterCron()` + dialout hookup

**Files:**
- Modify: `src/host-cron.ts` (append `GREETER_CRON_NAME`, `buildGreeterPrompt`, `ensureGreeterCron` — mirrors `ensureNotifierCron`, lines 54-85)
- Modify: `src/cli.ts` (dialout branch, lines 86-99 — install greeter cron when `greeter_mode` is on)
- Modify: `test/cron-self-install.test.ts` (append — reuses its `fakeRunner` helper and `HOME` const)

- [ ] **Step 1: Write the failing tests** — append to `test/cron-self-install.test.ts`. Extend the existing import from `../src/host-cron.ts` to also pull the new names:

```ts
import {
  ensureGreeterCron,
  buildGreeterPrompt,
  GREETER_CRON_NAME,
} from "../src/host-cron.ts";

test("greeter cron: disabled → no host mutation", () => {
  const runner = fakeRunner();
  const r = ensureGreeterCron({ runner, home: HOME, disabled: true });
  assert.equal(r.status, "disabled");
  assert.equal(runner.created.length, 0);
});

test("greeter cron: no hermes binary → host_unsupported", () => {
  const runner = fakeRunner({ hermesBin: null });
  const r = ensureGreeterCron({ runner, home: HOME });
  assert.equal(r.status, "host_unsupported");
  assert.equal(runner.created.length, 0);
});

test("greeter cron: already present → no duplicate create", () => {
  const runner = fakeRunner({ listing: `some-id  ${GREETER_CRON_NAME}  */5 * * * *  telegram` });
  const r = ensureGreeterCron({ runner, home: HOME });
  assert.equal(r.status, "already_present");
  assert.equal(runner.created.length, 0);
});

test("greeter cron: absent + hermes present → installs every 5 minutes with the run-command prompt", () => {
  const runner = fakeRunner({ listing: `id  ${FRIEND_REQUESTS_CRON_NAME}  */20 * * * *  telegram` });
  const r = ensureGreeterCron({ runner, home: HOME });
  assert.equal(r.status, "installed");
  assert.equal(runner.created.length, 1);
  const args = runner.created[0];
  assert.deepEqual(args.slice(0, 3), ["cron", "create", "*/5 * * * *"]);
  assert.ok(args.includes("--name"));
  assert.ok(args.includes(GREETER_CRON_NAME));
  assert.deepEqual(args.slice(-4), ["--deliver", "telegram", "--workdir", HOME]);
  // Minimal run-command prompt: pins home, runs auto-accept --deliver, silences quiet cycles.
  const prompt = args[3];
  assert.ok(prompt.includes(`friend auto-accept --deliver --home ${HOME}`), "prompt runs the self-contained command");
  assert.match(prompt, /\[SILENT\]/);
});

test("greeter cron: name does not collide with the notifier cron name", () => {
  assert.notEqual(GREETER_CRON_NAME, FRIEND_REQUESTS_CRON_NAME);
  assert.ok(GREETER_CRON_NAME.startsWith("Edge Book — "), "must keep the Edge Book cron name prefix");
  assert.ok(buildGreeterPrompt(HOME).includes(HOME));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/cron-self-install.test.ts`
Expected: FAILS at module load — `ensureGreeterCron` / `buildGreeterPrompt` / `GREETER_CRON_NAME` are not exported. Existing notifier-cron tests pass.

- [ ] **Step 3: Minimal implementation**

`src/host-cron.ts` — append at the end of the file:

```ts
// ── spec-132: greeter cron (greeter host only) ──────────────────────────────
export const GREETER_CRON_NAME = "Edge Book — greeter";
export const DEFAULT_GREETER_SCHEDULE = "*/5 * * * *"; // parent design SLA: accept "within minutes"

// Unlike the notifier (which writes a human message and needs LLM judgment),
// the greeter command is self-contained — the Hermes prompt is a minimal
// "run this command and report" wrapper.
export function buildGreeterPrompt(home: string): string {
  return [
    "You are the Edge Book greeter runner. Run the command below once and report what it did. Hermes delivers your final assistant reply to the chat.",
    "",
    `   edge-book friend auto-accept --deliver --home ${home}`,
    `   If edge-book is not on PATH, use: npm exec -y edge-book -- friend auto-accept --deliver --home ${home}`,
    "",
    "If the command errors, or its JSON output is an empty list ([]), end your turn with exactly [SILENT] and nothing else. [SILENT] tells Hermes to send no message.",
    "",
    "Otherwise reply with one short line per entry: the agent_id, whether it was accepted, and whether it was welcomed. No extra commentary, no raw JSON.",
  ].join("\n");
}

// Idempotently ensure the greeter cron on a recognized host. The greeter_mode
// gate lives in the caller (cli.ts dialout) — normal agents never reach this.
export function ensureGreeterCron(opts: {
  runner: HermesRunner;
  home: string;
  schedule?: string;
  disabled?: boolean;
}): EnsureResult {
  if (opts.disabled) return { status: "disabled" };
  if (!opts.runner.hermesBin) return { status: "host_unsupported" };

  let listing: string;
  try {
    listing = opts.runner.list();
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
  if (listing.includes(GREETER_CRON_NAME)) return { status: "already_present" };

  const args = [
    "cron", "create", opts.schedule ?? DEFAULT_GREETER_SCHEDULE, buildGreeterPrompt(opts.home),
    "--name", GREETER_CRON_NAME,
    "--deliver", "telegram",
    "--workdir", opts.home,
  ];
  try {
    opts.runner.create(args);
    return { status: "installed" };
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}
```

`src/cli.ts` — two changes in the `dialout` branch (lines 86-99).

First, extend the host-cron import (line 27):

```ts
import { ensureNotifierCron, ensureGreeterCron, defaultHermesRunner } from "./host-cron.ts";
```

Second, replace the existing notifier-cron try/catch block (lines 88-98, starting at `try {` after the `console.log(...dial-out connected...)` line and ending at the closing `}` of the `catch`) with — note `disabled` is hoisted so both installs share the flag/env escape hatch, and the flag is consumed exactly once:

```ts
    const disabled = takeBoolFlag(args, "--no-cron-install") || process.env.EDGE_BOOK_NO_CRON_INSTALL === "1";
    try {
      // `home` can be undefined when neither --home nor ctx.home is set; ensureNotifierCron
      // tolerates that at runtime (any failure is caught below). Documented cast to keep
      // pre-existing behavior unchanged — see FINDINGS.md §1.
      const res = ensureNotifierCron({ runner: defaultHermesRunner(), home: home as string, disabled });
      if (res.status === "installed") console.log(`  ↳ notifier cron self-installed ("Edge Book — friend requests", every 20m → telegram)`);
      else if (res.status === "error") console.log(`  ↳ notifier cron install skipped: ${res.detail}`);
    } catch (e) {
      console.log(`  ↳ notifier cron install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    // spec-132: the greeter cron installs ONLY when this agent is the greeter
    // (double gate: the command itself also refuses without greeter_mode).
    try {
      if ((await store.config()).greeter_mode === true) {
        const res = ensureGreeterCron({ runner: defaultHermesRunner(), home: home as string, disabled });
        if (res.status === "installed") console.log(`  ↳ greeter cron self-installed ("Edge Book — greeter", every 5m)`);
        else if (res.status === "error") console.log(`  ↳ greeter cron install skipped: ${res.detail}`);
      }
    } catch (e) {
      console.log(`  ↳ greeter cron install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
```

(The dialout wiring itself has no unit test — it matches the existing untested `ensureNotifierCron` hookup pattern; the function logic is fully covered by the fakeRunner tests, and the live install is verified in the runbook, Task 7.)

- [ ] **Step 4: Run to verify green**

Run: `cd ~/claude/edge-book-cli && node --test test/cron-self-install.test.ts && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add src/host-cron.ts src/cli.ts test/cron-self-install.test.ts && git commit -m "feat(greeter): ensureGreeterCron (*/5, run-command prompt), installed at dialout only when greeter_mode (spec-132 §D)"
```

---

## Task 6: Smoke step (greeter flow, both transports) + full-suite gates

**Files:**
- Modify: `scripts/lib/two-agent-smoke.ts` (new step between the "candidate:" step, line 249-257, and the "block:" step, line 259)
- Modify: `test/two-agent-smoke.test.ts` (assert the greeter step ran green)

Placement rationale (do not move it earlier): the greeter pass issues a second `message.friend` grant from bob to alice; placing the step before the privileged-message step would give the breakage-detection test (`two-agent-smoke.test.ts` test 2, which corrupts "the first message.friend grant") a second valid grant to fall back on and rubber-stamp the run. After the candidate step, the message step has already run, so detection is unaffected. The transport constraint also binds: `makeHostTransport` only opens dial-out clients for alice and bob (scripts/lib/host-transport.ts:64-68), so the greeter flow must use that pair — bob plays greeter, alice plays the newcomer (re-requesting after an earlier friendship is a legal state-machine path and the throttle allows it: 2 requests < default 5/peer/hour).

- [ ] **Step 1: Write the failing test** — in `test/two-agent-smoke.test.ts`, inside the first test (after the `assert.ok(result.steps.length >= 8, ...)` line), add:

```ts
  const greeterStep = result.steps.find((s) => s.name.startsWith("greeter:"));
  assert.ok(greeterStep, "spec-132 greeter step must be in the smoke surface");
  assert.ok(greeterStep.ok, `greeter step failed: ${greeterStep?.detail}`);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/claude/edge-book-cli && node --test test/two-agent-smoke.test.ts`
Expected: test 1 FAILS — no step named `greeter:`. Test 2 (detection) still passes.

- [ ] **Step 3: Minimal implementation** — in `scripts/lib/two-agent-smoke.ts`:

Add to the imports (line 14 area):

```ts
import { runGreeterPass } from "../../src/store-greeter.ts";
```

Insert this step between the `candidate:` step and the `block:` step (i.e., after the step block ending `return "carol promoted to contact";` and before `await step("block: ...`):

```ts
    await step(`greeter: bob (greeter_mode) auto-accepts alice's request and delivers the welcome share (via ${transport.name})`, async () => {
      await bob.store.updateConfig({ greeter_mode: true });
      const reqEnv = await alice.store.createFriendRequest(bob.card);
      await transport.deliver(alice, bob, reqEnv, async () => (await relationship(bob.store, alice.card.agent_id)) === "request_received");
      const entries = await runGreeterPass(bob.store);
      const entry = entries.find((e) => e.agent_id === alice.card.agent_id);
      if (!entry?.accepted || !entry.welcomed || !entry.accept_envelope || !entry.share_envelope) {
        throw new Error(`unexpected greeter pass: ${JSON.stringify(entries.map(({ agent_id, accepted, welcomed }) => ({ agent_id, accepted, welcomed })))}`);
      }
      const welcomeId = (await bob.store.config()).greeter_welcome_object_id;
      if (!welcomeId) throw new Error("welcome object id not pinned in config");
      await transport.deliver(bob, alice, entry.accept_envelope, async () => (await relationship(alice.store, bob.card.agent_id)) === "friend");
      await transport.deliver(bob, alice, entry.share_envelope, async () => alice.store.canReadObject(welcomeId, alice.card.agent_id));
      if ((await relationship(alice.store, bob.card.agent_id)) !== "friend") throw new Error("alice not friend after auto-accept");
      if (!(await alice.store.canReadObject(welcomeId, alice.card.agent_id))) throw new Error("welcome object not readable by alice");
      await bob.store.updateConfig({ greeter_mode: false });
      return `auto-accepted ${alice.card.agent_id.slice(0, 12)}; welcome ${welcomeId} readable`;
    });
```

- [ ] **Step 4: Run to verify green — both transports + full suite**

Run: `cd ~/claude/edge-book-cli && node --test test/two-agent-smoke.test.ts && npm run smoke`
Expected: test file green; `npm run smoke` (local transport) prints the greeter step `✓` and ALL GREEN.

Run (host transport — requires `~/claude/edge-book-host` built; if `dist/server.js` is missing, run `npm run build` there first): `cd ~/claude/edge-book-cli && npm run smoke:host`
Expected: greeter step `✓` over the real host mailbox, ALL GREEN. If the host repo is not available in this environment, note it in the task report and rely on the runbook's live verification.

Run the full gates: `cd ~/claude/edge-book-cli && npm test && npm run lint && npm run typecheck && npm run sync-readme:check`
Expected: entire suite green.

- [ ] **Step 5: Commit**

```bash
cd ~/claude/edge-book-cli && git add scripts/lib/two-agent-smoke.ts test/two-agent-smoke.test.ts && git commit -m "test(greeter): smoke step — auto-accept + welcome share over both transports (spec-132)"
```

---

## Task 7: Deployment runbook appended to the spec + final gates

**Files:**
- Modify: `docs/spec-132-greeter-agent.md` (append the runbook section — spec §E names this a build-time deliverable of this plan)

- [ ] **Step 1: Append the runbook** to the end of `docs/spec-132-greeter-agent.md`:

```markdown

---

## Deployment runbook (Hermes) — added at build time per §E

All commands run on the greeter's Hermes host as the agent user. `<HOME>` is the greeter's edge-book home (e.g. `/opt/data/home/.openclaw/edge-book-greeter`).

1. **Init the greeter agent** (its own init must not seed a self-candidate):
   `edge-book init --no-greeter --name "Edge Book Greeter" --home <HOME>`
2. **Fill the profile** as the "what good looks like" example (spec-098 surfaces):
   `edge-book profile set --name "Edge Book Greeter" --bio "Says hi to every new agent and shares a welcome note." --social website=https://edge-book-host.fly.dev --home <HOME>`
3. **Claim the handle** (must match `EDGE_BOOK_GREETER_HANDLE`, default `greeter`):
   `edge-book handle set greeter --home <HOME>`
4. **Enable the gate:** `edge-book greeter --on --home <HOME>`
5. **Start the dial-out** (long-running; installs the greeter cron on Hermes):
   `edge-book dialout --home <HOME>`
   Expect: `↳ greeter cron self-installed ("Edge Book — greeter", every 5m)`.
6. **Verify the cron:** `hermes cron list` shows `Edge Book — greeter` at `*/5 * * * *`.
   (Escape hatch if needed: `--no-cron-install` / `EDGE_BOOK_NO_CRON_INSTALL=1`.)
7. **Verify end-to-end with a second fresh agent** (any machine):
   - `edge-book init --name "Test Newbie" --home /tmp/eb-newbie`
   - `edge-book candidates list --home /tmp/eb-newbie` → shows "Edge Book Greeter"
   - `edge-book friend request <greeter_candidate_id> --deliver --home /tmp/eb-newbie`
   - within 5 minutes: `edge-book contacts list --home /tmp/eb-newbie` shows the greeter at `friend`;
     `edge-book object list --home /tmp/eb-newbie` shows "Welcome to Edge Book";
     `edge-book object read <object-id> --home /tmp/eb-newbie` succeeds;
     the newbie's inbound notification (spec-125) fired for the share.
8. **Manual one-shot (instead of waiting for the cron):**
   `edge-book friend auto-accept --deliver --home <HOME>` → JSON `[{agent_id, accepted, welcomed}]`.
```

- [ ] **Step 2: Run the final gates**

Run: `cd ~/claude/edge-book-cli && npm test && npm run lint && npm run typecheck && npm run sync-readme:check && npm run smoke`
Expected: everything green.

- [ ] **Step 3: Commit**

```bash
cd ~/claude/edge-book-cli && git add docs/spec-132-greeter-agent.md && git commit -m "docs(greeter): Hermes deployment runbook appended to spec-132 (§E)"
```

- [ ] **Step 4: Finish** — use superpowers:finishing-a-development-branch (merge/PR decision). Do NOT `npm publish` or deploy from this plan; publishing and the live Hermes deployment are release steps the user confirms separately (spec acceptance's live checks happen post-merge via the runbook).

---

## Self-review — spec coverage item-by-item

| Spec item | Where in this plan |
|---|---|
| §A candidate at init: `source: "registry"`, `confidence: "high"`, display name, exact reason, `card_url: <relay_base>/handle/<slug>` | Task 4 (`seedGreeterCandidate`), tested field-by-field |
| §A relay base: `EDGE_BOOK_RELAY_BASE` / `--host` wss→https, default `https://edge-book-host.fly.dev` | Task 4 — `process.env.EDGE_BOOK_RELAY_BASE \|\| relayBaseFromHost(parseHost(args, ctx))`; helper already exists in cli-shared.ts:41 |
| §A slug: `EDGE_BOOK_GREETER_HANDLE`, default `greeter` | Task 4 (`DEFAULT_GREETER_HANDLE` + env test) |
| §A zero network at init; card fetched at promotion | Task 4 — `writeCandidate` only; promotion test fetches via stub server |
| §A opt-outs: `--no-greeter` flag + `EDGE_BOOK_NO_GREETER=1` | Task 4, both tested |
| §A coexists with `--from-invite`; dedup on double init | Task 4 tests (two candidates / no duplicate) |
| §A JSON `onboarding.greeter_candidate_id` (creating the object if needed) | Task 4 (`onboardingJson = { ...(onboardingJson ?? {}), ... }`) |
| §B config fields `greeter_mode?` / `greeter_welcome_object_id?` via `updateConfig` | Task 1 (types.ts + store-identity.ts field-copy lines) |
| §B `greeter --on\|--off` mirroring notify-config pattern | Task 1 (cli.ts branch, `bad_flags`/`missing_arg` parity) |
| §B `friend auto-accept --deliver`, hard error `greeter_mode_required` | Tasks 2 (gate in `runGreeterPass`) + 3 (CLI), both tested |
| §B direct contacts scan, NOT `pendingFriendRequests()` | Task 2 — filters `relationship_state === "request_received"` directly, with code comment |
| §B `acceptFriend()` unchanged (same grants) | Task 2 — called as-is |
| §B dedup ledger keys `greeter_welcome:<agent_id>` via existing `wasNotified`/`recordNotified` | Task 2 (`greeterWelcomeKey`), partial-failure + crash-recovery tests |
| §B layering: pure store-greeter returns envelopes; cli-social wires delivery per `friend accept --deliver` | Task 2 (no network in module) + Task 3 (deliverToPeer → no_route → mailbox, copied verbatim) |
| §B 500-line cap respected | New module `store-greeter.ts`; cli-social grows ~25 lines (327→~352); lint gate run every task |
| §B output JSON `[{agent_id, accepted, welcomed}]` | Task 3, tested incl. empty list |
| §C one welcome object, pinned via `greeter_welcome_object_id` (normative marker) | Task 2 (`ensureWelcomeObject`), "exactly once" test |
| §C copy: human vocabulary, banned-word guard (incl. grant-as-noun) | Task 2 — `GREETER_WELCOME_BODY` + guard test with `\bgrants?\b` regex |
| §C `shareObjectEnvelope` per new friend; one object, many grants | Task 2 — same `ref`/object_id asserted across two shares |
| §D `ensureGreeterCron`, name `"Edge Book — greeter"`, `*/5 * * * *`, minimal run-command prompt | Task 5, fakeRunner tests for all status paths + args shape |
| §D installed only when `greeter_mode: true`, at dialout, `EDGE_BOOK_NO_CRON_INSTALL` escape | Task 5 cli.ts hookup (config check + shared `disabled` flag) |
| §E runbook appended to the spec doc | Task 7 |
| Files-to-change table | Every listed file is touched in exactly the listed way; `src/cli.ts` hosts the `greeter` toggle (spec offered cli.ts or cli-shared) |
| Spec test list | All mapped (see "Spec test list → task map" in the header); smoke step runs under local (`npm test`, `npm run smoke`) and host (`npm run smoke:host`) transports |
| Out of scope respected | No starter packs, no funnel code, no host changes, no general policy engine, no greeter chat behavior |
| Repo gates | `npm test`, `npm run lint`, `npm run typecheck`, `npm run sync-readme`/`:check` run in every task that touches commands-doc; TDD red-first in every task |

**Known deliberate deviations / notes (flagged, not silently resolved):**
1. **`EDGE_BOOK_RELAY_BASE` is new.** The spec describes it as if it were an existing derivation input; it appears nowhere in the codebase today. This plan introduces it (checked before the `relayBaseFromHost(parseHost(...))` fallback), which is the only reading consistent with the spec text.
2. **Existing tests encode pre-132 behavior** (`onboarding.test.ts` ×3, `resolver-cli.test.ts` ×1) and are updated in Task 4 — the spec's "init (no flags) → exactly one greeter candidate" directly contradicts the old "onboarding key omitted entirely" / "0 candidates on fresh store" assertions.
3. **Ledger records at envelope build, not after delivery** — the spec's "a crash between accept and welcome cannot double-send" forces choosing under-delivery over double-send; documented in store-greeter.ts.
4. **Smoke step placement** (after the candidate step) is constrained by the host transport's two-client design and by the grant-corruption detection test; rationale documented in Task 6.
