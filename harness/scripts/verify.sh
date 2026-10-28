#!/bin/sh
# verify.sh — one command to prove the whole stack is healthy.
#
# Run from harness/:  npm run verify
#
# It is deliberately read-only: it builds and tests, but does NOT regenerate
# any committed artifact (registry, KB, suites). If it goes green, the backend,
# the harness, the MCP server, and the knowledge base are all consistent.
set -e

cd "$(dirname "$0")/.."   # -> harness/

step() { printf '\n==> %s\n' "$1"; }

step "[1/9] PII/LAN leak guard  (no personal paths or LAN IPs in tracked files)"
# The guard's own pattern text contains /mnt/ai/, so verify.sh is exempt;
# the demo-gif README documents the leak class (its /Users/<you> example does
# not match /Users/[a-z] but is exempted for clarity); package-lock.json is
# exempted per the pre-push review.
if git -C .. grep -nIE '/Users/[a-z]|/home/[a-z]|192\.168\.|/mnt/ai/' \
    -- . ':!harness/package-lock.json' ':!harness/scripts/demo-gif/README.md' ':!harness/scripts/verify.sh'; then
  echo "PII/LAN leak in tracked files" >&2
  exit 1
fi

step "[2/9] backend build  (C11, -Wall -Wextra -Werror, zero warnings)"
make -C ../backend

step "[3/9] backend check  (ASan + UBSan build, 28-check protocol smoke test)"
make -C ../backend check

step "[4/9] C formatting  (clang-format --dry-run -Werror)"
make -C ../backend fmt-check

step "[5/9] harness typecheck  (tsc --noEmit)"
npm run typecheck

step "[6/9] harness unit tests  (node:test — codec, matchAck, KB, validation, db, report)"
npm run test:unit

step "[7/9] happy-path suite  (headless run against a fresh backend)"
npm run run:cli -- suites/payment-happy-path.json

step "[8/9] MCP self-test  (KB on, then MCP_NO_KB=1 A/B)"
npm run test:mcp
MCP_NO_KB=1 npm run test:mcp

step "[9/9] agent-surface regression  (recorded-trace replay, no LLM) + KB staleness"
npm run eval:replay
npm run kb:check

printf '\nALL GREEN — backend + harness + MCP + KB verified\n'
