#!/usr/bin/env bash
# Spec-judge gate backstop (EA spec-0052): a PR that ADDS a product spec
# (docs/spec-NNN-*.md) alongside src/ changes must also include the judge
# verdict artifact docs/judgments/<spec-id>.verdict.md with a PASS line.
# Catches implementation-with-unjudged-spec from any session or contributor,
# including ones not running under the EA harness.
#
# Usage: scripts/check-spec-verdicts.sh [<base-ref>]   (default: origin/main)
set -euo pipefail
BASE="${1:-origin/main}"
git fetch -q origin main 2>/dev/null || true

ADDED_SPECS=$(git diff --name-only --diff-filter=A "$BASE"...HEAD -- 'docs/spec-[0-9]*' | grep -E '^docs/spec-[0-9]+[^/]*\.md$' || true)
SRC_CHANGED=$(git diff --name-only "$BASE"...HEAD -- src/ || true)

[ -z "$ADDED_SPECS" ] && { echo "spec-verdict gate: no new product specs in this diff — OK"; exit 0; }
[ -z "$SRC_CHANGED" ] && { echo "spec-verdict gate: new spec(s) but no src/ changes (spec-only PR) — OK"; exit 0; }

FAIL=0
for SPEC in $ADDED_SPECS; do
  ID=$(basename "$SPEC" | grep -oE '^spec-[0-9]+')
  VERDICT=$(ls docs/judgments/${ID}*.verdict.md 2>/dev/null | head -1 || true)
  if [ -z "$VERDICT" ]; then
    echo "FAIL  $SPEC: no verdict artifact docs/judgments/${ID}*.verdict.md (EA spec-0052: judge the spec before implementing it)"
    FAIL=1
  elif ! grep -qiE '^verdict: *(PASS|CONDITIONAL)' "$VERDICT"; then
    echo "FAIL  $SPEC: $VERDICT exists but has no 'verdict: PASS' (or CONDITIONAL) line"
    FAIL=1
  else
    echo "OK    $SPEC ← $VERDICT"
  fi
done
exit $FAIL
