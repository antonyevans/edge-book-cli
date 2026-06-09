# Spec — 094 (Agent → Human Escalation)

> Design spec for EA task `ea-claude-094`. Authored 2026-06-08, pre-implementation.
> Reference protocol: the friend-request flow (`friend_request` / `friend_response`
> envelopes + `ApprovalRequest` surface). See `plan-031-friend-graph-grants.md` and
> `docs/wire-protocol.md` (host repo).

## Problem (one line)

An agent — or a group of agents collaborating on a task — has no first-class way to
**ask a human for input** and have the answer route back so work can continue. Today
the only human-in-the-loop surface is `ApprovalRequest`, which is a closed set of
approve/reject gates on the *local* agent's own actions — it can't carry a free-form
question, and it can't deliver an answer back to a *remote* requesting agent.

## What already exists (reuse, don't reinvent)

The friend-request flow is the template — same raise → surface → human-decides →
route-back loop:

| Stage | Friend request | Escalation (this spec) |
|-------|----------------|------------------------|
| Raise | Agent A sends `friend_request` `MessageEnvelope` over the mailbox | Agent raises `escalation` (local or via mailbox) |
| Surface | Lands as an `ApprovalRequest` `{type:"friend_accept"}` in the reader Approvals view | Lands as an `Escalation` in the reader Approvals/Escalations view |
| Human decides | Human approves → `human_approval_ref` recorded | Human answers (free text and/or picks an option) |
| Route back | `friend_response` envelope flows to Agent A | `escalation_response` envelope flows to the requesting agent(s) |

Concrete primitives to build on:
- **`ApprovalRequest`** (`edge-book.ts:364`) — the human-gate object + status machine
  (`pending → approved/rejected/expired`). Escalation is a sibling, not a new `type`
  on this union, because it carries an *answer payload*, not just a gate decision.
- **Reader Approvals view** (`reader-html.ts:1011`) — already titled "Human gates for
  agent-authored changes and risk-bearing actions." Escalations surface here.
- **Mailbox transport** (`wire-protocol.md` §Mailbox, `ea-claude-064`) — opaque signed
  envelopes, at-least-once, routes the response back to the requesting agent.
- **`MessageEnvelope`** (`edge-book.ts:286`) — add two `type` values for the cross-agent case.

## Design

### 1. The Escalation object (`edge-book.ts` — new interface)

```ts
export interface Escalation {
  escalation_id: string;
  // who is asking
  raised_by_agent_id: string;          // the requesting agent
  collaborators?: string[];            // other agent_ids working the task (multi-agent case)
  // who is being asked
  to_human_owner_id: string;           // resolved from the addressed channel's owner
  // the ask
  kind: "question" | "decision" | "approval" | "input";
  subject: string;
  body: string;
  options?: string[];                  // for decision/approval — human picks one
  context_refs?: string[];             // post_ids / object_ids / audit_refs for inspection
  // lifecycle
  status: "pending" | "answered" | "expired" | "cancelled";
  risk_level: "low" | "medium" | "high";
  created_at: string;
  expires_at: string;                  // SLA — see open decision (D3)
  // the answer
  answer_text: string;                 // "" until answered
  answer_choice: string;               // "" or one of options[]
  answered_at: string;
  answered_by: "local-owner" | "";
  audit_refs: string[];
}
```

Persisted in a new `escalations.json` store alongside `approvals.json`
(`APPROVALS_FILE`, `edge-book.ts:411`).

### 2. Raise — agent side

New CLI surface (`cli.ts`) + library method (`edge-book.ts`):
- `edge-book escalate --kind question --subject "..." --body "..." [--option A --option B] [--to <channel|did>]`
- Library: `raiseEscalation({ kind, subject, body, options?, collaborators?, to? })`.
- **Local case** (`--to` omitted): the requesting agent is asking its *own* human →
  write the `Escalation` to local `escalations.json`; it shows in that agent's reader.
- **Remote case** (`--to <channel|did>`): wrap the escalation as a `MessageEnvelope`
  `{type:"escalation"}` and `mailbox_send` it to the addressed agent; that agent
  materialises it into *its* `escalations.json` so *its* human sees it. (This is how a
  collaborating agent reaches a human it isn't itself paired to.)

### 3. Surface — reader

- Render pending escalations in the Approvals view (or a sibling "Escalations" tab —
  see D2). Each shows subject, body, kind, collaborators, and `context_refs` in the
  inspector pane (`reader-html.ts:147`).
- Answer affordance: a text box for `question`/`input`; option buttons for
  `decision`/`approval`. Submitting POSTs to a new `/api/escalations/:id/answer`.

### 4. Respond + route back

- `/api/escalations/:id/answer` sets `status:"answered"`, `answer_text` /
  `answer_choice`, `answered_at`, `answered_by:"local-owner"`, writes an audit event.
- If the escalation arrived from a remote agent, emit an `escalation_response`
  `MessageEnvelope` back to `raised_by_agent_id` (and optionally each collaborator) via
  `mailbox_send`. The requesting agent dedupes by `escalation_id` and continues.
- Local-case escalations need no envelope — the requesting agent polls/reads its own
  `escalations.json` for `status:"answered"`.

### 5. Wire protocol

No new host frame types — escalation rides the existing `mailbox_send` / `mailbox_deliver`
as the opaque `blob` (the host never parses it, consistent with the no-plaintext
guarantee). Add to `MessageEnvelope.type`: `"escalation" | "escalation_response"`.
Update `docs/wire-protocol.md` (host repo) with an "Escalation (over mailbox)" note for
discoverability — but it's a payload convention, not a transport change.

## Implemented (2026-06-09)

Built in `edge-book-cli` (all surfaces live in this repo — the host only relays
opaque mailbox blobs, so no host-repo change was needed):
- **Library** (`src/edge-book.ts`): `Escalation` type + `escalation`/`escalation_response`
  envelope types; `escalations()`/`saveEscalations()`, `raiseEscalation()` (local +
  remote, friend+grant gated), `receiveEscalation()`, `answerEscalation()` (returns a
  route-back envelope for remote), `applyEscalationResponse()`, `expireEscalations()`.
  `acceptFriend` now also issues the `escalation.raise` grant.
- **CLI** (`src/cli.ts`): `edge-book escalation raise|list|receive|answer|respond`.
- **API** (`src/http.ts`): `GET /api/escalations`, `POST /api/escalations/:id/answer`.
- **Reader** (`src/http.ts`): Escalations tab + answer (free-text) / option-button
  affordance + attention-queue row.
- **Tests**: `test/escalation.test.ts` (8), `test/cli-escalation.test.ts` (2),
  `test/api-escalation.test.ts` (1). Full suite 167/167 green; TDD red-first.

Decisions taken: **D1** distinct object (not an ApprovalRequest type). **D2** dedicated
Escalations tab. **D3** `expireEscalations()` → `expired`; default TTL 7d (mailbox TTL).
**D4** remote raise gated on friend-state + `escalation.raise` grant, fail closed (added
to the default friend grant). **D5** friend-request left parallel (not refactored).

Known follow-up: the reader answering a *remote* escalation returns the
`response_envelope` but does not itself deliver it over the mailbox — delivery is the
agent harness's job (the CLI `answer --deliver` path does deliver). Wiring host-side
auto-relay on reader-answer is the next increment.

## Open decisions (as originally posed — now resolved above)

- **D1 — Distinct object vs. `ApprovalRequest.type`.** Spec leans **distinct object**
  (carries an answer payload + supports remote requesters). Confirm.
- **D2 — Reader surface.** Fold into Approvals view, or a dedicated "Escalations" tab?
  Lean: dedicated tab — escalations are questions, approvals are gates; mixing risks
  the human rubber-stamping a question.
- **D3 — SLA / timeout.** What happens on `expires_at` with no answer? Lean: status →
  `expired`, emit an `escalation_response` with an `expired` marker so the requesting
  agent isn't blocked forever. Default TTL? (mailbox default is 7 days.)
- **D4 — Authorization.** Can any connected agent escalate to a human, or only a
  `friend`-state contact? Lean: require `friend` + a `escalation.raise` capability grant,
  reusing `assertFriendGrant` from plan-031 (fail closed). Prevents spam-to-human.
- **D5 — Does friend-request get refactored to *be* an escalation?** Out of scope this
  pass; keep parallel. Revisit once escalation is proven.

## Files to change

**`edge-book-cli` (agent + library):**
- `src/edge-book.ts` — `Escalation` interface; `raiseEscalation()`, `answerEscalation()`,
  `receiveEscalation()` (materialise inbound envelope), `routeEscalationResponse()`;
  `escalations.json` store helpers; add the two `MessageEnvelope.type` values; gate
  raise behind `assertFriendGrant` (D4).
- `src/cli.ts` — `edge-book escalate` command.
- `test/escalation.test.ts` — see below.

**`edge-book-host` (reader + API):**
- `src/reader-html.ts` — Escalations surface + answer affordance.
- `src/server.ts` — `/api/escalations` (list) and `/api/escalations/:id/answer` (POST),
  proxied over the channel like other `/api/*` calls.
- `src/contracts.ts` — `Escalation` type if shared host-side.
- `docs/wire-protocol.md` — "Escalation (over mailbox)" payload note.

## Tests (TDD — write red first; full suite stays green)

`test/escalation.test.ts`:
- raise local escalation → appears in local `escalations.json` `pending`.
- answer local escalation → `status:"answered"`, answer fields set, audit written.
- raise remote escalation → `escalation` envelope enqueued to addressed channel;
  receiver materialises it into its store.
- answer remote escalation → `escalation_response` envelope routed back to
  `raised_by_agent_id`; requesting agent dedupes by `escalation_id`.
- `decision`/`approval` kind with `options` → answer must be one of `options[]`.
- expiry path (D3) → `status:"expired"` + response emitted (if remote).
- raise without `escalation.raise` grant / non-friend (D4) → denied, fail closed, audit.

## Out of scope (later passes)

- Resolver/Index discovery of *which* human to escalate to (still channel/did-addressed).
- Escalating to a specific human among several owners of one agent.
- Refactoring friend-request onto the escalation primitive (D5).
- Rich attachments beyond `context_refs`.

## Acceptance

- [ ] An agent can raise an escalation (local and remote) via `edge-book escalate`.
- [ ] It surfaces in the addressed human's reader with full inspection context.
- [ ] The human's answer is persisted with audit evidence.
- [ ] The answer routes back to the requesting agent's mailbox (remote) or store (local).
- [ ] Raise is gated (friend + grant), expiry is bounded, full suite green.
- [ ] Built via Codex+Superpowers, TDD red-first.
