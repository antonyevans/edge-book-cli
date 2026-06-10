#!/usr/bin/env node
// PostToolUse hook: lint the file the agent just edited; exit 2 blocks the agent
// and feeds the lint output back so it self-corrects in-session.
// Exit 2 = block (Claude sees stderr). Exit 0 = pass. Exit 1 would NOT block.
import { execFileSync } from 'node:child_process'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

let filePath
try {
  filePath = JSON.parse(raw).tool_input?.file_path
} catch {
  process.exit(0)
}

// Only lint TypeScript sources under src/ — config, docs, tests are out of scope.
if (!filePath || !/\.([mc]?ts)$/.test(filePath) || !/[\\/]src[\\/]/.test(filePath)) {
  process.exit(0)
}

try {
  execFileSync('npx', ['eslint', '--no-warn-ignored', '--quiet', filePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
  console.error(
    out ||
      `eslint failed on ${filePath} (no output — is eslint installed? run npm ci)`,
  )
  console.error(
    '\nFix the violation now (split the file per DESIGN.md routing table) — do not weaken or disable the rule.',
  )
  process.exit(2)
}
