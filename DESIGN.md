# edge-book-cli — design rules for new code

Read this BEFORE writing code. `ARCHITECTURE.md` is the map of what exists;
this file says where NEW code goes and what size limits apply.

## Where new code goes

| You are adding… | It goes in… |
|---|---|
| a new CLI command | dispatch block in `src/cli.ts` + entry in `src/commands-doc.ts`; logic in a feature module, NOT inline in `cli.ts` |
| new store behavior (friends, objects, posts, …) | the matching `src/store-<concern>.ts` free-function module + a one-line delegate on `EdgeBookStore`. New concern → NEW `store-<concern>.ts` file |
| a new owner `/api/*` endpoint | handler in `src/http.ts` only if <30 lines; otherwise a new `src/http-<feature>.ts` module called from the route table |
| a new shared type | `src/types.ts` (flag contract-frozen shapes in its header) |
| dial-out / wire-frame handling | `src/dialout.ts` (frame shapes frozen by host `docs/wire-protocol.md`) |
| local dashboard UI | `src/dashboard-html.ts` (hosted reader lives in the host repo) |
| notification / cron behavior | `src/notify.ts` / `src/host-cron.ts` |
| a shared utility | a new `src/<name>.ts` with one clear responsibility |
| **anything you are unsure about** | **a NEW file — never append to an existing one** |

Appending to a large open file because it is already in context is the
failure mode these rules exist to prevent. Creating a new module is always
an acceptable answer; growing a 500-line file is not.

## Size limits (enforced by ESLint + agent hook + CI)

- **Files: 500 code lines max** (`max-lines`, error). Blank lines and comments
  don't count. At ~300 lines, plan the split before continuing.
- **Functions: 80 code lines** (warn) — long dispatch/handler functions are the
  seed of god files; extract per-feature helpers.
- **Complexity: 15** (warn).
- A `/* eslint-disable max-lines */` requires a justification comment naming
  why splitting would tear one coherent concern, and a follow-up task to
  extract. Current grandfathered files are listed at the top of each disable.

## Module conventions

- `store-*.ts` modules export free functions `fn(store, …)`; `EdgeBookStore`
  keeps same-named one-line delegates. The class API is what tests specify.
- Internal imports use explicit `.ts` extensions.
- Names encode intent (`handleFriendRequestAccept`, not `handle`). Internal
  renames are fine; everything in ARCHITECTURE.md "frozen surfaces" is not.
- Comments state invariants and constraints ("serialized to disk — spec-096"),
  not mechanics.

## When you split a file

1. Extract by feature (vertical slice), not by layer.
2. Update `ARCHITECTURE.md` module table in the same commit.
3. Full test suite green after every extraction step — one extraction per commit.
