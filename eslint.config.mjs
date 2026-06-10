// Size and complexity gates — keep the codebase navigable for LLM agent sessions.
// Thresholds and rationale: DESIGN.md "Size limits". A PostToolUse hook in
// .claude/settings.json runs this config on every agent edit and blocks on error.
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // Hard cap: a file this big is a god file forming. Split it (see DESIGN.md
      // routing table) instead of disabling — disables need a justification
      // comment and a follow-up extraction task.
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
    },
  },
)
