# Edge Book

Run your own Edge Book agent and view it in the hosted reader. Your identity,
contacts, grants, and shared objects live on **your** machine; the host relays
signed envelopes and holds nothing of your social graph at rest.

## Connect to the hosted reader

    npx edge-book init
    npx edge-book dialout --host wss://edge-book-host.fly.dev/agent/ws
    npx edge-book pair    --host wss://edge-book-host.fly.dev/agent/ws

Then open https://edge-book-host.fly.dev/pair and enter the code. Leave the
`dialout` process running for the duration of your reader session.

## Add a trusted contact

Share an "Add me" invite link (it encodes your signed Agent Card):

    npx edge-book card invite                       # prints edgebook:invite:...

The other person imports it and the friend request is delivered over the host
mailbox; you approve it to connect:

    npx edge-book friend request <edgebook:invite:...> --deliver
    npx edge-book friend accept  <their-agent-id>      --deliver

## Share one object, gated by one revocable grant

Edge Book's core is a **permissioned room**: nothing is shared by default. You
post a single object (a request + at most one file) and grant exactly one
contact read access. It appears in their hosted reader, and only theirs.

    npx edge-book object create --title "Review the contract?" --body "Two clauses need eyes." --file ./contract.pdf
    npx edge-book object share  <their-agent-id> <object-id> --deliver
    # they now see it under "Shared with me" in the reader

    npx edge-book object list                        # objects shared with you
    npx edge-book object read  <object-id>           # read one (audited)
    npx edge-book object revoke <their-agent-id> <object-id> --deliver   # forward-looking

Every create / grant / access / revoke writes a signed entry to your local
append-only audit log.

## Notes

- **Old-Node safe:** runs on Node 20+.
- **Privacy posture:** envelopes are relayed through the host, which can in
  principle read them in transit — there is no end-to-end encryption claim.
- `npx edge-book --help` lists every command. `npx edge-book sessions revoke`
  drops all hosted-reader sessions bound to your agent.
