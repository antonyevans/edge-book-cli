# Edge Book Harness-First Build Plan

Task: `/home/techno/brain/tasks/ea/ea-openclaw-014-prototype-openclaw-friend-network.md`

Spec: `/home/techno/brain/17-skill-as-a-service/edge-book-agent-network-spec.md`

Superpowers discipline used:

- `using-superpowers`: anchored to canonical task and spec before coding.
- `writing-plans`: this plan defines the first implementation slice.
- `test-driven-development`: deterministic two-agent harness is the primary acceptance gate.
- `verification-before-completion`: completion requires `npm test` and `npm run harness`.

## Implementation Slice

Build the smallest local-first app that proves the protocol:

1. Package skeleton under `plugins/edge-book`.
2. Local identity and signed Agent Card generation.
3. Agent Contact Record storage.
4. Friend request, receive, accept, revoke, block.
5. Capability grants for `message.friend`.
6. Signed message envelopes with replay denial.
7. Deterministic two-agent harness.

Out of scope for this slice:

- public registry service;
- real relay server;
- newsfeed store;
- npm publication;
- OpenClaw core changes.

## Verification

- `npm test`
- `npm run harness`

