# Repo map

Every directory and what it holds (moved out of the README in the 2026-11
README cut).

```
Dockerfile          headless image (no Electron; registry-staleness diff at build)
.dockerignore
docker/README.md    what's in/out, run + MCP client config, eval in-container
backend/
  include/pay/        envelope, X-macro message defs, dispatch table, db, socket
  src/common/         codec, TCP server + dispatch, introspection, sqlite, log
  src/pay_orders/     payment lifecycle (:9101)
  src/ledger/         double-entry ledger (:9102)
  src/auth_gateway/   auth/settle boundary (:9103) + forwarding
  db/schema.sql       accounts, payments, ledger_entries, ledger_txns (+seed)
  tools/smoke_test.py 31-check protocol test (part of `make check`)
harness/
  src/protocol/       registry.json (generated) + codec + framed TCP client
  src/runner/         the suite engine (electron-free) + headless CLI
  src/backend/        cluster lifecycle, suite CRUD, path helpers
  src/main/           Electron main + preload bridge (+ self-test mode)
  src/renderer/       React UI (sandboxed): suites / registry / database
  src/mcp/            MCP server (15 tools) + KB tools
  src/kb/             kb-forge generator + deterministic retrieval
  src/design/         the designer CLI
  src/eval/           the KB on/off evaluation harness (npm run eval)
                      + recorded-trace replay gate (npm run eval:replay)
  src/**/*.test.ts    node:test unit tests (npm run test:unit)
  suites/             8 committed sample suites (no-double-settle is agent-authored)
  scripts/            gen_registry.js · mcp-self-test.js · run-mutants.ts ·
                      clean-runs.js · verify.sh · demo-gif/
artifacts/          generated artifacts (gitignored except committed sample-*)
  suite-runs/         per-run JSON results (every run_suite; prune: npm run runs:clean)
  test-reports/       self-contained HTML run reports (HARNESS_HTML_REPORTS=1)
  eval/               eval reports + independent reruns (eval/runs/)
                      + sample-mutants.md (the fault kill matrix)
knowledge/            generated intern guides (+ INDEX.md + .manifest.json)
docs/
  plans/InitialDesign.md    the full design plan (phases P1–P6)
  conventions/conventions.md the project's conventions & gates
  agent.md            tool & agent design (why the MCP surface is shaped this way)
  security.md         threat model for agent-authored SQL / killProcess / MCP
  eval.md             the KB on/off evaluation methodology + committed results
  protocol.md · mcp.md · knowledge.md · benchmark.md · demo.md · repo-map.md
  designs/          sample designer output (KB-grounded vs schema-only pair)
  demo.gif          the ~47s half-speed demo (linked at the top of the
                    README; regenerate with the harness/scripts/demo-gif/
                    pipeline)
```
