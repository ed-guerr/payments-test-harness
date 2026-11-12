# payments-test-harness

![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)

![CI](https://github.com/ed-guerr/payments-test-harness/actions/workflows/verify.yml/badge.svg)

> **TL;DR**: A C payments backend (3 TCP processes, hand-rolled binary wire protocol,
> no docs) plus an MCP server through which an LLM agent authors, validates, and runs
> integration tests against it, grounded in a knowledge base generated from the C source.
> Measured across three models and 1,188 runs: the KB is more effective for the weak 12B model
> (40/110 vs 29/110), an efficiency win for the strong 27B, and a wash at the frontier.
> Verify all of it: `npm run verify`.

**An LLM agent that autonomously authors, validates, and runs integration tests for a
complex C payments backend**, with its entire world being a 15-tool MCP server. Every
artifact it produces is validated before it exists, reproducible from a fresh clone, and
contained so the worst case is designed to be harmless, with the design tested rather
than assumed.

The C backend is a stand-in for a complex multi-process system: three long-lived
processes, a hand-rolled binary wire protocol, X-macro message tables, function-pointer
dispatch, SQLite, and no documentation. That is the environment agents actually have to
work in: there is no OpenAPI to hand the model, only C.

**~47-second demo** (plays at half speed; the two suite runs are slow motion): a live `pi` session running a local 27B model
(llama.cpp `Qwen3.8-27B`) authors a double-settle test through the harness MCP tools and
runs it 10/10 green. That same suite then runs green in the app, followed by
`ledger-chaos-kill` with the `ECONNRESET` failure expanded, the Protocol Registry tab,
and verified balances in the per-suite database:

![demo](docs/demo.gif)

## Architecture

```
┌──────────────────────────── BACKEND (C11, 3 processes) ────────────────────────────┐
│                                                                                    │
│  pay-orders :9101        ledger :9102            auth-gateway :9103                 │
│  (payment lifecycle)     (double-entry)          (external auth/settle boundary)    │
│      │                         ▲                     │          │                     │
│      └── CompletePayment ──────┼─────────────────────┘   TransferFunds (settle)     │
│                                └───────────────────────────────────────────────────┐│
│        ┌──────────────────────────────────────────────────────────────────────────▼┐│
│        │ shared: envelope codec · TCP server + function-pointer dispatch table     ││
│        │ SQLite (accounts, payments, ledger_entries, ledger_txns)                  ││
│        └──────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────┘
        ▲ wire protocol (8-byte LE header + packed payload)
┌───────┴────────────────────────────────────────────────────────────────────────────┐
│ HARNESS (Electron + React + TS)                                                    │
│  main:  backend cluster · registry (from --introspect) · runner (Node module,      │
│         electron-free) · suite CRUD · read-only db · MCP server (stdio, 15 tools)  │
│  renderer:  /suites  live run + step results + backend log                         │
│             /registry  the introspected wire protocol                              │
│             /database  read-only SQL over per-suite databases                      │
└────────────────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────────────────┐
│ KNOWLEDGE LAYER (kb-forge)                                                         │
│  knowledge/*.md intern guides (one per source dir): messages + side effects,       │
│  risks, inter-process interactions, domain vocabulary (generated, then committed)  │
│  consumers:  MCP test author (kb_search/kb_read/schema notes) · designer CLI       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**The core trick.** Each C message is declared once as an X-macro field list
(`backend/include/pay/messages.h`) that expands into the packed struct *and* the metadata
table (name, type, `offsetof`). Each process's dispatch table is a function-pointer array
(`msg_id → handler`). A `--introspect` mode prints that table as JSON; `npm run
gen:registry` merges the three outputs into `harness/src/protocol/registry.json`. The
codec, the GUI, the suite validator, and the MCP schemas all derive from that one file.

**The second trick.** kb-forge walks the code and writes per-directory guides (what each
message *does*, not just its shape). An agent that reads them asserts real side effects
(for example, that an `Authorize` drives the payment to `complete` via the gateway's
forward), while a schema-only agent stops at the local ack.

## The result, in numbers

Two local models via llama.cpp on a LAN GPU box, plus one hosted frontier model
(gpt-6-luna via OpenAI): 11 tasks, 10 runs per task and condition, temperature 0, three
KB conditions. `pass` means the suite was created, re-runs green on a fresh correct
backend, and satisfies the task's exact ground-truth checklist. No LLM judge. CIs are
Wilson 95%.

| condition | Qwen3.8-27B (local) | Gemma-4-12B (local) | gpt-6-luna (hosted) |
|---|---|---|---|
| **kb-on** | **110/110** (97–100%) | **40/110** (28–46%) | 79/110 (63–79%) |
| kb-content-off | 110/110 (97–100%) | 10/110 (5–16%) | 86/110 (70–85%) |
| kb-off | 101/110 (85–96%) | 29/110 (19–35%) | 90/110 (74–88%) |

What the numbers say:

1. **A strong model saturates pass rate.** On the 27B the KB's value shows up as
   efficiency: one-shot suites (1.0 vs 1.4 re-runs) and fewer tool calls.
2. **On the weak model, the KB is the difference between pass and fail** (40 vs 29 vs
   10), and the misses look like recovery failures more than knowledge gaps: identical
   retry loops, and red suites that never get repaired.
3. **Dead tools hurt small models only.** On Gemma, content-off (10/110) is far worse
   than kb-off (29/110) with disjoint CIs, even though Gemma never calls the dead tools;
   two unused tool definitions measurably degrade first-draft quality. On the 27B the
   two conditions are identical, and on the frontier content-off sits between kb-on and kb-off.
4. **At the frontier the KB is a pass-rate wash.** The CIs overlap, and the gradient, if
   anything, runs the wrong way. The residual value is on facts the schema never states,
   like where settlement money lands and the final-balance assertions a frontier suite
   drops.
5. **The suites catch real bugs.** Eight one-line faults (four business regressions, four
   reverts of real bugs found and fixed in this codebase): **5 of 8 are killed by the
   committed suites**, and the [kill matrix](artifacts/eval/sample-mutants.md) names what
   pins the three survivors.

Verify everything in one command: C build with `-Werror`, ASan/UBSan smoke (31 checks),
fmt, typecheck, unit tests, a live suite run, MCP A/B, recorded-trace replay, and KB
staleness.

```bash
npm run verify
```

Per-model deep dives, the original 3-run two-condition eval, and the full methodology:
[docs/eval.md](docs/eval.md).

## What's in the repo

| Layer | What | Where |
|---|---|---|
| **Test target** | C11 payments backend: 3 TCP processes, binary wire protocol, X-macro message tables, function-pointer dispatch, SQLite | `backend/` |
| **Agent surface** | MCP server (stdio), 15 tools: protocol introspection, suite CRUD, execution, read-only DB, KB search/read | `harness/src/mcp/` |
| **Knowledge pipeline** | kb-forge: per-directory "intern guides" generated from source, deterministic retrieval, hash-pinned staleness gate | `harness/src/kb/` → `knowledge/` |
| **Evaluation** | 11-task KB on/off harness: programmatic judge, independent re-run, per-model baselines, plus a recorded-trace replay gate | `harness/src/eval/` |
| **App & CLI** | Electron/React GUI (suites, live run, registry, database) and a headless CLI over one shared, electron-free runner | `harness/src/` |
| **One-command check** | `npm run verify`: C build, ASan/UBSan smoke (31 checks), fmt, typecheck, unit tests, live suite, MCP A/B, replay gate, KB staleness | `harness/scripts/verify.sh` |

## Quickstart (macOS, Apple clang, tested)

```bash
# 1. Build the backend (C11, -Wall -Wextra -Werror -O2)
make -C backend

# 2. Harness deps + generated registry (runs the C binaries with --introspect)
cd harness
npm install
npm run gen:registry

# 3. Verify everything: C build + ASan/UBSan smoke (31 checks) + fmt
#    + typecheck + unit tests + happy-path suite + MCP A/B
#    + recorded-trace replay + KB staleness
npm run verify

# 4. The app
npm start                       # Electron: suites / registry / database
HARNESS_SELF_TEST=1 npm start   # headless e2e self-test (drives the real UI)
```

Prerequisites (Node ≥ 24, C11, Python 3, clang-format 23.1.3), Linux notes, and the
npm ≥ 11 install-script note: [docs/setup.md](docs/setup.md).

## The agent's world: an MCP surface designed for it

The premise: the agent is the **primary author** of the test suites, not a demo. Its
entire world is 15 MCP tools (13 with `MCP_NO_KB=1`, the A/B switch the eval uses);
there is no back door. Three design decisions do most of the work:

- **Validated before it exists.** `create_suite` runs the suite through registry validation
  before anything touches disk: unknown messages, unknown fields, unknown processes,
  non-SELECT SQL, bad step shapes are all rejected with a structured error. The agent
  cannot persist an invalid suite; it can only see why.
- **Errors as steering.** Failure text is written as an instruction the agent can act on:
  `unknown message pay-orders/RefundPayment` comes back with `kbHints` pointing at the
  relevant guide. The loop is author, run, read the result, fix, re-run.
- **Score the artifact, never the words.** The agent's own "it passed" is never trusted:
  the generated suite is re-run on a fresh cluster and checked against an exact
  ground-truth checklist. No LLM judge anywhere in the scoring path.

Full design rationale, including what was tried and rejected (vector retrieval,
LLM-judged scoring, a supervisor loop) and why: [`docs/agent.md`](docs/agent.md).

## Keeping the agent harmless

The agent writes raw SQL that executes against the backend database, and it can SIGKILL
backend processes. Failure-mode and chaos tests need both capabilities, so the design
goal is not to make them impossible; it is to make the worst case harmless by
construction, and to test that construction:

1. **Validate at authoring**: only `SELECT`/`WITH`, single-statement SQL,
   registry-validated steps, charset-locked suite names.
2. **Contain at execution**: the db path runs on a *read-only* driver connection; kills
   target only the child PIDs of the disposable cluster the runner spawned, never a pid
   the agent supplies.
3. **Blast radius does the rest**: every run gets a fresh cluster + fresh database;
   nothing long-lived exists to damage.

Every hostile case is a committed test, and the same hostile inputs are replayed through
the live MCP server on every push (the Layer A gate below). Threat table, the three
layers in code, and the honest residual risks: [`docs/security.md`](docs/security.md).

## Test suites

Suites are plain JSON in `harness/suites/`: four step kinds, registry-validated, each run
against a **fresh backend cluster + fresh database** (`harness/data/<suite>.db`, kept for
inspection). `no-double-settle` was not hand-written: a local LLM authored it through the
MCP server (the GIF above is that session, unedited):

```json
{
  "id": "create",
  "send": { "to": "pay-orders", "msg": "CreatePayment",
            "fields": { "txn_id": 2001, "account": "ACCT-001",
                        "amount_cents": 50000, "currency": "USD" } },
  "expectAck": { "status": 0 }
}
```

(10 steps total: create, authorize, complete, settle, settle again (rejected), with
`dbAssert`s proving the balances.)

- `send` encodes via the registry codec and waits for the matching ack; `expectAck` is a
  **partial match** on fields; `expectError: true` inverts the check (the step passes
  when the send fails, for failure-mode tests).
- `dbAssert` is a one-row `SELECT` + partial match on columns (it reads the same SQLite
  file the C processes write).
- `delayMs` paces across fire-and-forget inter-process forwards.
- `killProcess` is chaos: SIGKILL/SIGTERM a backend process mid-run.

Seven more suites are committed (eight in total, including the LLM-authored one):
`payment-happy-path` (10/10 green), `ledger-chain-reversals` (22 steps), `insufficient-funds`,
`cancel-payment`, `transfer-800`, `ledger-chaos-kill` (kills the ledger mid-run, asserts
the typed failure, verifies state is exactly pre-kill), and `assertion-failure-demo` (a
failing run with an expected-vs-actual diff).

```bash
npm run run:cli -- suites/insufficient-funds.json
```

Every run also persists a machine-readable result JSON to `artifacts/suite-runs/`
(gitignored). For a shareable artifact, flip on the self-contained HTML report styled
like the app (each step's action, pass/fail status, expected-vs-actual assertions,
timing waterfall): reports are off by default so routine runs don't litter the tree.

```bash
HARNESS_HTML_REPORTS=1 npm run run:cli -- suites/insufficient-funds.json
# → artifacts/test-reports/insufficient-funds_<timestamp>.html
```

### Do the suites actually catch bugs?

The headline is finding 5 above. The mechanism: the backend builds with eight one-line
faults compiled in (`make FAULTS=1`, selected at runtime with `PAY_FAULT=<name>`); four
are business regressions, four are literal reverts of real bugs found and fixed in this
codebase. `npm run eval:mutants` runs every committed suite against each fault and writes
the kill matrix ([`artifacts/eval/sample-mutants.md`](artifacts/eval/sample-mutants.md)),
which also names what pins each of the three survivors.

## The wire protocol

Little-endian frames (`u16 magic (0x5046) | u16 msg_id | u32 payload_len | packed
payload`, 8-byte header) over three loopback ports: 9101 pay-orders, 9102 ledger, 9103
auth-gateway. Per-process message tables, packed field offsets, and ack status codes:
[`docs/protocol.md`](docs/protocol.md).

## Evaluation: methodology and gates

The GIF is one unedited session; the eval is the controlled experiment behind it.
`harness/src/eval/` runs a model-agnostic agent (OpenAI-compatible chat + the same 15 MCP
tools an external client would use) through 11 plain-English tasks, in the three KB
conditions above, and scores the artifact, not the agent's word: the generated suite is
re-run on a fresh cluster and checked against an exact ground-truth checklist (seed-data
balance math, ack status codes, side-effect rows). No LLM judge. `pass` = suite created
+ green re-run + full checklist.

```bash
npm run eval:smoke            # 3 tasks x 1 run x both variants
npm run eval                  # 11 tasks x 3 runs x both variants
npm run eval -- --variant three-way --runs 10 --seed 42
# three-way = kb-on, kb-content-off (same KB tool names, empty content), kb-off
```

Interpret `kb-on` vs `kb-off` as two complete agent configurations: the KB-off server
removes the tools as well as the knowledge. The added `kb-content-off` condition
preserves the KB tool names but returns empty search/read content; it is a better
control, not a perfect causal isolation. A seed helps reproduce requests on compatible
endpoints, but it does not guarantee deterministic generation.

Every report carries an **experiment manifest** (hashes of the config, system prompt,
task set, per-condition tool surface, KB manifest, and wire-protocol registry), per-task
and per-category outcomes with 95% Wilson CIs, min/p50/p95 distributions, and failures
grouped by cause, so no attempt drops from a denominator silently.

The eval doubles as a regression gate in two layers. **Layer A** (`npm run eval:replay`,
in `npm run verify`, ~4 s, no LLM) replays recorded agent tool-call traces against the
live MCP server and asserts properties of each result: tool renames, KB content
regressions, and error-message wording changes all fail on every push. **Layer B**
(`.github/workflows/eval.yml`) runs the full eval and fails on regression below the
per-model baseline in `harness/src/eval/baseline.json`; it is opt-in via the
`EVAL_RUN_EVAL` repository variable + `EVAL_API_*` secrets.

Methodology, task set, report format, the per-model deep dives, and how to add tasks:
[`docs/eval.md`](docs/eval.md).

## Knowledge pipeline

```bash
npm run kb                       # regenerate knowledge/ guides (deterministic)
npm run kb -- --llm              # …with LLM-enhanced prose (KB_API_KEY)
npm run kb:check                 # merge gate: stale guide = bug
npm run kb:search -- "authorization completes payment downstream"
npm run design -- "add a refund message that reverses a settled payment"
MCP_NO_KB=1 npm run design -- "…"   # A/B: schema-only design for contrast
```

kb-forge writes one **intern guide** per source directory (fixed section schema: Purpose,
Files, Domain vocabulary, Messages with preconditions and side effects, Key functions
with `file:line`, Common modification points, Risks, Inter-process interactions). Two
consumers:

- **MCP test author**: `kb_search`/`kb_read` tools; `get_message_schema` carries the KB
  row as `notes`; `create_suite` failures carry `kbHints`. `MCP_NO_KB=1` disables it all
  (the A/B switch the eval uses). [`docs/mcp.md`](docs/mcp.md)
- **Designer**: turns a plain-English change request into a reviewable design doc (X-macro
  proposal, handler sketch, risks citing `knowledge/` paths, suggested suite). Sample
  outputs: [`docs/designs/`](docs/designs/).

[`docs/knowledge.md`](docs/knowledge.md)

## CI

GitHub Actions (`.github/workflows/verify.yml`) runs on every push/PR to `main`: a
`verify` job (the exact one-command check developers run locally, `npm run verify`), an
`e2e` job (the real Electron window driven through the actual preload bridge under
Xvfb), a `docker` job (Linux gcc build + proof of life inside the image, also the
"C builds with gcc" job), and an opt-in `eval` job (full 11-task real-model run with
the committed per-model baseline gate). Job details: [`docs/ci.md`](docs/ci.md).

## Docker

Headless image (no Electron: the GUI is a demo surface, not the product; a stale
`registry.json` fails the build). The CI `docker` job builds it on Linux and proves one
suite + the replay gate green inside. Build, run, and MCP client config:
[`docker/README.md`](docker/README.md).

## Design notes

- **Partial-match assertions.** Suites pin only the fields that matter, so a new ack field
  doesn't break every suite; pin it explicitly when it does.
- **The runner is electron-free.** Plain Node: the same engine drives the headless CLI,
  the app, and the MCP server.
- **X-macros over codegen.** The C is the generator: struct, metadata, and dispatch all
  come from one field list; `--introspect` is a print, not a pipeline.
- **Generated artifacts are committed.** Registry, guides, and a sample design are in the
  repo: the project is demoable offline, with no API keys.
- **Localhost only.** Everything binds 127.0.0.1; there is no network surface beyond
  9101-9103 on loopback.

## Lessons learned

Each of these came out of building the eval and the A/B, and each changed a design
decision:

1. **Context budget is a first-class experiment parameter.** The same 12B model passed 2
   of 6 smoke runs (1 run/task, three tasks) at an 8k context (LM Studio) but 5 of 9
   (3 runs/task, same three tasks) at 32k (llama.cpp). Tiny samples: read it as
   direction, not magnitude. The context window is not the only variable you are holding
   constant.
2. **Disable thinking tokens by default, measure, then decide.** Qwen3.8-27B's reasoning
   mode multiplies completion tokens ~3× for this task and buys nothing on the score; the
   eval sends `enable_thinking: false` unless `EVAL_THINKING=1` (`harness/src/eval/agent.ts`).
3. **Score the artifact, never the agent's words.** Programmatic checklist + independent
   re-run (`src/eval/judge.ts`) is what made every number here reproducible in one
   command; an LLM judge would have made it a vibe.
4. **Recorded traces put LLM behavior in CI without an LLM.** The replay gate (roadmap
   R2) exists because "the agent worked" is not testable on every push; "the agent's
   recorded session still behaves" is.
5. **Generated artifacts must be hash-pinned.** The KB went stale the first time a source
   file changed; the manifest hash check (`kb:check`, in `npm run verify`) is now the
   reason that can't be silent.

Conventions, gates, and commit policy:
[`docs/conventions/conventions.md`](docs/conventions/conventions.md).

## Repo map, benchmark, demo script

- **Repo map** (every directory, what it holds): [`docs/repo-map.md`](docs/repo-map.md)
- **Benchmark** (loopback throughput + ack latency, scoped honestly): [`docs/benchmark.md`](docs/benchmark.md)
- **The 6-minute demo** (timed script for showing the system live): [`docs/demo.md`](docs/demo.md)

## License

MIT, see [LICENSE](LICENSE).
