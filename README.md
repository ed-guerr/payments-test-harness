# payments-test-harness

![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)

<!-- CI badge: add `![CI](https://github.com/<you>/payments-test-harness/actions/workflows/verify.yml/badge.svg)` once the repo has a public remote. -->

**An LLM agent that autonomously authors, validates, and runs integration
tests for a complex C payments backend** — grounded in a generated
knowledge base, with the effect *measured* (KB on vs off, two models, 66
runs) rather than asserted. The agent's entire world is a 15-tool MCP
server; every artifact it produces is validated before it exists, replayable
on any machine, and contained so the worst case is structurally harmless.

The test target is deliberately not a toy: the C backend is a stand-in for
a complex multi-process C system (three long-lived processes, a hand-rolled
binary wire protocol, X-macro message tables, function-pointer dispatch,
SQLite, zero documentation). That is the environment agents actually have
to work in, and it is where the knowledge pipeline earns its keep: there is
no OpenAPI to hand the model, only C.

**~47-second demo** (half speed) — a live `pi` session running a local 27B
model (llama.cpp `Qwen3.8-27B`) authors a double-settle test through the harness
MCP tools and runs it 10/10 green; *that* suite then runs green in the app;
then `ledger-chaos-kill` with the `ECONNRESET` failure expanded → Protocol
Registry → verified balances in the per-suite database:

![demo](docs/demo.gif)

## The result, in numbers

Committed results — two local models via llama.cpp on a LAN GPU box plus one
hosted frontier model (gpt-6-luna via OpenAI), 3 runs per task, temperature 0,
two conditions (kb-on / kb-off).
Trimmed full-fidelity samples (agent-authored suites intact, tool results
truncated) in [`sample-Qwen3.8-27B.json`](artifacts/eval/sample-Qwen3.8-27B.json),
[`sample-gpt-6-luna.json`](artifacts/eval/sample-gpt-6-luna.json), and
[`sample-gemma-12b.json`](artifacts/eval/sample-gemma-12b.json):

| model | config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | avg tokens in/out (per run) | avg cost (usd/run) |
|---|---|---|---|---|---|---|---|---|---|
| **Qwen3.8-27B Q4_K_M** (the GIF's model) | **kb-on** | **33/33** | 33/33 | 33/33 | 13.2 | **1.0** | 13 | 53,285 / 1,098 | 0.0000 |
| Qwen3.8-27B Q4_K_M | kb-off | 32/33 | 32/33 | 32/33 | 14.6 | 1.3 | 11 | 48,993 / 1,311 | 0.0000 |
| gpt-6-luna (hosted, OpenAI) | kb-on | 20/33 | 30/33 | 20/33 | 13.7 | 1.1 | 13 | 35,298 / 809 | 0.0039 |
| gpt-6-luna (hosted, OpenAI) | kb-off | 22/33 | 28/33 | 22/33 | 22.2 | 1.1 | 19 | 58,118 / 955 | 0.0063 |
| Gemma-4-12B QAT Q4_0 | **kb-on** | **12/33** | 21/33 | 15/33 | 14.4 | 0.9 | 14 | 87,127 / 2,555 | n/a |
| Gemma-4-12B QAT Q4_0 | kb-off | 8/33 | 14/33 | 8/33 | 18.1 | 0.8 | 50 | 96,361 / 4,122 | n/a |

What the numbers say, honestly — the KB's measurable value **moves from
efficiency to pass-or-fail as the model gets weaker, and at the frontier it
mostly disappears — except on the tasks whose ground truth lives only in the
KB**:

- **Qwen3.8-27B (strong):** pass rate saturates (33 vs 32); the value shows
  as *efficiency* — one-shot suites (1.0 vs 1.3 re-runs), fewer tool calls
  (13.2 vs 14.6). The single failure (KB-off `unknown-account`, 2/3) is the
  class of miss the KB exists to prevent. (The 10-run three-way below
  sharpens both points.)
- **gpt-6-luna (hosted frontier):** pass rate is a wash (20 vs 22, within
  run noise) — a strong model infers the protocol from introspection alone.
  But on the two KB-sensitive tasks the KB still pays (3/3 vs 1/3 on
  `gateway-forward-completes`, 3/3 vs 2/3 on `settle-moves-money`), and the
  failure mode changes shape: instead of exhausting the 25-step tool budget
  (Gemma's miss), it writes a *functionally correct* suite that drops one
  ground-truth assertion — `happy-path` kb-on is 0/3 on a single missing
  `Settle` ack check, all three runs. Two caveats, stated plainly: the
  `/chat/completions` endpoint forces `reasoning_effort: "none"` for function
  tools, so this row is the model *with reasoning off*, and the full 66-run
  eval cost ~$0.35 at $0.10/$0.50 per M tokens. The 10-run three-way below
  settles both caveats. The wash holds, 79 vs 90 with overlapping CIs.
  Neither KB-sensitive task separates anymore, both are 10/10 on kb-off.
  The dead-tools penalty stays on the 12B.
- **Gemma-4-12B (weaker):** the value shows in the *pass rate itself* —
  12 vs 8 (+50% relative), fewer tool calls (14.4 vs 18.1), 3.6× faster
  p50 (14 s vs 50 s). Mechanism visible in the data: 31 of its 66 runs
  exhaust the 25-step tool budget; the KB keeps a weak model inside it
  (3/3 vs 2/3 on KB-sensitive `gateway-forward-completes`). The 10-run
  three-way below shows the ~36% ceiling is stable across runs, and that the
  misses are recovery failures, not knowledge gaps.
- The tasks **stratify the models**: `settle-moves-money` (the prompt never
  says *where* settlement money goes) is 3/3 for Qwen in both variants,
  9/6/8 for Luna across the three conditions, and 0/3 for Gemma in both. No single task discriminates; the set does. Two
  tasks are KB-sensitive by construction — their ground truth lives only in
  the intern guides, and the prompts never leak it.

### The same model, three ways (10 runs per task)

The two-condition table can't separate the KB's *content* from the mere
presence of a *lookup tool*. So the local 27B ran all 11 tasks ten times in
three conditions: KB on; KB tools present but returning empty results; no KB
tools.

| condition | pass | 95% CI | tool calls (mean) | suite reruns (mean) |
|---|---|---|---|---|
| kb-on | 110/110 | 97–100% | 13.6 | 1.0 |
| kb-content-off | 110/110 | 97–100% | 14.9 | 1.2 |
| kb-off | 101/110 | 85–96% | 15.3 | 1.4 |

Ten of the eleven tasks are 10/10 in every condition. The whole difference
is `unknown-account`, where the model must create a payment to a nonexistent
account and the rejection comes back as a *normal ack* with a specific status
code. This is a fact the wire schema never states.

With the KB tools present, the model gets the code right on the first try,
20/20 across the two KB conditions. One `kb_search` excerpt is enough with
real content. With empty content, it tries the search, gets `[]`, falls
through to a committed suite (`insufficient-funds` demonstrates the rejection
ack), and still writes the right assertion before its first run.

Without the tools, the model guesses the wrong code all ten times (same
guess at temp 0), even though the red run's error prints the correct value
(`status: expected 2, got 1`). One of the ten runs updates the suite and goes
green on rerun, while the other nine wander through schema lookups and result
polling until the 25-step budget runs out. The miss is recovery discipline
under budget pressure, not missing information since the answer was on screen
from step 6.

Excluding that task, the three conditions are statistically
indistinguishable on tool calls (14.3 / 15.4 / 14.3). Furthermore, the KB is
not uniformly cheaper, it costs more on `cancel-payment` and
`interleaved-payments`.

The measured value is convergence on facts the schema doesn't state, with
part of the effect living in the authoring surface (a reference to consult
before committing to a code) rather than the guide text alone. These numbers
cover one model and one task set; the empty-result condition is a content
ablation, not a matched-response control. The 9/10 failure seems more like
one deterministic first-guess behavior with a 10% recovery rate, not nine
independent failures.

### The same three ways, on the weaker model (10 runs per task)

Gemma-4-12B ran the identical three-way on 2026-10-17 (the Oct 13 three-run
run was served from a directory misspelled `Gemma4-12B-WAT` — same model,
directory renamed; the pass rate barely moved):

| condition | pass | 95% CI | tool calls (mean) | suite reruns (mean) |
|---|---|---|---|---|
| kb-on | 40/110 | 28–46% | 14.4 | 0.9 |
| kb-content-off | 10/110 | 5–16% | 20.4 | 1.8 |
| kb-off | 29/110 | 19–35% | 17.8 | 0.8 |

36.4% with the KB — the same ceiling as the three-run run (12/33) — with the
same four tasks passing reliably (`chaos-kill-ledger`, `unknown-account`,
`interleaved-payments`, and the KB-sensitive `gateway-forward-completes`);
the other seven tasks are 0/10 in every condition. Two mechanisms dominate,
both *recovery* failures rather than knowledge gaps: 43% of all attempts
(141/330) end in five to twenty **identical failed `create_suite` calls** —
the validator says e.g. `CreatePayment: missing field txn_id`, and the model
resends the same payload until the 25-step budget dies; and red suites are
never repaired (`reversal-chain` kb-on: ten checklist-full suites that ran
red on the final balances, then the same `db_query` repeated until the budget
died, `update_suite` never called). The fail → fix → re-run loop the 27B
model shows is exactly the capability the 12B model lacks. One
weak-model-specific effect: **dead tools are worse than no tools.**
`kb-content-off` (10/110) is far worse than `kb-off` (29/110), CIs disjoint,
even though Gemma never calls the dead `kb_search`/`kb_read` (0/110 attempts;
Qwen3.8-27B tries them in 70/110) — two unused tool definitions measurably degrade
first-draft quality (28/110 vs 46/110 valid first suites). On Qwen3.8-27B the
content-off condition matches kb-on exactly (110/110), so this is a
model-size effect, not a harness artifact. Scrubbed traces of all three
failure shapes: [`sample-trace-gemma-shallow.md`](artifacts/eval/sample-trace-gemma-shallow.md),
[`sample-trace-gemma-retry-loop.md`](artifacts/eval/sample-trace-gemma-retry-loop.md),
[`sample-trace-gemma-no-repair.md`](artifacts/eval/sample-trace-gemma-no-repair.md).

### The same three ways, at the frontier (10 runs per task)

gpt-6-luna ran the same three-way on 2026-10-17. The Oct 14 three-run
run is the row above, and the endpoint is reasoning off, as before.
Two data-quality notes, stated plainly. The first 10-run attempt lost
14 runs to connection stalls. A bare fetch can only die on those, so
the client now has an explicit per-request timeout plus retries. Three
(task, condition) pairs still had bad runs, so we re-ran them and took
the whole pairs from the patch runs. The OpenAI seed is best effort,
not deterministic. The patch run redrew 10 of the 27 other slots in
those pairs. So the numbers below are distribution level, not per run.

| condition | pass | 95% CI | tool calls (mean) | suite reruns (mean) |
|---|---|---|---|---|
| kb-on | 79/110 | 63–79% | 13.5 | 1.1 |
| kb-content-off | 86/110 | 70–85% | 13.4 | 1.6 |
| kb-off | 90/110 | 74–88% | 18.4 | 1.4 |

71.8% with the KB, 81.8% without. All three CIs overlap, and the
gradient, if anything, runs the wrong way, with kb-on the lowest of the
three. At the frontier the KB is a pass-rate wash. The two questions
the 3-run data left open both close. The dead-tools penalty does not
carry up the capability ladder. On Gemma, `kb-content-off` (10/110) is
far below `kb-off` (29/110), and the CIs do not overlap. On Luna it is
the best condition, 86/110 vs 79/110 for kb-on. With Qwen3.8-27B in the
middle, where content-off equals kb-on at 110/110, the dead-tools
effect is a small-model thing, not a property of the tool surface. And
both KB-sensitive tasks stop separating the models.
`gateway-forward-completes` is 10/10 in every condition, and the 1/3
kb-off from the 3-run data was just n=3 noise. `unknown-account`, the
task that cost Qwen3.8-27B its only 10-run miss, is also 10/10 in every
condition. The frontier model infers the protocol from introspection
alone, status codes included. The residual KB effect lives in one
task. `settle-moves-money` goes 9/6/8 across the conditions. The
frontier has its own failure shape, to go with the 12B's retry loops.
`chaos-kill-ledger` fails 6/10 in both `kb-on` and `kb-off`, and it is
always the same two missing checklist items, the final `accounts`
balance assertions at 497,500 and 252,500 cents. The suite runs green
but never checks where the money landed. That is the assertion
discipline miss the 3-run `happy-path` 5/6 hint was pointing at, now
measured.

## What's in the repo

| Layer | What | Where |
|---|---|---|
| **Test target** | C11 payments backend: 3 TCP processes, binary wire protocol, X-macro message tables, function-pointer dispatch, SQLite | `backend/` |
| **Agent surface** | MCP server (stdio) — 15 tools: protocol introspection, suite CRUD, execution, read-only DB, KB search/read | `harness/src/mcp/` |
| **Knowledge pipeline** | kb-forge: per-directory "intern guides" generated from source, deterministic retrieval, hash-pinned staleness gate | `harness/src/kb/` → `knowledge/` |
| **Evaluation** | 11-task KB on/off harness — programmatic judge, independent re-run, per-model baselines — plus a recorded-trace replay gate | `harness/src/eval/` |
| **App & CLI** | Electron/React GUI (suites, live run, registry, database) and a headless CLI over one shared, electron-free runner | `harness/src/` |
| **One-command guarantee** | `npm run verify`: C build, ASan/UBSan smoke (28 checks), fmt, typecheck, unit tests, live suite, MCP A/B, replay gate, KB staleness | `harness/scripts/verify.sh` |

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
│  risks, inter-process interactions, domain vocabulary — generated, then committed  │
│  consumers:  MCP test author (kb_search/kb_read/schema notes) · designer CLI       │
└────────────────────────────────────────────────────────────────────────────────────┘
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

## Why the test target is a real C system

The backend is a deliberate stand-in for a complex multi-process C system.
The shape is the point, the domain is not:

- **Three long-lived TCP processes** that forward to each other
  (pay-orders → ledger → auth-gateway), with fire-and-forget hops in the
  middle
- **A hand-rolled binary wire protocol** — 8-byte little-endian frame header
  + packed payloads at exact `offsetof` offsets. No OpenAPI, no REST, no
  framework emitting a schema
- **X-macro message declarations** expanding into both the packed structs
  *and* the metadata table; handlers wired as function-pointer dispatch
  tables
- **SQLite** as the only persistence, shared by all three processes
- **Zero documentation.** The code is the only source of truth

That is where LLM agents actually have to work — and where a knowledge base
earns its keep, because there is no schema file to hand the model, only C.
Everything in this repo (the introspected registry, the forged guides, the
KB on/off measurement) is the answer to that environment, with numbers
attached.

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

## The agent's world: an MCP surface designed for it

The premise: the agent is the **primary author** of the test suites, not a
demo. Its entire world is 15 MCP tools (13 with `MCP_NO_KB=1` — the A/B
switch the eval uses); there is no back door. Three design decisions do most
of the work:

- **Validated before it exists.** `create_suite` runs the suite through
  registry validation before anything touches disk — unknown messages,
  unknown fields, unknown processes, non-SELECT SQL, bad step shapes: all
  rejected with a structured error. The agent cannot persist an invalid
  suite; it can only see why.
- **Errors as steering.** Failure text is written as an instruction the agent
  can act on: `unknown message pay-orders/RefundPayment` comes back with
  `kbHints` pointing at the relevant guide; the loop is author → run → read
  the result → fix → re-run.
- **Score the artifact, never the words.** The agent's own "it passed" is
  never trusted: the generated suite is re-run on a fresh cluster and checked
  against an exact ground-truth checklist. No LLM judge anywhere in the
  scoring path.

Full design rationale — including what was **tried and rejected** (vector
retrieval, LLM-judged scoring, a supervisor loop) and why — is in
[`docs/agent.md`](docs/agent.md).

## Keeping the agent harmless

The uncomfortable fact up front: **the agent writes raw SQL that executes
against the backend database, and can SIGKILL backend processes** (failure-
mode and chaos tests need both). The design goal is not to make those
capabilities impossible — it is to make the *worst case harmless*,
structurally, rather than relying on the model behaving:

1. **Validate at authoring** — only `SELECT`/`WITH`, single-statement SQL,
   registry-validated steps, charset-locked suite names.
2. **Contain at execution** — the db path runs on a *read-only* driver
   connection; kills target only the child PIDs of the disposable cluster the
   runner spawned, never a pid the agent supplies.
3. **Blast radius does the rest** — every run gets a fresh cluster + fresh
   database; nothing long-lived exists to damage.

Every hostile case is a committed test, and the same hostile inputs are
replayed through the live MCP server on every push (the Layer A gate below).
Threat table, the three layers in code, and the honest residual risks:
[`docs/security.md`](docs/security.md).

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

Seven more suites are committed (eight in total, including the LLM-
authored one): `payment-happy-path` (10/10 green),
`ledger-chain-reversals` (22 steps), `insufficient-funds`, `cancel-payment`,
`transfer-800`, `ledger-chaos-kill` (kills the ledger mid-run, asserts the
typed failure, verifies state is exactly pre-kill), and
`assertion-failure-demo` (a failing run with an expected-vs-actual diff).

```bash
npm run run:cli -- suites/insufficient-funds.json
```

Every run persists a machine-readable result JSON to `artifacts/suite-runs/`
(gitignored). If you want shareable **proof of what a run actually did** —
a self-contained HTML report styled like the app, with each step's action,
pass/fail status, assertions (expected vs actual, mismatches highlighted),
and a timing waterfall — opt in with `HARNESS_HTML_REPORTS=1`:

```bash
HARNESS_HTML_REPORTS=1 npm run run:cli -- suites/insufficient-funds.json
# → artifacts/test-reports/insufficient-funds_<timestamp>.html
```

Reports are off by default so routine runs (and the 66-run eval) don't
litter the tree; flip the flag when you want an artifact of a run to
attach to a bug report or a review.

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

## Evaluation — methodology and gates

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
npm run eval -- --variant three-way --runs 10 --seed 42
# three-way = kb-on, kb-content-off (same KB tool names, empty content), kb-off
```

Interpret the existing `kb-on` versus `kb-off` comparison as two complete
agent configurations: the KB-off server removes tools as well as knowledge.
The added `kb-content-off` condition preserves KB tool names but returns
empty search/read content. It is a better control, not a perfect causal
isolation. Use `--variant three-way --runs 10 --seed 42` to run all three
conditions. A seed helps reproduce requests on compatible endpoints, but
does not guarantee deterministic generation.

Every report carries an **experiment manifest** (hashes of the config,
system prompt, task set, per-condition tool surface, KB manifest, and
wire-protocol registry), per-task and per-category outcomes with 95% Wilson
confidence intervals, min/p50/p95 distributions, and failures grouped by
cause — so no attempt ever silently drops from a denominator.

The eval doubles as a regression gate in two layers. **Layer A**
(`npm run eval:replay`, in `npm run verify`, ~4 s, no LLM) replays recorded
agent tool-call traces against the live MCP server and asserts properties of
each result — catching tool renames, KB content regressions, and
error-message wording changes on every push. **Layer B**
(`.github/workflows/eval.yml`) runs the full eval and fails on regression
below the per-model baseline in `harness/src/eval/baseline.json`; opt-in via
the `EVAL_RUN_EVAL` repository variable + `EVAL_API_*` secrets.

Methodology, task set, report format, and how to add tasks:
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

kb-forge writes one **intern guide** per source directory (fixed section
schema: Purpose / Files / Domain vocabulary / Messages with preconditions and
side effects / Key functions with `file:line` / Common modification points /
Risks / Inter-process interactions). Consumers:

- **MCP test author** — `kb_search`/`kb_read` tools; `get_message_schema`
  carries the KB row as `notes`; `create_suite` failures carry `kbHints`.
  `MCP_NO_KB=1` disables it all (the A/B switch the
  [eval](#evaluation--methodology-and-gates) uses to measure the
  difference). → [`docs/mcp.md`](docs/mcp.md)
- **Designer** — turns a plain-English change request into a reviewable
  design doc (X-macro proposal, handler sketch, risks citing `knowledge/`
  paths, suggested suite). Sample outputs: [`docs/designs/`](docs/designs/).

→ [`docs/knowledge.md`](docs/knowledge.md)

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
  src/ledger/        double-entry ledger (:9102)
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
  src/**/*.test.ts    node:test unit tests (npm run test:unit)
  suites/             8 committed sample suites (no-double-settle is agent-authored)
  scripts/            gen_registry.js · mcp-self-test.js · clean-runs.js · demo-gif/
artifacts/          generated artifacts (gitignored except committed sample-*)
  suite-runs/         per-run JSON results (every run_suite; prune: npm run runs:clean)
  test-reports/       self-contained HTML run reports (HARNESS_HTML_REPORTS=1)
  eval/               eval reports + independent reruns (eval/runs/)
knowledge/            generated intern guides (+ INDEX.md + .manifest.json)
docs/
  plans/InitialDesign.md    the full design plan (phases P1–P6)
  conventions/conventions.md the project's conventions & gates
  agent.md            tool & agent design (why the MCP surface is shaped this way)
  security.md         threat model for agent-authored SQL / killProcess / MCP
  eval.md             the KB on/off evaluation methodology (npm run eval)
  protocol.md · mcp.md · knowledge.md
  designs/          sample designer output (KB-grounded vs schema-only pair)
  demo.gif          the ~47s half-speed demo (linked at the top of the
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
3. **Disable thinking tokens by default, measure, then decide.** Qwen3.8-27B's
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
