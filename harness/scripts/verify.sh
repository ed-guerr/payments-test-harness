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

step "[1/8] backend build  (C11, -Wall -Wextra -Werror, zero warnings)"
make -C ../backend

step "[2/8] backend check  (ASan + UBSan build, 28-check protocol smoke test)"
make -C ../backend check

step "[3/8] C formatting  (clang-format --dry-run -Werror)"
make -C ../backend fmt-check

step "[4/8] harness typecheck  (tsc --noEmit)"
npm run typecheck

step "[5/8] harness unit tests  (node:test — codec, matchAck, KB, validation, db, report)"
npm run test:unit

step "[6/8] happy-path suite  (headless run against a fresh backend)"
npm run run:cli -- suites/payment-happy-path.json

step "[7/8] MCP self-test  (KB on, then MCP_NO_KB=1 A/B)"
npm run test:mcp
MCP_NO_KB=1 npm run test:mcp

step "[8/8] agent-surface regression  (recorded-trace replay, no LLM) + KB staleness"
npm run eval:replay
npm run kb:check

printf '\nALL GREEN — backend + harness + MCP + KB verified\n'
