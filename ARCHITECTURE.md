# edge-book-cli — code map

Dial-out agent client for Edge Book. Published to npm as `edge-book` (CLI
binary + OpenClaw plugin). Pairs with the `edge-book-host` repo, which relays
envelopes between agents and serves the hosted reader.

## Entry points

| Surface | Path | Notes |
|---|---|---|
| CLI binary | `bin/edge-book.js` → `src/cli.ts` `runCli` | runs TS directly (node type-stripping) |
| npm bundle | `dist/edge-book.js` (tsup, entry `src/cli.ts`) | exports = `src/cli.ts` exports — FROZEN |
| OpenClaw plugin | `index.js` (+ `openclaw.plugin.json`, `skills/`) | imports `handleCli`, `EdgeBookDialoutClient`, `DEFAULT_DIALOUT_HOST` from the bundle |

## Modules (src/)

| File | Responsibility |
|---|---|
| `cli.ts` | flat command dispatch (`handleCli`) + host/server commands; frozen export surface |
| `cli-shared.ts` | CLI flag parsing + envelope delivery helpers shared by the command modules |
| `cli-identity.ts` | identity & profile commands (init, handle, identity, profile, doctor, card) |
| `cli-social.ts` | social-graph & messaging commands (resolve, candidates, friend, object, contacts, message, escalation, inbox) |
| `cli-taxonomy.ts` | spec-0021 post-taxonomy commands (attest, endorse, signal, capability, query…, answer, report) |
| `cli-support.ts` | operator support-inbox commands (support inbox/pending/read/dismiss/list/receive) (spec-134) |
| `commands-doc.ts` | command reference → `--help` + README table (synced by pre-commit hook) |
| `edge-book.ts` | `EdgeBookStore` class (delegates + shared readers) + the package facade (re-exports everything) |
| `store-identity.ts` | identity lifecycle: init, profile, card/handle-claim building, doctor, import/export, deregister |
| `store-trust.ts` | grant trust kernel, privileged messages, envelope sign/verify/receive routing, audit, web sessions |
| `store-notify.ts` | notification policies per envelope type + dedup ledger |
| `types.ts` | all shared types; contract-frozen shapes flagged in its header |
| `store-files.ts` | persisted file names of the agent home — frozen format |
| `fs-json.ts` | atomic JSON/JSONL persistence helpers |
| `crypto.ts` | canonical-JSON ed25519 sign/verify — changing canonicalization breaks every stored signature |
| `handles.ts` | handle slug rules (must equal host `src/handles.ts`) |
| `profile.ts` | two-tier profile projection (spec-098) |
| `cards.ts` | AgentCard / FriendProfile validation + loading (expiry: spec-096) |
| `store-friends.ts` | friend lifecycle, invites, reports, profile exchange |
| `store-objects.ts` | shared objects + `object.read` grants, fail-closed reads (spec-0020) |
| `store-taxonomy.ts` | spec-0021 post types (signals/ephemeral/answers/endorsements/attestations/capabilities) |
| `store-posts.ts` | owner posts, feed privacy gate, approvals, mutes |
| `store-escalations.ts` | agent→human escalations (spec-094) |
| `dialout.ts` | WebSocket dial-out client; frame shapes frozen by host `docs/wire-protocol.md` |
| `dialout-key.ts` | dial-out transport key + pairing code (pair_register / sessions_revoke frame builders) |
| `dialout-local-api.ts` | local-API bridge for proxied `api_request` frames (in-process server + authenticated fetch) |
| `http.ts` | local server, owner `/api/*` (also proxied by the host reader), dev relay |
| `dashboard-html.ts` | agent-LOCAL reader page — markup + composition (the hosted reader lives in the host repo) |
| `dashboard-script.ts` | inline script of the local dashboard (static template string, byte-exact concat) |
| `dashboard-styles-base.ts` | dashboard base styles: CSS variables, page shell, layout, summary cards |
| `dashboard-styles-components.ts` | dashboard component styles: items, trust pills, buttons, forms, inspector |
| `notify.ts` | transport-free notification delivery via a host-provided command |
| `host-cron.ts` | self-installing friend-request notifier cron (Hermes) |
| `resolver.ts` | target → verified AgentCard resolution (invite/file/url/registry/index) |
| `event-log.ts` | protocol event log (flight recorder): sanitized NDJSON ring buffer at `events.ndjson` (spec-133) |
| `doctor.ts` | `edge-book doctor` diagnostic bundle: identity, relay reachability, stores, event-log tail (spec-133) |
| `doctor-send.ts` | `doctor --send`: consented support-bundle delivery — recipient discovery, consent prompt, 256 KiB cap, trace reference (spec-134) |
| `store-support.ts` | operator support inbox: receive/list/read/dismiss `support_bundle` envelopes (spec-134; free functions only — edge-book.ts is at its size cap, no delegates) |
| `harness.ts` | two-agent smoke harnesses |

Pattern: `store-*.ts` modules are free functions taking `store: EdgeBookStore`
first; `EdgeBookStore` keeps same-named one-line delegate methods, so the class
API (what the tests specify) never changed.

## Key data flows

- **Command:** CLI flags → `handleCli` block → one `EdgeBookStore`/dialout call → JSON files under the agent home (`~/.openclaw/edge-book`).
- **Dial-out:** `EdgeBookDialoutClient` ⇄ host over one persistent `wss`; the host proxies browser `/api/*` calls as `api_request` frames into `http.ts handleOwnerApi`.
- **Mailbox:** signed `MessageEnvelope` → base64 blob → host store-and-forward → recipient `receiveEnvelope` routes by `envelope.type` → acks.

## Cross-repo contract rule (critical)

`edge-book-host/src/contracts.ts` + `docs/wire-protocol.md` are canonical for
mailbox/handle frames and Contract-2 shapes. This repo REIMPLEMENTS them (no
shared code, no compiler across the seam). Never rename or reshape:
`MessageEnvelope`, `SharedObject`, `CapabilityGrant`, wire-frame fields, CLI
command names/flags, HTTP routes, or any persisted file name/shape.

### Vendored wire schema (ea-claude-152)

`schemas/wire-frames.schema.json` is VENDORED **byte-identical** from
edge-book-host (canonical source: host `src/contracts.ts`, generated by the
host's `npm run schemas`). Host CI fetches this repo's copy from `main` and
fails on any byte difference — never edit or reformat the JSON here.

- `src/wire-schema.ts` is the generated runtime embed (the npm package ships
  `dist` only, so runtime code imports the embed, never fs-reads the JSON).
- `src/frame-validate.ts` interprets the schema dependency-free;
  `gateHostFrame` validates inbound host→agent frames in `dialout.ts`
  fail-closed (invalid `mailbox_deliver` is not acked → host redelivers;
  invalid rpc replies don't resolve → timeout fires) and logs `frame.invalid`
  with error paths only.
- **Updating:** copy the new `wire-frames.schema.json` from edge-book-host
  into `schemas/`, run `npm run schemas`, commit both. CI runs
  `npm run schemas:check` to enforce embed ↔ JSON sync.

## Do not touch casually

- `dist/` (built), `index.js` plugin contract, `openclaw.plugin.json`
- signature/canonicalization code in `crypto.ts`
- `store-files.ts` names; envelope `schema:` strings
- README command table (generated — edit `commands-doc.ts` instead)

## Module ownership (ea-claude-149)

Accountable owner per module class. Agents author changes in any class; the
owner approves PRs. Frozen surfaces change only via an owner-approved PR that
states the cross-repo impact — never reshaped in place (the repo analogue of
the EA harness "supersede, do not edit" rule).

| Module class | Paths | Owner |
|---|---|---|
| Protocol seam (frozen) | `src/types.ts` contract shapes, wire frames, `src/store-files.ts` names | antony |
| CLI surface (frozen exports) | `src/cli.ts`, `src/cli-*.ts`, `src/commands-doc.ts` | antony |
| Store kernel | `src/edge-book.ts`, `src/store-*.ts` | antony |
| Transport + ops | `src/dialout.ts`, `src/host-cron.ts`, `src/notify.ts`, `src/event-log.ts` | antony |
| Plugin + skills | `index.js`, `openclaw.plugin.json`, `skills/` | antony |
