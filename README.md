# payments-test-harness

![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)

<!-- CI badge: add `![CI](https://github.com/<you>/payments-test-harness/actions/workflows/verify.yml/badge.svg)` once the repo has a public remote. -->

A payments backend in C (three TCP processes, function-pointer message
tables, SQLite) plus a test-harness app in Electron/React/TypeScript that
runs persisted JSON test suites in realtime — and an **MCP server** that lets
an AI agent author those tests itself, grounded in a generated **knowledge
base** of per-directory "intern guides".

It is a self-contained sample of a real engineering pattern: *one source of
truth for the wire protocol, generated from the C code, consumed by every
layer* — and a knowledge pipeline that turns "the code says what fields
exist" into "the agent knows what the code does".

**~51-second demo** (half speed) — a live `pi` session running a local 27B
model (llama.cpp `qwen3`) authors a double-settle test through the harness
MCP tools and runs it 10/10 green; *that* suite then runs green in the app;
then `ledger-chaos-kill` with the `ECONNRESET` failure expanded → Protocol
Registry → verified balances in the per-suite database:

![demo](docs/demo.gif)

## Architecture

```
┌──────────────────────────── BACKEND (C11, 3 processes) ────────────────────────────┐
│                                                                                    │
│  pay-orders :9101        ledger :9102            auth-gateway :9103                 │
│  (payment lifecycle)     (double-entry)          (external auth/settle boundary)    │
│      │                         ▲                     │        │                     │
│      └── CompletePayment ──────┼─────────────────────┘   TransferFunds (settle)     │
│                                └───────────────────────────────────────────┐        │
│        ┌───────────────────────────────────────────────────────────────────▼──┐    │
│        │ shared: envelope codec · TCP server + function-pointer dispatch table │    │
│        │ SQLite (accounts, payments, ledger_entries, ledger_txns)              │    │
│        └───────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────┘
        ▲ wire protocol (8-byte LE header + packed payload)
┌───────┴──────────────────────────────────────────────────────────────────────────────┐
│ HARNESS (Electron + React + TS)                                                      │
│  main:  backend cluster · registry (from --introspect) · runner (Node module,        │
│         electron-free) · suite CRUD · read-only db · MCP server (stdio, 15 tools)    │
│  renderer:  /suites  live run + step results + backend log                           │
│             /registry  the introspected wire protocol                                │
│             /database  read-only SQL over per-suite databases                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────── KNOWLEDGE LAYER (kb-forge) ─────────────────────────────┐
│  knowledge/*.md intern guides (one per source dir): messages + side effects, risks, │
│  inter-process interactions, domain vocabulary — generated, then committed          │
│  consumers:  MCP test author (kb_search/kb_read/schema notes) · designer CLI        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**The core trick.** Each C message is declared once as an X-macro field list
(`backend/include/pay/messages.h`) that expands into the packed struct *and*
the metadata table (name, type, `offsetof`). Each process's dispatch table is a
function-pointer array (`msg_id → handler`). A `--introspect` mode prints that
table as JSON; `npm run gen:registry` merges the three outputs into
`harness/src/protocol/registry.json`. The codec, the GUI, the suite validator,
and the MCP schemas all derive from that one file.

**The second trick.** kb-forge walks the code and writes per-directory guides
(what each message *does*, not just its shape). An agent that reads them
asserts real side effects — e.g. that an `Authorize` drives the payment to
`complete` via the gateway's forward — while a schema-only agent stops at the
local ack.

## Quickstart (macOS, Apple clang — tested)

```bash
# 1. Build the backend (C11, -Wall -Wextra -Werror -O2)
make -C backend

# 2. Harness deps + generated registry (runs the C binaries with --introspect)
cd harness
npm install
npm run gen:registry

# 3. Verify everything — one command:
npm run verify                  # backend build + ASan/UBSan smoke (28 checks) + fmt
                                # + typecheck + unit tests + happy-path suite
                                # + MCP self-test (KB on/off A/B)
                                # + recorded-trace replay + KB staleness check

# 4. The app
npm start                       # Electron: suites / registry / database
HARNESS_SELF_TEST=1 npm start   # headless e2e self-test (drives the real UI)
```

> **npm note (this machine's policy):** install scripts are blocked by
> default; approve them once with
> `npm install-scripts approve better-sqlite3 esbuild fsevents electron`.
> (The committed harness uses Node's built-in `node:sqlite`, so only the
> dev/build tooling needs approving.)

## CI

GitHub Actions (`.github/workflows/verify.yml`) runs three jobs on every
push/PR to `main`, plus the opt-in `eval` job in `eval.yml`:

| Job | What it runs |
|---|---|
| `verify` | the *exact* one-command check developers run locally (`npm run verify`): C build with `-Werror`, ASan/UBSan build + 28-check protocol smoke, `clang-format --dry-run` (pinned to 23.1.3 — formatting is version-sensitive), typecheck, `node:test` unit tests (codec round-trip, ack matching, KB search, suite validation, hostile-suite cases, read-only db), live happy-path suite against a fresh cluster, MCP author A/B (KB on vs `MCP_NO_KB=1`), recorded-trace replay of the agent surface (no LLM), KB staleness check. Run reports are uploaded as an artifact. |
| `e2e` | builds the app, loads the real Electron window under Xvfb, then drives the renderer through the actual preload bridge: `listSuites` + `runSuite('payment-happy-path')`. Non-zero exit on any failure. |
| `docker` | builds the headless image (gcc C build, `npm ci`, registry-staleness diff) on Linux and proves it runs: one suite green + `eval:replay` inside the image. Also the "C builds with gcc" job. |
| `eval` (opt-in, `eval.yml`) | real-model eval against a live endpoint: full 11-task run with the committed per-model baseline gate. Off unless the `EVAL_RUN_EVAL` repository variable is `true` and `EVAL_API_*` secrets exist — on a schedule, on demand, and on pushes touching the agent surface. |

The harness is unit-tested with the built-in `node:test` runner (`npm run
test:unit`, 23 tests, no test framework added — the repo's npm policy blocks
install scripts by default).

## Docker

Headless image (the Electron GUI is deliberately absent — demo surface,
not product; a stale `registry.json` fails the build):

```bash
docker build -t payments-harness .
docker run --rm payments-harness run:cli -- suites/payment-happy-path.json   # one suite, fresh cluster + db
docker run -i --rm payments-harness mcp                                      # MCP server over stdio
```

The CI `docker` job (Linux) builds it and proves one suite + the
replay gate green inside. What's in/out and MCP client config:
[`docker/README.md`](docker/README.md).

## Benchmark

`npm run bench` starts a fresh backend cluster, sends sequential
`TransferFunds` (one in flight) from a single client, and reports throughput
plus ack-latency percentiles. Each op is a full round trip: framed request
out, C handler executes (SQLite read → validate → commit), framed ack back.
500 measured ops after 50 warmup, three runs on the author's laptop
(Apple Silicon, macOS):

| ops | throughput | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| 500 | 8,233/s | 99 μs | 165 μs | 271 μs | 2.59 ms |
| 500 | 8,677/s | 90 μs | 161 μs | 350 μs | 2.70 ms |
| 500 | 8,445/s | 96 μs | 150 μs | 389 μs | 2.65 ms |

Read this as "protocol + single-threaded SQLite commit cost over loopback
on one machine", not a scaling claim: each run is one client against a fresh
three-process cluster.

## Evaluation — does the knowledge base actually make a difference?

The GIF is one unedited session; the eval is the controlled experiment
behind it. `harness/src/eval/` runs a model-agnostic agent (OpenAI-
compatible chat + the same 15 MCP tools an external client would use)
through 11 plain-English tasks, each with **KB on** vs **KB off**
(`MCP_NO_KB=1`) — and scores the artifact, not the agent's word: the
generated suite is re-run on a fresh cluster and checked against an exact
ground-truth checklist (seed-data balance math, ack status codes,
side-effect rows). No LLM judge. `pass` = suite created + green re-run +
full checklist.

```bash
npm run eval:smoke            # 3 tasks x 1 run x both variants
npm run eval                  # 11 tasks x 3 runs x both variants
```

Committed results — both models via llama.cpp on a LAN GPU box, 3 runs per
task, temperature 0. Trimmed full-fidelity samples (agent-authored suites
intact, tool results truncated) in
[`sample-qwen3-27b.json`](harness/eval-reports/sample-qwen3-27b.json) and
[`sample-gemma-12b.json`](harness/eval-reports/sample-gemma-12b.json):

| model | config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) |
|---|---|---|---|---|---|---|---|
| **Qwen3.8-27B Q4_K_M** (the GIF's model) | **kb-on** | **33/33** | 33/33 | 33/33 | 13.2 | **1.0** | 13 |
| Qwen3.8-27B Q4_K_M | kb-off | 32/33 | 32/33 | 32/33 | 14.6 | 1.3 | 11 |
| Gemma-4-12B QAT Q4_0 | **kb-on** | **12/33** | 21/33 | 15/33 | 14.4 | 0.9 | 14 |
| Gemma-4-12B QAT Q4_0 | kb-off | 8/33 | 14/33 | 8/33 | 18.1 | 0.8 | 50 |

What the numbers say, honestly — the KB's measurable value **moves from
efficiency to pass-or-fail as the model gets weaker**:

- **Qwen3-27B (strong):** pass rate saturates (33 vs 32); the value shows
  as *efficiency* — one-shot suites (1.0 vs 1.3 re-runs), fewer tool calls
  (13.2 vs 14.6). The single failure (KB-off `unknown-account`, 2/3) is the
  class of miss the KB exists to prevent.
- **Gemma-4-12B (weaker):** the value shows in the *pass rate itself* —
  12 vs 8 (+50% relative), fewer tool calls (14.4 vs 18.1), 3.6× faster
  p50 (14 s vs 50 s). Mechanism visible in the data: 31 of its 66 runs
  exhaust the 25-step tool budget; the KB keeps a weak model inside it
  (3/3 vs 2/3 on KB-sensitive `gateway-forward-completes`).
- The tasks **stratify the models**: `settle-moves-money` (the prompt never
  says *where* settlement money goes) is 3/3 for Qwen in both variants and
  0/3 for Gemma in both. No single task discriminates; the set does. Two
  tasks are KB-sensitive by construction — their ground truth lives only in
  the intern guides, and the prompts never leak it.

Methodology, task set, and how to add tasks: [`docs/eval.md`](docs/eval.md).

The eval doubles as a regression gate in two layers. **Layer A**
(`npm run eval:replay`, in `npm run verify`, ~4 s, no LLM) replays recorded
agent tool-call traces against the live MCP server and asserts properties of
each result — catching tool renames, KB content regressions, and
error-message wording changes on every push. **Layer B**
(`.github/workflows/eval.yml`) runs the full eval and fails on regression
below the per-model baseline in `harness/src/eval/baseline.json`; opt-in via
the `EVAL_RUN_EVAL` repository variable + `EVAL_API_*` secrets.

## The wire protocol

Little-endian frame: `u16 magic (0x5046) | u16 msg_id | u32 payload_len |
payload[]`; payloads are packed structs at the exact `offsetof` offsets.

| process | port | in messages | out messages |
|---|---|---|---|
| pay-orders | 9101 | CreatePayment (10) · CancelPayment (11) · CompletePayment (12) | PaymentAck (20) |
| ledger | 9102 | TransferFunds (30) · ReverseTransfer (31) | TransferAck (32) |
| auth-gateway | 9103 | Authorize (40) · Settle (41) | AuthResponse (42) · SettleAck (43) |
| all | — | — | ErrorAck (255) |

Full field tables, offsets, and ack status codes: [`docs/protocol.md`](docs/protocol.md).

## Test suites

Suites are plain JSON in `harness/suites/` — four step kinds, registry-
validated, each run against a **fresh backend cluster + fresh database**
(`harness/data/<suite>.db`, kept for inspection). `no-double-settle` was
not hand-written: a local LLM authored it through the MCP server (the GIF
above is that session, unedited):

```json
{
  "id": "create",
  "send": { "to": "pay-orders", "msg": "CreatePayment",
            "fields": { "txn_id": 2001, "account": "ACCT-001",
                        "amount_cents": 50000, "currency": "USD" } },
  "expectAck": { "status": 0 }
}
```

(10 steps total: create → authorize → complete → settle → settle again
(rejected), with `dbAssert`s proving the balances.)

- `send` — encode via the registry codec, wait for the matching ack;
  `expectAck` is a **partial match** on fields; `expectError: true` inverts
  the check (the step passes when the send fails — failure-mode tests).
- `dbAssert` — one-row `SELECT` + partial match on columns (reads the same
  SQLite file the C processes write).
- `delayMs` — pacing across fire-and-forget inter-process forwards.
- `killProcess` — chaos: SIGKILL/SIGTERM a backend process mid-run.

Seven suites are committed: `payment-happy-path` (10/10 green),
`ledger-chain-reversals` (22 steps), `insufficient-funds`, `cancel-payment`,
`transfer-800`, `ledger-chaos-kill` (kills the ledger mid-run, asserts the
typed failure, verifies state is exactly pre-kill), and
`assertion-failure-demo` (a failing run with an expected-vs-actual diff).

```bash
npm run run:cli -- suites/insufficient-funds.json
```

Every run — from the app, the CLI, or the MCP server — also writes a
self-contained **HTML report** to `docs/test-runs/<suite>_<timestamp>.html`
(styled like the app, dark by default): each step's action, pass/fail
status, and assertions with expected vs actual — mismatches highlighted.

## Knowledge pipeline

```bash
npm run kb                       # regenerate knowledge/ guides (deterministic)
npm run kb -- --llm              # …with LLM-enhanced prose (KB_API_KEY)
npm run kb:check                 # merge gate: stale guide = bug
npm run kb:search -- "authorization completes payment downstream"
npm run design -- "add a refund message that reverses a settled payment"
MCP_NO_KB=1 npm run design -- "…"   # A/B: schema-only design for contrast
```

kb-forge writes one **intern guide** per source directory (fixed section
schema: Purpose / Files / Domain vocabulary / Messages with preconditions and
side effects / Key functions with `file:line` / Common modification points /
Risks / Inter-process interactions). Consumers:

- **MCP test author** — `kb_search`/`kb_read` tools; `get_message_schema`
  carries the KB row as `notes`; `create_suite` failures carry `kbHints`.
  `MCP_NO_KB=1` disables it all (the A/B switch the [eval](#evaluation--does-the-knowledge-base-actually-make-a-difference)
  uses to measure the difference). → [`docs/mcp.md`](docs/mcp.md)
- **Designer** — turns a plain-English change request into a reviewable
  design doc (X-macro proposal, handler sketch, risks citing `knowledge/`
  paths, suggested suite). Sample outputs: [`docs/designs/`](docs/designs/).

→ [`docs/knowledge.md`](docs/knowledge.md)

## The 6-minute demo

(Quick version: the half-speed GIF at the top — step 5 is the part it plays live.)


1. **0:00 Build & introspect.** `make -C backend && npm run gen:registry` —
   "the registry is generated from the C function-pointer tables, not
   written."
2. **0:45 Protocol Registry tab.** Three processes live; open the tab: every
   message, field, type, size, and packed offset — all of it introspected.
3. **1:45 Happy path.** Run `payment-happy-path` in the app → live step
   timeline, 10/10 green, DB balances validated (400000 / 300000 /
   1050000 cents), forwards visible in the log feed.
4. **3:00 Failure demo.** Run `assertion-failure-demo` → a step fails with an
   expected-vs-actual diff; the run continues and reports the failure.
5. **4:00 Agent-authored test.** In any MCP client: *"make a test that
   verifies an external authorization completes a payment"* → the agent calls
   `kb_search`, reads `knowledge/backend/auth_gateway.md`
   ("on approve → forwards `CompletePayment`"), and the generated suite
   contains the downstream `dbAssert` a schema-only agent misses →
   `run_suite` green, suite visible in the app.
6. **5:15 Designer.** `npm run design -- "add a refund message that reverses a
   settled payment"` → design doc with X-macro list, handler sketch, and risks
   citing `knowledge/backend/ledger.md`.

## Repo map

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
  tools/smoke_test.py 28-check protocol test (part of `make check`)
harness/
  src/protocol/       registry.json (generated) + codec + framed TCP client
  src/runner/         the suite engine (electron-free) + headless CLI
  src/backend/        cluster lifecycle, suite CRUD, path helpers
  src/main/           Electron main + preload bridge (+ self-test mode)
  src/renderer/       React UI (sandboxed) — suites / registry / database
  src/mcp/            MCP server (15 tools) + KB tools
  src/kb/             kb-forge generator + deterministic retrieval
  src/design/         the designer CLI
  src/eval/           the KB on/off evaluation harness (npm run eval)
                      + recorded-trace replay gate (npm run eval:replay)
  eval-reports/       eval reports (sample-qwen3-27b.* committed; rest gitignored)
  src/**/*.test.ts    node:test unit tests (npm run test:unit)
  suites/             8 committed sample suites (no-double-settle is agent-authored)
  scripts/            gen_registry.js · mcp-self-test.js · demo-gif/ (GIF capture pipeline)
knowledge/            generated intern guides (+ INDEX.md + .manifest.json)
docs/
  plans/InitialDesign.md    the full design plan (phases P1–P6)
  conventions/conventions.md the project's conventions & gates
  agent.md            tool & agent design (why the MCP surface is shaped this way)
  security.md         threat model for agent-authored SQL / killProcess / MCP
  eval.md             the KB on/off evaluation methodology (npm run eval)
  protocol.md · mcp.md · knowledge.md
  designs/          sample designer output (KB-grounded vs schema-only pair)
  demo.gif          the ~51s half-speed demo (linked at the top of the
                    README; regenerate with the harness/scripts/demo-gif/
                    pipeline)
```

## Design notes

- **Partial-match assertions.** Suites pin only the fields that matter, so a
  new ack field doesn't break every suite — pin it explicitly when it does.
- **The runner is electron-free.** Plain Node: the same engine drives the
  headless CLI, the app, and the MCP server.
- **X-macros over codegen.** The C is the generator: struct, metadata, and
  dispatch all come from one field list; `--introspect` is a print, not a
  pipeline.
- **Generated artifacts are committed.** Registry, guides, and a sample
  design are in the repo — the project is demoable offline, with no API keys.
- **Localhost only.** Everything binds 127.0.0.1; there is no network surface
  beyond 9101–9103 on loopback.
- **The agent is the primary author, and the surface is designed for it** —
  validation at authoring, structured errors as steering, deterministic KB
  retrieval: [`docs/agent.md`](docs/agent.md).
- **Hostile inputs are a test suite, not a fear** — agent-authored SQL and
  process kills are contained in three layers (authoring validation,
  read-only execution, disposable clusters) and every layer is tested:
  [`docs/security.md`](docs/security.md).

## Lessons learned

From building the eval and the A/B — each one changed a design decision:

1. **A strong model saturates pass rate.** On the 27B the KB's effect was
   invisible on pass/fail (33 vs 32) and only visible in efficiency
   (one-shot suites). If your A/B shows no difference on a strong model,
   measure *how* it got there (tool calls, re-runs, tokens) before
   concluding the feature is worthless — and expect the gap to appear in
   pass rate on weaker models (it did: 12 vs 8 on the 12B).
2. **Context budget is a first-class experiment parameter.** The same 12B
   model passed 2 of 6 smoke runs (1 run/task, three tasks) at an 8k
   context (LM Studio) but 5 of 9 (3 runs/task, same three tasks) at 32k
   (llama.cpp). The context window is not the only variable you are holding
   constant.
3. **Disable thinking tokens by default, measure, then decide.** Qwen3's
   reasoning mode multiplies completion tokens ~3× for this task and buys
   nothing on the score; the eval sends `enable_thinking: false` unless
   `EVAL_THINKING=1` (`harness/src/eval/agent.ts`).
4. **Score the artifact, never the agent's words.** Programmatic checklist
   + independent re-run (`src/eval/judge.ts`) is what made every number
   here reproducible in one command; an LLM judge would have made it a
   vibe.
5. **Recorded traces put LLM behavior in CI without an LLM.** The replay
   gate (roadmap R2) exists because "the agent worked" is not testable on
   every push; "the agent's recorded session still behaves" is.
6. **Generated artifacts must be hash-pinned.** The KB went stale the first
   time a source file changed; the manifest hash check (`kb:check`, in
   `npm run verify`) is now the reason that can't be silent.

Conventions, gates, and commit policy: [`docs/conventions/conventions.md`](docs/conventions/conventions.md).

## License

MIT — see [LICENSE](LICENSE).
