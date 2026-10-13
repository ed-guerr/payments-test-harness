# Evaluation — measuring what the knowledge pipeline does

The eval answers one question with numbers: **given a plain-English task, how
well does an LLM agent author a correct, deep-asserting test suite through
the harness MCP tools — with the knowledge base available (KB on) vs.
schema-only (KB off)?**

The GIF in the README shows one unedited session. This is the controlled
experiment behind it.

## Running it

```bash
# model config (env or flags):
#   EVAL_API_BASE   OpenAI-compatible base URL   (default http://127.0.0.1:8080/v1)
#   EVAL_API_MODEL  model name                   (default "local")
#   EVAL_API_KEY    optional (hosted providers)
#   EVAL_TEMPERATURE (default 0)
#   EVAL_MAX_TOOL_STEPS (default 25)
#   EVAL_RUN_TIMEOUT_MS (default 900000)
#   EVAL_THINKING=1  enable Qwen-style reasoning tokens (default off)

npm run eval            # 11 tasks x 3 runs x {kb-on, kb-off} + baseline gate
npm run eval:smoke      # 3 tasks x 1 run x both variants (fast sanity)
npm run eval:replay     # Layer A gate: recorded traces, no model (~4 s)

# useful flags
npm run eval -- --tasks happy-path,double-settle-rejection --runs 5
npm run eval -- --variant on --model <id> --base <url>
npm run eval -- --min-pass 2   # override the baseline: exit 1 if any variant < 2
```

Examples against LAN llama.cpp servers (the two models behind the README
table; single-model llama.cpp servers list the GGUF *path* as the model id):

```bash
# Qwen3.8-27B Q4_K_M (the model in the demo GIF), port 8080
npm run eval:smoke -- --base http://<your-lan-gpu-box>:8080/v1 --model qwen3 --key <llama.cpp password>

# Gemma-4-12B QAT Q4_0, port 8082
npm run eval:smoke -- --base http://<your-lan-gpu-box>:8082/v1 \
  --model gemma-4-12b-it-qat-q4_0.gguf --key <llama.cpp password>
```

Preflight checks: backend binaries built, model server reachable at
`EVAL_API_BASE` (`GET /models`), model id in the server's list (warning only).

After the run, the per-model baseline in `harness/src/eval/baseline.json`
gates the result (a variant below its committed min pass exits non-zero);
smoke runs are recorded but not gated, since the baseline covers the full
task set. The report JSON and table both include a `regression gate`
section.

## What a run does

For each variant, one MCP server is spawned (`MCP_NO_KB=1` flips it off —
`kb_search`/`kb_read` simply do not exist in that variant). For each task ×
run:

1. **Agent loop** — a minimal model-agnostic client
   (`src/eval/agent.ts`): OpenAI-compatible chat completions + the harness
   MCP server as a stdio MCP client. The model sees exactly the 15 tools (13
   in the KB-off variant) that `pi` or Claude Desktop would use, with the
   fixed system prompt in `src/eval/prompt.ts`. Every tool call, result
   (truncated), token count, and duration is recorded.
2. **Judge** — the generated suite JSON is checked structurally against the
   task's ground-truth checklist (`src/eval/judge.ts`). No LLM judge, no
   thresholds: each item is satisfied or not.
3. **Independent re-run** — the generated suite is executed on a fresh
   cluster + fresh database by the runner itself (`src/eval/runner.ts`).
   The agent's own `run_suite` result is never trusted; the artifact is.
4. **Cleanup** — the eval suite file and its database are removed; a
   post-run `git status` check warns if any tracked suite was touched.

**pass = suite created AND runs green AND the full checklist is satisfied.**

## The task set

Eleven tasks in `src/eval/tasks.ts`, each a plain-English prompt (the way a
user would actually phrase it) + exact ground truth derived from the seed
data (ACCT-001 500000 / ACCT-002 250000 / RESERVE 1000000 cents) and the
handler semantics. Every number is cross-checked against the committed
suites that cover the same behavior. Two tasks are KB-sensitive: their
ground truth is documented in the intern guides but not derivable from the
wire schemas — the prompts deliberately do not leak the answer.

| task | what it probes |
|---|---|
| `happy-path` | full lifecycle; settle lands money in RESERVE |
| `double-settle-rejection` | second Settle is a *normal* ack with status 2 (not an error) |
| `insufficient-funds` | ledger rejection ack status 1; nothing moves |
| `cancel-payment` | cancelled payment cannot be authorized (`approved: 0`) |
| `reversal-chain` | per-transaction reversals, out of order (non-LIFO) |
| `chaos-kill-ledger` | `killProcess` + `expectError` on the dead process; survivors unaffected |
| `gateway-forward-completes` | **KB-sensitive:** the prompt only says "an external authorization completes a payment" — the agent must discover (from the KB) that Authorize forwards `CompletePayment` downstream, then assert the payment's `status = complete` in the database after a delay |
| `settle-moves-money` | **KB-sensitive:** "verify the settlement actually moved the money where it goes" — the prompt never says *where*. The KB row for `Settle` says: forwards `TransferFunds` account→RESERVE, full amount, fee not modeled. Ground truth: RESERVE 1000000+50000 |
| `settle-then-reverse` | reversing the settlement transfer returns RESERVE to seed |
| `unknown-account` | account-not-found is ack status 1, and no row is created (`COUNT(*) = 0`) |
| `interleaved-payments` | two payments through the full lifecycle; RESERVE receives both |

The smoke set is `happy-path`, `double-settle-rejection`, and
`gateway-forward-completes` — always including the KB-sensitive one so the
A/B is meaningful even in a short run.

## Reading the report

Reports land in `harness/eval-reports/` (gitignored, except committed
`sample-*`):

- `<stamp>-<model>.json` — full report: config, every run with the complete
  tool-call trace, per-run checklist details, variant summaries.
- `<stamp>-<model>.md` — the summary table (what the README quotes).

| column | meaning |
|---|---|
| pass | suite created + green + full checklist (the score) |
| suite green | the generated suite runs 100% (independent re-run) |
| checklist full | all ground-truth items present in the suite JSON |
| avg tool calls | efficiency of the agent loop |
| p50 wall | median wall time, agent loop + independent re-run |
| tokens in / out | summed across runs (from the model server's usage) |
| cost (usd) | per-run cost from the committed price table
  (`src/eval/pricing.ts`, keyed by model id); GGUF path ids are treated as
  local ($0.00); `n/a` when the model has no committed price — never a guess |

Interpretation rules:

- **The KB's measurable value moves from efficiency to pass-or-fail as the
  model gets weaker — measured on both models, not predicted.** On
  Qwen3-27B (strong), pass rates end up close (33 vs 32) because a strong
  model plus the self-correcting loop (red run → inspect → `update_suite`
  → re-run) can converge even without the KB; the value shows in
  *efficiency* (avg suite runs 1.0 vs 1.3, tool calls 13.2 vs 14.6) and in
  one-shot correctness on the KB-sensitive tasks. On Gemma-4-12B (weaker)
  the same A/B shows in the *pass rate itself* (12 vs 8, +50% relative),
  with the mechanism visible: 31 of its 66 runs exhaust the 25-step tool
  budget, and the KB is what keeps a weak model inside it.
- Expect KB on ≤ KB off on avg suite runs / tool calls on any model.
- If a run shows KB on *worse* than KB off on any column, the experiment is
  broken or the KB row is stale — fix the artifact, never the number.
- Numbers are from **3 runs per task** (temperature 0 is not determinism on
  a quantized local model); report distributions, never a single run.
- A model change is an experiment change: the committed sample reports name
  the exact model file served.

## Adding a task

1. Append an `EvalTask` in `src/eval/tasks.ts`: a prompt phrased the way a
   user would say it (do **not** spell out the mechanism you want the agent
   to discover), an exact `suiteName` (`eval-<id>`), and 3–6 checks.
2. Check kinds (see `src/eval/judge.ts`): `usesMessage` (min count),
   `hasExpectError` (optionally per message), `killsProcess`,
   `expectsAckField` (a send step pins `expectAck[field]` to a value),
   `assertsRow` (a `dbAssert` on a table pins exact column values — ground
   truth is the seed arithmetic, so fix the amounts in the prompt).
3. Verify the ground truth by hand once (run the equivalent committed suite,
   or a throwaway one), then add the task id to the smoke set if it is
   cheap and discriminating.

## Cost & scale

Local 27B (Q4, remote Metal box): a smoke run (6 agent runs) takes roughly
5–15 minutes; a full run (66 agent runs) took **≈ 17 minutes** on the LAN
llama.cpp server for the committed result. There is no API cost for a local
model (the report's `cost (usd)` column is 0.0000 from the committed price
table in `src/eval/pricing.ts`); for hosted providers that column is what
you bill against, and an unpriced model reports `n/a` rather than a guess.

## Regression gate (R2)

Two layers, so the agent surface has CI coverage with and without a model:

### Layer A — recorded-trace replay (deterministic, every push)

`npm run eval:replay` (step 8 of `npm run verify`, ~4 s, no LLM) replays the
committed traces in `harness/src/eval/traces/` against the live MCP server
and asserts *properties* of each result rather than pinning full text:

| trace | source | what it pins |
|---|---|---|
| `happy-path-kb-on` | recorded from the 2026-10-13 run (16 calls) | the README demo task end-to-end; `get_message_schema` **carries KB notes** |
| `gateway-forward-kb-on` | recorded from the 2026-10-13 run (13 calls) | the KB-sensitive task; `kb_search` finds the forward behavior |
| `double-settle-kb-off` | recorded from the 2026-10-13 run (15 calls) | schema-only mode: `get_message_schema` has **no** `notes`; suite still runs green |
| `validation-errors-kb-on` | synthetic (3 calls, all must fail) | the error-as-steering surface: unknown message, unsafe suite name, non-SELECT dbAssert |

A trace fails on any of: an expected-ok call erroring, an expected-error
call succeeding, a missing/extra substring in a result, or the KB on/off
tool set switching incorrectly. It catches the failure classes that would
silently break a real agent — tool renames, schema/arg changes, KB content
regressions, error-message wording changes — before a model run could show
them. To add a trace: capture `trace[]` from a real eval report JSON (or
write the JSON by hand), assert substrings, list created suites in `cleanup`.

### Layer B — real-model job with baseline (opt-in, secrets)

`npm run eval` (full run) applies a per-model regression gate:
`harness/src/eval/baseline.json` commits, per model, the min pass count per
variant. A variant regressing below its baseline exits non-zero and the
report's `gate` section says why. The gate is scale-aware: it only compares
when the run covers the same task count as the baseline, so smoke runs are
recorded but not gated. `--min-pass N` overrides the baseline for one run.

`.github/workflows/eval.yml` runs the full eval (11 tasks × 3 runs × both
variants) on a schedule (Mondays 04:00 UTC), on demand
(workflow_dispatch), and on pushes to `main` that touch the agent surface
(eval code, MCP server, knowledge base, protocol schema). It is **off by
default**: it activates when the repository variable `EVAL_RUN_EVAL` is
`true` and the secrets `EVAL_API_BASE` / `EVAL_API_MODEL` / `EVAL_API_KEY`
are set. After an intentional improvement, re-run the full eval and update
the baseline with the new source note.
