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

step "[1/6] backend build  (C11, -Wall -Wextra -Werror, zero warnings)"
make -C ../backend

step "[2/6] backend check  (ASan + UBSan build, 28-check protocol smoke test)"
make -C ../backend check

step "[3/6] C formatting  (clang-format --dry-run -Werror)"
make -C ../backend fmt-check

step "[4/6] harness typecheck  (tsc --noEmit)"
npm run typecheck

step "[5/6] happy-path suite  (headless run against a fresh backend)"
npm run run:cli -- suites/payment-happy-path.json

step "[6/6] MCP self-test  (KB on, then MCP_NO_KB=1 A/B) + KB staleness"
npm run test:mcp
MCP_NO_KB=1 npm run test:mcp
npm run kb:check

printf '\nALL GREEN — backend + harness + MCP + KB verified\n'
