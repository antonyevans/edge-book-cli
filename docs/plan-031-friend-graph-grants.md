# Build Plan — 031 (Friend-Graph Grants Hardening)

> Gate deliverable for `ea-openclaw-031`, scope **"Friend-graph grants first"** (Antony, 2026-06-08).
> Built from the `ea-openclaw-030` judge-passed authoring spec. Resolver/Index discovery is OUT of scope this pass.

## Problem (one line)

Capability grants are signed on issue (`signPayload`, edge-book.ts:793) but **never verified on use**. A forged/tampered grant marked `status:"active"` passes every friend-gated access check — spec check #6 is unimplemented at all three gate sites.

## Gap vs spec's 11 access checks

Already covered: contact-exists (1), friend-state (2), grant-exists (4), direction (5), status (7), expiry (8), and the entire envelope layer — signature (9), replay (10), recipient+expiry (11) — via `verifyEnvelope`.

Missing / to build:
- **#6 grant signature verification** — the core fix, all three sites.
- **#3 explicit block** — currently only implicit via `state !== "friend"`; add explicit `blocked` denial + audit.
- **Unification** — collapse the three duplicated grant checks into one helper (031 directive: build once, consume everywhere).

## Files to change (NB: repo is flat `src/`, not `plugins/edge-book/src/` as the spec's pre-standalone path says)

- `src/edge-book.ts`
  - **NEW** `verifyGrantSignature(grant): Promise<boolean>` — resolve issuer's accepted public key from `contacts[grant.issuer_agent_id].public_keys[0]`, verify `verifyPayload(withoutSignature(grant), grant.signature, key)`; fail closed on unknown key. Mirrors `verifyEnvelope`'s key-resolution.
  - **NEW** `assertFriendGrant({ peerAgentId, scope, direction, at })` — single access-check path running checks 1–8 incl. signature + explicit block; writes a `grant.denied` audit event on failure with the failing check. Throws typed `EdgeBookError`.
  - **REFACTOR** `findUsableGrant` (1304), `sendPrivilegedMessage` (814), `receivePrivilegedMessage` (838), feed-read gate (~1655) → consume `assertFriendGrant`. Keep `object.read` / `canReadObject` (1155) consistent — add the same `verifyGrantSignature` call there too (object grants have the same hole).
- No CLI surface change (`src/cli.ts` untouched this pass — no new command).

## Tests (TDD — write red first)

- **NEW** `test/grant-access.test.ts`:
  - valid signed grant → access granted (message + feed + object).
  - forged grant (valid fields, bad/empty signature) → denied `invalid_grant_signature` + audit written.
  - tampered grant (scope/expiry mutated after signing) → denied.
  - wrong-direction grant → denied.
  - revoked / expired / status-flipped grant → denied.
  - blocked peer with otherwise-valid grant → denied `blocked`.
  - unknown issuer key → fail closed.
- **EXTEND** `test/edge-book.test.ts` + ensure `runFeedPrivacyHarness` (1893) still green.
- Run: `node --test test/*.test.ts` — full suite must stay green (currently 40/40).

## Out of scope (next passes)

`edge-book resolve`, candidate/provenance store, Index fixture provider, `--approve` flow — all deferred to the resolver/discovery pass.

## Acceptance (subset of 030 relevant to this scope)

- [ ] Message send/recv requires `friend` + active **signature-verified** `message.friend` grant.
- [ ] Feed read requires `friend` + active **signature-verified** `feed.read.friends` grant.
- [ ] Revoked, expired, unsigned, invalid-signature, wrong-direction, blocked → denied with audit evidence.
- [ ] One shared access-check helper; no duplicated grant logic.
- [ ] Full suite green.
