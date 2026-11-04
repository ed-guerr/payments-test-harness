# CI

GitHub Actions (`.github/workflows/verify.yml`) runs three jobs on every push/PR to
`main`, plus the opt-in `eval` job in `eval.yml` (moved out of the README in the
2026-11 README cut):

| Job | What it runs |
|---|---|
| `verify` | the exact one-command check developers run locally (`npm run verify`): C build with `-Werror`, ASan/UBSan build + 31-check protocol smoke, `clang-format --dry-run` (pinned to 23.1.3, formatting is version-sensitive), typecheck, `node:test` unit tests (codec round-trip, ack matching, KB search, suite validation, hostile-suite cases, read-only db), a live happy-path suite against a fresh cluster, MCP author A/B (KB on vs `MCP_NO_KB=1`), recorded-trace replay of the agent surface (no LLM), KB staleness check. Run reports are uploaded as an artifact. |
| `e2e` | builds the app, loads the real Electron window under Xvfb, then drives the renderer through the actual preload bridge: `listSuites` + `runSuite('payment-happy-path')`. Non-zero exit on any failure. |
| `docker` | builds the headless image (gcc C build, `npm ci`, registry-staleness diff) on Linux and proves it runs: one suite green + `eval:replay` inside the image. Also the "C builds with gcc" job. |
| `eval` (opt-in, `eval.yml`) | real-model eval against a live endpoint: full 11-task run with the committed per-model baseline gate. Off unless the `EVAL_RUN_EVAL` repository variable is `true` and `EVAL_API_*` secrets exist; on a schedule, on demand, and on pushes touching the agent surface. |

The harness is unit-tested with the built-in `node:test` runner (`npm run
test:unit`, 62 tests; no test framework added, since the repo's npm policy blocks
install scripts by default).
