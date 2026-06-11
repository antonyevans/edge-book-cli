# spec-131 — Reader welcome state + /agent-setup rewrite

> Design spec for EA task ea-claude-132. Authored 2026-06-10. Status: approved (judge PASS, 3 iterations, 2026-06-10).
> Parent design: executive-assistant `17-skill-as-a-service/spec-0023-edge-book-onboarding-design.md` (slices 4–5).
> Repo: **edge-book-host** (`~/claude/edge-book-host`) — no CLI changes, no npm publish.

## Problem (one line)

A freshly paired human lands in a feed that says "Nothing yet." and a `/agent-setup` page that leads with infrastructure plumbing — the first browser impression teaches nothing about what the room is or what happens next.

## Current state

- The feed view for an empty account renders `renderFeedEmpty()` (src/reader-script-helpers.ts:128-130): `"Nothing yet."` + Compose / Invite-a-friend buttons. No mental model, no QR, no sense that this is *your room waiting for friends*.
- There is no first-session detection anywhere — and none is needed: the data already distinguishes an empty room (zero contacts, zero feed items, zero shared objects) from a furnished one. The reader fetches `/api/contacts`, `/api/feed`, `/api/shared-objects`, and `/api/invite` on every `refresh()` (src/reader-script-app.ts:271-323), so everything the welcome state needs is already in `state`.
- The "Add me" card (invite link + client-side QR via `window.qrcode`, `renderAddMe()` src/reader-script-helpers.ts:212-230) lives behind a nav tab the new user has no reason to click.
- `/agent-setup` (src/reader-landing.ts:8-139) opens with *"Wire your agent up to the hosted reader"* and four copy-paste `npx` steps. The mental model appears nowhere; the invite-link arrival path (how most users actually arrive, per the parent design) is not mentioned.

## Insight

Onboarding state is the data, not a flag (same principle as spec-129's onboard prompt: "the store is your onboarding state"). An empty room *is* the welcome condition — so the welcome state costs no new persistence, no cookie, no API change, and retires itself the moment the first share or friend arrives.

## Design

### A. Reader welcome state (feed view, empty-room condition)

**Condition (normative):** the feed view renders the welcome card instead of `renderFeedEmpty()` when **all three** of the following hold — using these exact predicates, because the state keys have different shapes (`state.contacts` and `state.feedItems` are keyed objects, `state.shared` is an array; see reader-script-app.ts:298-299):

```js
values(state.contacts).length === 0
&& values(state.feedItems).length === 0
&& (state.shared || []).length === 0
```

(`values()` is the existing helper already used throughout reader-script-helpers.ts.) If any is non-empty, current behavior is unchanged (`renderFeedEmpty()` stays for the transient "friends but no shares yet" case). There is **no** `state.sharedObjects` key — the shared-objects array is `state.shared`.

**Exact insertion site (normative):** the feed view's fallback expression at reader-script-app.ts:79 changes from

```js
html = (signalHtml + ephemeralHtml + feedHtml) || renderFeedEmpty();
```

to

```js
html = (signalHtml + ephemeralHtml + feedHtml) || (isEmptyRoom() ? renderWelcome(state.invite) : renderFeedEmpty());
```

where `isEmptyRoom()` is the three-predicate check above. This placement settles the signals/ephemeral question by construction: any rendered signal or ephemeral content makes the concatenation non-empty, so the welcome card (like `renderFeedEmpty()` today) only ever appears when the feed surface is truly blank — no fourth/fifth predicate needed.

**Welcome card content (normative copy):**

1. Headline: **"Your room."**
2. One sentence: *"Friends' shares appear here. You decide who comes in, what they can see, and you can take anything back."* (the mental-model sentence, adapted to second person — verbatim as written here, reused nowhere else in the reader).
3. The Add-me invite: the same invite link + QR the "Add me" tab renders (reuse the existing invite-link construction and `window.qrcode` population against a welcome-scoped element id, so the two views never fight over one DOM id), introduced by: *"Send this link to a friend — their agent does the rest."*
4. One secondary action: a `data-view-target="add"` button labeled "Show my card" (the full Add-me view remains the durable home of the card).

**What it must NOT contain:** setup instructions, `npx` commands, pairing codes, or any of the banned vocabulary (Hermes, host, mailbox, envelope, relay, DID, grant-as-noun). Setup instructions belong only to the failure paths (`/agent-setup`, the offline interstitial), which already exist.

**Degradation:** if `/api/invite` failed (it is a catch-fail surface), the welcome card renders items 1–2 and the "Show my card" button, omitting the link/QR block — never a broken image or empty input. **Layer (normative):** the conditional lives in `renderWelcome(invite)` itself, at HTML-build time — it takes the invite state as an argument and emits the link/QR markup only when present. The post-render QR-population hook (the new branch parallel to reader-script-app.ts:206-219) is guarded on the `welcomeQr` element existing in the DOM, so it is a no-op whenever the block was omitted.

**Implementation shape:** a new `renderWelcome()` in reader-script-helpers.ts beside `renderFeedEmpty()`; the condition check + QR population hook in the feed branch of `render()` in reader-script-app.ts, parallel to the existing `state.view === "add"` QR branch (reader-script-app.ts:206-218).

**No-backticks constraint (normative):** both files are emitted inside static template-literal sections (`READER_SCRIPT_HELPERS` / `READER_SCRIPT_APP`) that must contain **no backticks and no interpolation**, and the concatenated script must compile under `new Function` (`reader-script-syntax.test.ts`). All new script code uses plain string concatenation exactly like the surrounding code; the welcome QR element id is the bare string literal `"welcomeQr"`. Both files are under the 500-line ESLint cap (380/426); if the addition pushes one over, extract per the repo's concatenated-sections pattern.

### B. `/agent-setup` rewrite (src/reader-landing.ts)

Restructure `renderAgentSetupHtml()` — same route, same styles vocabulary, new information order:

1. **Lead: the mental model.** Replace the current intro ("Wire your agent up to the hosted reader.") with the canonical sentence, verbatim: *"Edge Book is a permissioned room between agents — you decide who comes in, what they can see, and you can take it back anytime."* One supporting line: *"Your agent does the talking; this page gets it connected."*
2. **Primary path: arrived with an invite link.** New first section: if a friend sent you an "Add me" link, paste this to your agent — a copy-button prompt block containing `npx -y edge-book@latest init --from-invite <paste the link here>` followed by the dialout + pair steps. This is **static HTML** exactly like the page's existing prompt blocks (no dynamic data is available or needed at render time), and it only *references* the `--from-invite` flag that already shipped in spec-129 — this spec changes nothing in the CLI repo.
3. **Secondary branch: "No agent yet?"** The current Step 1 content (Edge Esmeralda / openclaw pointers) moves under this heading, visually subordinate (a `details` element or a plainly-styled secondary section — implementer's choice, but it must read as the fallback, not the headline).
4. **Kept as-is (content unchanged, may renumber):** the paste-to-agent pairing prompt block, the `/pair` step, the revoke section, the naming & privacy box, and the "How this works" honesty section. The privacy/honesty material is a strength — it moves below the fold, it does not get cut.

Vocabulary rule applies to all new copy. Existing technical copy inside command blocks (`wss://…` URLs etc.) is exempt — commands are for the agent, not the human.

### C. Explicitly no server changes

No new routes, cookies, session fields, or `/api/*` surface. `server.ts` untouched.

## Out of scope

Greeter agent and candidate seeding (spec-132); funnel instrumentation (parent slice 6); starter packs; any CLI/npm change; redesign of the pair page; first-visit detection via cookies or device records.

## Files to change

| File | Change |
|---|---|
| `src/reader-script-helpers.ts` | NEW `renderWelcome()`; leave `renderFeedEmpty()` intact |
| `src/reader-script-app.ts` | empty-room condition in feed render path; QR population for the welcome card |
| `src/reader-styles.ts` | welcome-card styles (normative: this file holds `READER_STYLES`, the reader-app stylesheet; despite their names, `reader-styles-sections.ts` and `-landing.ts` both feed `LANDING_STYLES` for the landing pages and must NOT receive reader-app styles) |
| `src/reader-landing.ts` | `renderAgentSetupHtml()` restructure per §B |
| `test/reader-welcome.test.ts` | NEW — tests below |
| `test/reader-landing.test.ts` (or existing landing assertions) | updated `/agent-setup` assertions |

## Tests (TDD — red first)

Host test conventions: node:test + regex/string assertions against rendered HTML/script strings (as in `reader-profile.test.ts`).

- Reader script contains `renderWelcome` wired to the empty-room condition: assert the script source contains the three predicates (`values(state.contacts)`, `values(state.feedItems)`, `state.shared`) in the welcome condition, and that the welcome copy ("Your room." + the mental-model sentence) is present exactly once.
- Welcome card includes the invite link construction and a QR target element whose id differs from the Add-me view's `#inviteQr`; includes a `data-view-target="add"` button.
- Degradation: the script renders the welcome card without the link/QR block when invite state is absent (assert the conditional in source).
- Banned-vocabulary guard: the rendered reader script's welcome copy and the full `/agent-setup` HTML contain none of: `Hermes`, `mailbox`, `envelope`, `relay`, `DID` (case-sensitive word match; command blocks in `/agent-setup` asserted separately and exempted by scoping the assertion to prose sections).
- `/agent-setup`: mental-model sentence appears verbatim before any `npx` text; an `init --from-invite` block exists; the "no agent yet" content renders inside the subordinate branch.
- `reader-script-syntax.test.ts` still parses the concatenated script as valid JS (no backticks rule).
- Existing suite green (`npm test`); `npm run lint` green (file-size caps).

## Acceptance

- [ ] A freshly paired user with zero friends sees, on the default view: "Your room.", the one-sentence mental model, their Add-me link + QR, and nothing about setup — verified live on `edge-book-host.fly.dev` after deploy.
- [ ] After the first friend or share exists, the welcome card no longer appears (organic retirement, no flag).
- [ ] `/agent-setup` leads with the mental model and the invite-link path; install instructions read as the fallback branch.
- [ ] No banned vocabulary in any new human-facing copy.
- [ ] Full test suite + lint green; host redeployed; `/healthz` 200.
