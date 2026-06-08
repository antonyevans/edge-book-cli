# Contact Capability Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Show a peer agent's advertised capabilities in the Sanctum reader — propagate them on the signed Agent Card (spec-0021 R3: Capability Ad is a profile-attached identity descriptor), store them in the contact record on import/refresh, and render them under each contact.

**Architecture:** Two repos. (A) `edge-book-cli`: a peer's structured Capability Advertisements ride a new signed card field `advertised_capabilities`; `upsertContactFromCard` carries them into the contact record; `/api/contacts` already returns full records. (B) `edge-book-host`: the reader renders `contact.advertised_capabilities` in the People/contacts view, reusing the owner's capability renderer. Same propagation mechanism as `owner_label` (ea-claude-082).

**Tech Stack:** TS ESM, Node 20, `node --test` (cli) / `tsx --test` (host). ed25519 signing.

**Governing constraint:** spec-0021 R3 — Capability Advertisements use the A2A Agent Card schema, are versioned, and carry a `status` (active/deprecated, never hard-deleted). Capabilities are public/discoverable by design (NOT opt-in like the human name) — advertising is their purpose.

**Scope boundary:** Contact CAPABILITIES only. Out of scope (need the mailbox-delivery layer or the 072 flywheel): endorsements *received* about a contact, and other agents' signals/queries/answers/shares in your feed. Card field is additive + backward-compatible (old cards lack it; readers tolerate absence).

---

## PART A — edge-book-cli (card propagation)

### Task A1: Card carries advertised_capabilities (signed)

**Files:** Modify `src/edge-book.ts` (`AgentCard` ~line 47, `buildCard` ~line 600). Test: `test/contact-capabilities.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeBookStore, validateCard } from "../src/edge-book.ts";

async function tmp() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-cap-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "A" });
  return s;
}

test("buildCard includes advertised_capabilities (active + deprecated) and stays signed (R3)", async () => {
  const s = await tmp();
  const c1 = await s.advertiseCapability({ name: "code_review", version: "1.2.0", summary: "reviews diffs" });
  const c2 = await s.advertiseCapability({ name: "legacy", version: "0.9.0", summary: "old" });
  await s.deprecateCapability(c2.capability_id);
  const card = await s.buildCard();
  validateCard(card);  // signature still valid with the new field
  const ac = card.advertised_capabilities!;
  assert.equal(ac.length, 2);
  const byName = Object.fromEntries(ac.map((c: any) => [c.name, c]));
  assert.equal(byName.code_review.version, "1.2.0");
  assert.equal(byName.code_review.status, "active");
  assert.equal(byName.legacy.status, "deprecated");
});
```

- [ ] **Step 2: Run** `node --test test/contact-capabilities.test.ts` → FAIL (field absent). (Add the test file to `package.json` `test` script now.)

- [ ] **Step 3: Implement.** Add to `AgentCard` (after `capabilities: string[];` ~53):

```ts
  // spec-0021 R3: the agent's structured Capability Advertisements, carried on the
  // card so contacts can discover them. Public by design. Absent on older cards.
  advertised_capabilities?: Array<{ name: string; version: string; summary: string; status: "active" | "deprecated" }>;
```

In `buildCard`, before building `unsigned`, gather them, and add the field to `unsigned`:

```ts
    const caps = Object.values(await this.capabilities())
      .map((c) => ({ name: c.name, version: c.version, summary: c.summary, status: c.status }));
```
Then inside `unsigned`, after `capabilities: [...]`:
```ts
      ...(caps.length ? { advertised_capabilities: caps } : {}),
```

- [ ] **Step 4: Run** `node --test test/contact-capabilities.test.ts` → PASS; `npm test` full suite green.

- [ ] **Step 5: Commit**
```bash
git add src/edge-book.ts test/contact-capabilities.test.ts package.json
git commit -m "feat(cli): carry advertised_capabilities on the signed Agent Card (R3)"
```

### Task A2: Contact record stores advertised_capabilities

**Files:** Modify `src/edge-book.ts` (`AgentContactRecord` ~line 53; `upsertContactFromCard`). Test: same file.

- [ ] **Step 1: Write the failing test**

```ts
test("upsertContactFromCard carries advertised_capabilities into the contact (and drops them if removed)", async () => {
  const issuer = await tmp();
  await issuer.advertiseCapability({ name: "code_review", version: "1.0.0", summary: "x" });
  const card = await issuer.buildCard();
  const me = await tmp();
  const contact = await me.upsertContactFromCard(card, "friend");
  assert.equal(contact.advertised_capabilities?.length, 1);
  assert.equal(contact.advertised_capabilities?.[0].name, "code_review");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Add to `AgentContactRecord` (after `owner_label?` field):
```ts
  // The peer's advertised capabilities (from their card; absent if none / older card).
  advertised_capabilities?: Array<{ name: string; version: string; summary: string; status: "active" | "deprecated" }>;
```
In `upsertContactFromCard`, in the `next` record (after `owner_label: card.owner_label,`):
```ts
    advertised_capabilities: card.advertised_capabilities,
```

- [ ] **Step 4: Run** → PASS; `npm test` green; `npm run build` exit 0.

- [ ] **Step 5: Commit + bump**
```bash
node -e "const p=require('./package.json'); p.version='0.5.0'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
git add src/edge-book.ts test/contact-capabilities.test.ts package.json
git commit -m "feat(cli): store peer advertised_capabilities in contact record; bump 0.5.0"
```

---

## PART B — edge-book-host (reader rendering)

### Task B1: Refactor owner capability renderer to be reusable

**Files:** Modify `src/reader-html.ts` (`renderCapabilities` ~647). Test: `test/reader-contact-capabilities.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReaderHtml } from "../src/reader-html.js";
const html = renderReaderHtml({ csrf_token: "t", agent_online: true });

test("reader has a reusable capability-list renderer", () => {
  assert.match(html, /function renderCapabilityList/);
});
```

- [ ] **Step 2: Run** `npm test` → FAIL. (Add `test/reader-contact-capabilities.test.ts` to `package.json` `test` script.)

- [ ] **Step 3: Implement.** Replace `renderCapabilities` with a parameterized helper + a thin owner wrapper. The current `renderCapabilities` reads `values(state.capabilities)`; extract the list-rendering into `renderCapabilityList(caps)` taking an array:

```js
  function renderCapabilityList(caps) {
    if (!caps || !caps.length) return "";
    return '<div class="capabilities">' + caps.map(function (c) {
      var dep = c.status === "deprecated";
      return '<div class="capability' + (dep ? " deprecated" : "") + '"><div class="cap-name">' + escapeHtml(c.name) +
        (c.version ? ' <span class="cap-ver">v' + escapeHtml(c.version) + '</span>' : "") + (dep ? ' <span class="cap-tag">deprecated</span>' : "") + '</div>' +
        '<div class="cap-summary">' + escapeHtml(c.summary || "") + '</div></div>';
    }).join("") + '</div>';
  }
  function renderCapabilities() {
    var caps = values(state.capabilities);
    if (!caps.length) return "";
    return '<section class="card"><h3>Capabilities</h3>' + renderCapabilityList(caps) + '</section>';
  }
```

(`state.capabilities` is a map of the owner's `CapabilityAdvertisement`; `renderCapabilityList` takes the array form — the contact field is already an array. Confirm `values()` is used for the owner map.)

- [ ] **Step 4: Run** `npm test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/reader-html.ts test/reader-contact-capabilities.test.ts package.json
git commit -m "refactor(reader): reusable renderCapabilityList helper"
```

### Task B2: Render contact capabilities in the People view

**Files:** Modify `src/reader-html.ts` (contacts view ~957). Test: same file.

- [ ] **Step 1: Write the failing test**

```ts
test("contacts view renders each contact's advertised capabilities", () => {
  assert.match(html, /renderCapabilityList\(contact\.advertised_capabilities\)/);
});
```

- [ ] **Step 2: Run** `npm test` → FAIL.

- [ ] **Step 3: Implement.** In the `contacts` view block, append the capability list after each contact's `item(...)`. Find the per-contact `return item(...);` (~958–960) and change it to:

```js
        return item(contact.owner_label || contact.display_name || "Unnamed contact", (contact.aliases && contact.aliases[0]) || contact.card_url || peerEndpointLabel(contact), [
          state.mutes[contact.peer_agent_id] ? "muted" : "active"
        ], contact, contact.relationship_state === "blocked" ? "risk" : "", state.mutes[contact.peer_agent_id] ? "" : action("Mute", "contact-mute", contact.peer_agent_id), [
          ["relationship", labelize(contact.relationship_state)],
          ["grants", (contact.capability_grants || []).length],
          ["endpoint", (contact.known_endpoints || []).length ? "known" : "missing"],
          ["local posture", state.mutes[contact.peer_agent_id] ? "muted" : "active"]
        ], "", initials(contact.owner_label || contact.display_name || (contact.aliases && contact.aliases[0]) || contact.peer_agent_id))
          + renderCapabilityList(contact.advertised_capabilities);
```

(I.e. keep the existing `item(...)` call exactly, and append `+ renderCapabilityList(contact.advertised_capabilities)`. Match the CURRENT arguments of the existing call — copy them verbatim, only adding the trailing `+ renderCapabilityList(...)`.)

- [ ] **Step 4: Run** `npm test` → all pass; `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**
```bash
git add src/reader-html.ts test/reader-contact-capabilities.test.ts
git commit -m "feat(reader): render contact advertised capabilities in People view"
```

### Task B3: Browser acceptance (verification)

- [ ] Seeded preview: mock `/api/contacts` with one contact carrying `advertised_capabilities` (one active, one deprecated). Open the People (contacts) view in the gstack browser; confirm the contact card shows a capability list (deprecated greyed), zero console errors. Screenshot.

---

## Out of scope (follow-ups)
- Endorsements received about a contact (needs delivery/aggregation → 072).
- Other agents' signals/queries/answers/shares (needs mailbox delivery).
- Capability propagation over the mailbox on advertise (currently pull-on-card-refresh only).

## Done = (A) merge + publish 0.5.0; (B) merge + deploy — both owner-gated, after review + browser acceptance.
