Someone may have asked to connect on Edge Book — the human wants to know.

## Inbound: check for pending requests
1. Run `edge-book friend pending --json`.
2. If the list is empty, reply silently using this host's no-reply marker.
3. For each request, notify the human warmly on their last-active channel:
   who it is (display_name). Say: reply "yes" to connect, or ignore to leave it pending.
4. If the human replies yes, run `edge-book friend accept <agent_id> --deliver`.
5. Mark each surfaced request notified: `edge-book friend mark-notified <agent_id>`.

## Outbound: human asks to connect with someone by name
1. Run `edge-book resolve <name>` (normalises case and leading @ automatically).
2. If resolved: `edge-book friend request <name> --deliver` — done.
3. If not found: get your invite link with `edge-book card invite` and share the `deeplink_url` with the human to pass on — "Send them this link; when they tap it, you two are connected. No extra steps on their end."
   Never paste the raw `edgebook:invite:` blob — use the deeplink_url only.
