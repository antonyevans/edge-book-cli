# LEARNINGS — edge-book-cli

_Last gardening pass: 2026-06-11_

Actionable lessons from incidents, refactors, and design episodes: what future
sessions should do differently. Complements `FINDINGS.md` (grandfathered
exceptions, tool evaluations, incident-fixture cross-refs, the `## Reversions`
log — facts: date/PR/cause) and the specs in `docs/` (intent). No duplication:
an entry may cite a FINDINGS entry or spec, never restate it. **Two-strikes
rule:** first occurrence of a lesson = an entry here; second occurrence =
promote it to a formal rule in `CLAUDE.md` and mark the entry superseded. Keep
this file under ~100 lines of entries; the monthly gardening pass (spec-0038)
prunes it.

> Cross-repo note: the transport decision (host-relayed mailbox now, XMTP
> later) and the contract-authorship lessons live in
> `edge-book-host/docs/LEARNINGS.md` — the host owns the canonical
> `src/contracts.ts`. This repo mirrors those types by spec (see CLAUDE.md
> frozen surfaces) and vendors the wire-frame schema.

### 2026-06-09 — God file → size gates enforced by an exit-2 hook

**Trigger:** refactor PRs #2 (llm-legibility), #4 (llm-hygiene-gates),
#5 (size-compliance); second strike during spec-098.
**Observation:** `src/edge-book.ts` had become the god file — PR #2 extracted
types, crypto/fs helpers, card validation, and the `store-*.ts` feature
modules out of it (plus `dashboard-html.ts` out of `http.ts`). PR #4 installed
the gates: `max-lines: 500` (error) in `eslint.config.mjs` plus the
PostToolUse hook `.claude/hooks/lint-edited-file.mjs`, which exits 2 on
violation so the agent sees the lint output and self-corrects in-session
(exit 1 would NOT block). PR #5 paid down the grandfathered
`eslint-disable max-lines` comments by further splitting `cli.ts`,
`dialout.ts`, and `edge-book.ts`. Second strike: spec-098 broke the max-lines
gate on `http.ts` with a disable; commit `aa85d98` restored it by extracting
the dev/file relay.
**Action:** New behavior goes in a new `store-*.ts` / `cli-*.ts` module per the
DESIGN.md routing table — never appended to an existing near-cap file. Treat
any `eslint-disable max-lines` as deferred work with a follow-up extraction
task; the exit-2 PostToolUse hook pattern is proven and is the template for
future agent-enforced gates.
**Confidence:** high
**Status:** active

### 2026-06-10 — Instrumentation deferred is debugging over Telegram

**Trigger:** decision 2026-06-10-edge-book-debug-harness (EA repo,
`04-decisions/made/`); specs 133/134/135 (docs/spec-133-doctor-event-log.md,
spec-134-doctor-send-support.md, spec-135-record-replay.md).
**Observation:** Observability was deliberately deferred through the MVP. The
cost: when real users hit friend-connection failures, the evidence was split
across three machines we can't see (user's Hermes host, our relay, the
counterparty), so debugging meant interrogating users over Telegram. The
payoff wave shipped as PRs #12–#16: NDJSON protocol event log + `edge-book
doctor` bundle (spec-133), trace_id stamped inside signed envelopes (ea-claude-138),
`doctor --send` support channel over the existing mailbox (spec-134), and
record-replay fixtures (spec-135). Key sequencing rule that worked: trace IDs
landed *before* the messaging milestone, so send/receive was born traceable.
Host-side half: `edge-book-host/docs/LEARNINGS.md` (2026-06-09 entry).
**Action:** Every new protocol surface emits event-log entries and is visible
in `doctor` from its first PR. Before starting a milestone, land its
observability hooks first — retrofitting them after the first user bug report
costs a debug-harness program.
**Confidence:** high
**Status:** active

### 2026-06-10 — Greeter: compose existing machinery, point at live URLs

**Trigger:** spec-132 (docs/spec-132-greeter-agent.md), PR #6.
**Observation:** The network cold-start fix did NOT need a new kind of agent.
The greeter is a normal edge-book agent plus two small config-gated
capabilities: `friend auto-accept --deliver` (hard-gated on `greeter_mode` so
no normal agent stumbles into auto-accepting strangers) and a single welcome
object shared per new friend — all driven by existing machinery:
`writeCandidate` seeding at init, the `ensureNotifierCron` pattern
(src/host-cron.ts), the `recordNotified` dedup ledger (store-notify.ts), and
`acceptFriend` unchanged. Two design moves worth reusing: (1) the seeded
candidate's `card_url` points at the live handle route
(`<relay>/handle/greeter`), not a frozen card snapshot, so greeter key/card
refreshes never strand newcomers; (2) `store-greeter.ts` is pure — it returns
envelopes, the CLI handler wires delivery — keeping the network edge in one
place.
**Action:** Before designing a new agent role or subsystem, inventory the
existing primitives (candidates, crons, ledgers, grants) and compose them;
gate dangerous behaviors on explicit config, not convention. Long-lived
references to another agent must use its handle URL, never an embedded/frozen
card (see the stale-card incident fixture in FINDINGS.md).
**Confidence:** high
**Status:** active

### 2026-06-11 — Incidents must leave a fixture or a waiver

**Trigger:** June 9 friending incident (ea-claude-130) → spec-0045
incident-to-fixture pipeline (EA repo), PR #23.
**Observation:** The June 9 incident (stale frozen-card invite → mail orphaned
to a DID no channel claimed) was fixed, but nothing initially pinned it
against regression. spec-0045 made fixture-creation the default exit path for
every production incident: PR #23 shipped replay-fixture schema 0.2 with a
mandatory `provenance` block (`origin: real | synthetic | synthetic-promoted`
+ resolvable `source_ref`), validated in `npm test`, and the first two
`origin: real` fixtures — `test/replay/fixtures/stale-card-friend-request-rejected.json`
and `queued-friend-request-offline-recipient-outbox.json` (see FINDINGS.md
"Incident fixtures" for the full cross-ref table). Equally important was what
was declined: no 3rd "real" fixture was fabricated, and the dedup fixture
stayed `synthetic` because claiming incident confirmation would be provenance
inflation.
**Action:** A session that resolves a production incident either adds a
provenance-tagged replay fixture under `test/replay/fixtures/` or records an
explicit waiver (literal word "waiver") naming why none is derivable —
"existing tests cover it" does not count. Never promote a fixture's provenance
beyond what was actually observed.
**Confidence:** high
**Status:** active
