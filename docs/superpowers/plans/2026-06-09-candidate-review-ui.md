# Edge Book Candidate-Review UI (ea-claude-086) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Let non-CLI / hosted-reader users review resolver-discovered first-contact **Candidates** — see provenance, then Approve (→ send the friend request) or Reject (→ drop) — instead of approval being CLI-only.

**Architecture:** Agent owns the candidate graph (already built in `src/resolver.ts`); the host/reader stays presentation/proxy. Add `GET /api/candidates`, `POST /api/candidates/:id/promote`, `POST /api/candidates/:id/reject` to `src/http.ts`, and a reader Candidates surface. Approve returns the friend_request envelope under `response_envelope`, so the existing generalized relay (`maybeRelayResponseEnvelope` in `src/dialout.ts`, from Plan C) auto-delivers it. One new store fn: `dropCandidate`.

**Tech Stack:** TS (ESM, node20), `node --test`, `tsup`. No new deps. Base: `main` (`a68daeb`; resolver, profiles, notifications, approvals, abuse floor all shipped). Baseline suite green (189/189), smoke 10/10.

**Existing anchors (read first):**
- `src/resolver.ts`: `Candidate` (`:21` — `{candidate_id, source, confidence, display_name?, reason, network?, card_url?, approved, created_at}`), `listCandidates` (`:176`), `getCandidate` (`:180`), `markCandidateApproved` (`:227`), `promoteCandidate(store, candidateId, note)` (`:235`, returns the friend_request `MessageEnvelope`; internally loads the card + `createFriendRequest` + marks approved), `CANDIDATES_FILE` (`:164`), `writeCandidate` (`:184`).
- `src/http.ts`: the `/api/approvals/:id/resolve` handler (returns `{approval, response_envelope}`) and the `/api/contacts/:id/report` handler are the endpoint templates; the reader's `dashboardHtml` nav/state/attention-queue/view-render/action-dispatch is the UI template (Approvals view + `approval-approve` dispatch).
- `src/dialout.ts`: `maybeRelayResponseEnvelope` already relays ANY API response carrying `response_envelope` — promote will relay for free.

---

## File Structure

| File | Change |
|---|---|
| `src/resolver.ts` | add `dropCandidate(store, candidateId)` |
| `src/http.ts` | `GET /api/candidates`, `POST /api/candidates/:id/promote`, `POST /api/candidates/:id/reject`; reader Candidates view + attention-queue row + state hydration |
| `test/candidate-ui.test.ts` | new — endpoints (promote returns envelope + marks approved; reject drops) |

---

## Task 1: `dropCandidate` (TDD)

**Files:** `src/resolver.ts`; `test/candidate-ui.test.ts` (new)

- [ ] **Step 1: Failing test** — create `test/candidate-ui.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EdgeBookStore } from "../src/edge-book.ts";
import { writeCandidate, listCandidates, dropCandidate } from "../src/resolver.ts";

async function store() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-cand-"));
  const s = new EdgeBookStore({ home });
  await s.init({ handle: "a.openclaw.local", displayName: "Agent A" });
  return s;
}

test("dropCandidate removes the candidate", async () => {
  const s = await store();
  const c = await writeCandidate(s, { source: "index", confidence: "low", display_name: "Stranger", reason: "match", card_url: "https://example/card.json" } as any);
  assert.equal((await listCandidates(s)).length, 1);
  await dropCandidate(s, c.candidate_id);
  assert.equal((await listCandidates(s)).length, 0);
});
```

(Confirm `writeCandidate`'s `CandidateInput` shape from `src/resolver.ts:166` and match it — adjust the object above to the real required fields.)

- [ ] **Step 2:** Run `node --test test/candidate-ui.test.ts` → FAIL (`dropCandidate` undefined).

- [ ] **Step 3: Implement** in `src/resolver.ts` (mirror `markCandidateApproved`):

```typescript
export async function dropCandidate(store: EdgeBookStore, candidateId: string): Promise<void> {
  const map = await readJson<Record<string, Candidate>>(store.file(CANDIDATES_FILE), {});
  if (!map[candidateId]) return;
  delete map[candidateId];
  await writeJson(store.file(CANDIDATES_FILE), map);
}
```

- [ ] **Step 4:** Run → PASS; full suite green; `npm run build`. Commit: `feat(candidates): dropCandidate store fn`

## Task 2: API endpoints (TDD)

**Files:** `src/http.ts`; `test/candidate-ui.test.ts` (append)

- [ ] **Step 1: Failing test** — append, copying the in-process HTTP harness from `test/api-escalation.test.ts` / the existing approvals API test (open it and reuse its `postApi`/server setup verbatim):

```typescript
test("GET /api/candidates lists; POST promote returns a friend_request response_envelope + marks approved", async () => {
  const s = await store();
  // A candidate must have a card_url promote can load. Use a second real agent's card file.
  const peerHome = await fs.mkdtemp(path.join(os.tmpdir(), "eb-peer-"));
  const peer = new EdgeBookStore({ home: peerHome });
  await peer.init({ handle: "peer.openclaw.local", displayName: "Peer" });
  await peer.writeCard(); // writes the card file
  const peerCardPath = path.join(peerHome, "openclaw-agent.json");
  const c = await writeCandidate(s, { source: "card_file", confidence: "high", display_name: "Peer", reason: "card", card_url: `file://${peerCardPath}` } as any);

  const list = await getApi(s, "/api/candidates");
  assert.ok((list.json.candidates as any[]).some((x) => x.candidate_id === c.candidate_id));

  const promote = await postApi(s, `/api/candidates/${c.candidate_id}/promote`, {});
  assert.equal(promote.json.response_envelope.type, "friend_request");
  // candidate is now approved
  const after = (await listCandidates(s)).find((x) => x.candidate_id === c.candidate_id);
  assert.equal(after?.approved, true);
});

test("POST /api/candidates/:id/reject drops it", async () => {
  const s = await store();
  const c = await writeCandidate(s, { source: "index", confidence: "low", display_name: "X", reason: "m", card_url: "https://e/c.json" } as any);
  const res = await postApi(s, `/api/candidates/${c.candidate_id}/reject`, {});
  assert.equal(res.json.dropped, true);
  assert.equal((await listCandidates(s)).length, 0);
});
```

(`getApi`/`postApi` = whatever the existing api test uses; copy its setup.)

- [ ] **Step 2:** Run → FAIL (endpoints 404).

- [ ] **Step 3: Implement** in `src/http.ts` (place beside the approvals/report handlers; import `listCandidates`, `promoteCandidate`, `dropCandidate`, `getCandidate` from `./resolver.ts`):

```typescript
  if (req.method === "GET" && url.pathname === "/api/candidates") {
    sendJson(res, 200, { candidates: await listCandidates(store) });
    return true;
  }
  const candPromote = /^\/api\/candidates\/([^/]+)\/promote$/.exec(url.pathname);
  if (req.method === "POST" && candPromote) {
    const id = decodeURIComponent(candPromote[1]);
    const candidate = await getCandidate(store, id);
    if (!candidate) { sendJson(res, 404, { error: "unknown_candidate" }); return true; }
    if (!candidate.card_url) { sendJson(res, 400, { error: "candidate_not_resolvable" }); return true; }
    const response_envelope = await promoteCandidate(store, id);
    sendJson(res, 200, { candidate: await getCandidate(store, id), response_envelope });
    return true;
  }
  const candReject = /^\/api\/candidates\/([^/]+)\/reject$/.exec(url.pathname);
  if (req.method === "POST" && candReject) {
    await dropCandidate(store, decodeURIComponent(candReject[1]));
    sendJson(res, 200, { dropped: true });
    return true;
  }
```

(Match the exact `sendJson`/handler signature used by neighboring handlers.)

- [ ] **Step 4:** Run → PASS; full suite green; build. Commit: `feat(candidates): /api/candidates list + promote (relays friend_request) + reject`

## Task 3: Reader Candidates surface

**Files:** `src/http.ts` (`dashboardHtml`)

- [ ] **Step 1:** Add a **Candidates** tab/view mirroring the Approvals view (it carries provenance, so a dedicated section is clearer than folding into Approvals): nav button + `state.candidates` + title/description + attention-queue row (`["Candidates", candidates.length, candidates.length ? "attention" : "neutral"]`) + count badge + hydration (`fetch('/api/candidates')` in the parallel load).
- [ ] **Step 2:** Render each candidate via the existing `item(...)` helper with facts showing provenance: `source`, `confidence`, `network` (if any), and `reason`; actions `Approve` (`data-action="candidate-approve"`) + `Reject` (`candidate-reject"`, danger).
- [ ] **Step 3:** In the click dispatch, map `candidate-approve` → `POST /api/candidates/:id/promote`, `candidate-reject` → `POST /api/candidates/:id/reject`, then refresh — mirroring how `approval-approve` is dispatched.
- [ ] **Step 4:** Build; full suite green; `npm run smoke` 10/10 (smoke doesn't use candidates; just confirm no breakage). Commit: `feat(candidates): reader Candidates view with provenance + approve/reject`

---

## Self-Review
- **Spec coverage (ea-claude-086):** reader shows pending candidates with provenance (T3); approve → `promoteCandidate` (fetch+validateCard+friend request, already in resolver) and relays the request (T2 + existing relay); reject → `dropCandidate` (T1/T2); host holds no graph authority — agent endpoints only (T2). ✅
- **Reuse:** promote/relay reuse `promoteCandidate` + `maybeRelayResponseEnvelope`; reader reuses the nav/attention/item/action patterns. Net-new is just `dropCandidate` + 3 endpoints + one view.
- **Cross-feature safety:** additive; no existing path changed. promote going through `createFriendRequest` means the *recipient's* abuse floor/throttle applies on their side — correct and intended.
- **No placeholders:** all net-new code given; test-harness helpers explicitly copy the existing api test.
