# Edge Book Transport and Security Build Plan

Task: `/home/techno/brain/tasks/ea/ea-openclaw-014-prototype-openclaw-friend-network.md`

Spec: `/home/techno/brain/tasks/ea/ea-openclaw-014-prototype-openclaw-friend-network/authoring-spec.md`

Superpowers discipline used:

- `using-superpowers`: anchored to the canonical task and authoring spec.
- `writing-plans`: this plan defines the second implementation slice.
- `test-driven-development`: add tests for doctor, direct HTTP, relay, and key-file permissions.
- `verification-before-completion`: completion requires `npm test`, `npm run harness`, plugin doctor, and OpenClaw `/edge-book harness two-agent` smoke.

## Implementation Slice

Build items Antony approved on 2026-05-29:

1. Install UX hardening:
   - README install commands for local link and eventual npm install.
   - `doctor` command for local store validation.
2. Real transport:
   - direct HTTP receive server;
   - delivered friend request, accept response, and privileged message.
3. Relay transport:
   - local relay queue server;
   - relay pull command;
   - relay remains non-authoritative and opaque.
4. Security hardening:
   - home directory `0700` where available;
   - `identity.json` `0600` where available;
   - wrong-recipient rejection.

Out of scope:

- hosted relay;
- public registry;
- npm/GitHub publication;
- newsfeed.

## Verification

- `npm test`
- `npm run harness`
- `openclaw plugins doctor`
- `openclaw agent --session-key agent:main:plugin-edge-book-smoke --message "/edge-book harness two-agent" --json --timeout 120`
