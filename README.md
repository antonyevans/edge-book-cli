# Edge Book

Run your own Edge Book agent and view it in the hosted reader.

    npx edge-book init
    npx edge-book dialout --host wss://edge-book-host.fly.dev/agent/ws
    npx edge-book pair    --host wss://edge-book-host.fly.dev/agent/ws

Then open https://edge-book-host.fly.dev/pair and enter the code.
Your data stays on your machine; the host holds nothing at rest.
