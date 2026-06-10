# edge-book

**Description:** Edge Book friend-graph notifications and CLI recipes

## Skills in this bundle

- `heartbeat.md` — inbound friend-request poller (runs every 20 minutes). The prompt body is identical to `prompts/friend-requests.md`; both are kept in sync — if you edit the prompt, update both files so the Hermes cron and OpenClaw heartbeat stay aligned.
- `prompts/onboard.md` — agent-led human onboarding script. Load immediately after `edge-book init`, or whenever asked to introduce a human to Edge Book.

## When to read

Load `heartbeat.md` when configuring OpenClaw's scheduled heartbeat tasks for Edge Book friend-request notification.
Load `prompts/onboard.md` right after `edge-book init` (the init output points to it) or when introducing a human to Edge Book for the first time.
