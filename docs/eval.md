# Evaluation: measuring what the knowledge pipeline does

The eval answers one question with numbers: **given a plain-English task, how
well does an LLM agent author a correct, deep-asserting test suite through
the harness MCP tools, with the knowledge base available (KB on) vs.
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

# Hosted APIs: the client auto-detects two OpenAI quirks on the first 400
# and retries: it drops the Qwen template parameter OpenAI rejects, and
# sets reasoning_effort:"none" for reasoning models that refuse function
# tools in /chat/completions (gpt-6-luna). So such models are evaluated with
# reasoning off on this endpoint; no extra env var needed.

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

For each variant, one MCP server is spawned (`MCP_NO_KB=1` flips it off,
`kb_search`/`kb_read` simply do not exist in that variant). For each task ×
run:

1. **Agent loop**: a minimal model-agnostic client
   (`src/eval/agent.ts`): OpenAI-compatible chat completions + the harness
   MCP server as a stdio MCP client. The model sees exactly the 15 tools (13
   in the KB-off variant) that `pi` or Claude Desktop would use, with the
   fixed system prompt in `src/eval/prompt.ts`. Every tool call, result
   (truncated), token count, and duration is recorded.
2. **Judge**: the generated suite JSON is checked structurally against the
   task's ground-truth checklist (`src/eval/judge.ts`). No LLM judge, no
   thresholds: each item is satisfied or not.
3. **Independent re-run**: the generated suite is executed on a fresh
   cluster + fresh database by the runner itself (`src/eval/runner.ts`).
   The agent's own `run_suite` result is never trusted; the artifact is.
4. **Cleanup**: the eval suite file and its database are removed; a
   post-run `git status` check warns if any tracked suite was touched.

**pass = suite created AND runs green AND the full checklist is satisfied.**

## The task set

Eleven tasks in `src/eval/tasks.ts`, each a plain-English prompt (the way a
user would actually phrase it) + exact ground truth derived from the seed
data (ACCT-001 500000 / ACCT-002 250000 / RESERVE 1000000 cents) and the
handler semantics. Every number is cross-checked against the committed
suites that cover the same behavior. Two tasks are KB-sensitive: their
ground truth is documented in the intern guides but not derivable from the
wire schemas; the prompts deliberately do not leak the answer.

| task | what it probes |
|---|---|
| `happy-path` | full lifecycle; settle lands money in RESERVE |
| `double-settle-rejection` | second Settle is a *normal* ack with status 2 (not an error) |
| `insufficient-funds` | ledger rejection ack status 1; nothing moves |
| `cancel-payment` | cancelled payment cannot be authorized (`approved: 0`) |
| `reversal-chain` | per-transaction reversals, out of order (non-LIFO) |
| `chaos-kill-ledger` | `killProcess` + `expectError` on the dead process; survivors unaffected |
| `gateway-forward-completes` | **KB-sensitive:** the prompt only says "an external authorization completes a payment"; the agent must discover (from the KB) that Authorize forwards `CompletePayment` downstream, then assert the payment's `status = complete` in the database after a delay |
| `settle-moves-money` | **KB-sensitive:** "verify the settlement actually moved the money where it goes"; the prompt never says *where*. The KB row for `Settle` says: forwards `TransferFunds` account→RESERVE, full amount, fee not modeled. Ground truth: RESERVE 1000000+50000 |
| `settle-then-reverse` | reversing the settlement transfer returns RESERVE to seed |
| `unknown-account` | account-not-found is ack status 1, and no row is created (`COUNT(*) = 0`) |
| `interleaved-payments` | two payments through the full lifecycle; RESERVE receives both |

The smoke set is `happy-path`, `double-settle-rejection`, and
`gateway-forward-completes`, always including the KB-sensitive one so the
A/B is meaningful even in a short run.

## Reading the report

Reports land in `artifacts/eval/` (gitignored, except committed
`sample-*`):

- `<stamp>-<model>.json`: full report, config, every run with the complete
  tool-call trace, per-run checklist details and failure cause, variant
  summaries, and the experiment manifest.
- `<stamp>-<model>.md`: the summary table (what the README quotes).

The JSON's `manifest` block is the run's identity: start time and run
order, sha256 hashes of the config, system prompt, and task set, the
model-visible tool surface per condition (the content-off rewrite is part
of what the model saw, so it is in the hash), the KB manifest and
wire-protocol registry, and the repo revision. Two reports with identical
manifests ran identical experiments; a differing hash tells you what
changed.

Every attempt stays in the denominator. Each non-passing run carries a
`failureReason`: `agent-error` (API/malformed call), `timeout`,
`step-budget` (max tool steps exhausted), `no-suite`, `suite-red`
(independent re-run failed), or `checklist-missing`; summaries group
failures by cause, so nothing is silently dropped.

| column | meaning |
|---|---|
| pass | suite created + green + full checklist (the score) |
| 95% CI (pass) | Wilson score interval for pass/runs; uncertainty over repeated runs of this fixed setup, not a general estimate; stays inside 0–100% even for small n |
| suite green | the generated suite runs 100% (independent re-run) |
| checklist full | all ground-truth items present in the suite JSON |
| avg tool calls | efficiency of the agent loop |
| p50 wall | median wall time, agent loop + independent re-run |
| avg tokens in/out (per run) | mean prompt/completion tokens per agent run (from the model server's usage) |
| avg cost (usd/run) | mean cost per agent run from the committed price table; `n/a` when the model has no committed price, never a guess |
| total tokens in / out | summed across runs (from the model server's usage) |
| total cost (usd) | summed per-run cost from the committed price table
  (`src/eval/pricing.ts`, keyed by model id); GGUF path ids are treated as
  local ($0.00); `n/a` when the model has no committed price, never a guess |

Interpretation rules:

- **The KB's measurable value moves from efficiency to pass-or-fail as the
  model gets weaker, measured on both models, not predicted.** On
  Qwen3.8-27B (strong), pass rates end up close (33 vs 32) because a strong
  model plus the self-correcting loop (red run → inspect → `update_suite`
  → re-run) can converge even without the KB; the value shows in
  *efficiency* (avg suite runs 1.0 vs 1.3, tool calls 13.2 vs 14.6) and in
  one-shot correctness on the KB-sensitive tasks. On Gemma-4-12B (weaker)
  the same A/B shows in the *pass rate itself* (12 vs 8, +50% relative),
  with the mechanism visible: 31 of its 66 runs exhaust the 25-step tool
  budget, and the KB is what keeps a weak model inside it.
- Expect KB on ≤ KB off on avg suite runs / tool calls on any model.
- If a run shows KB on *worse* than KB off on any column, the experiment is
  broken or the KB row is stale; fix the artifact, never the number. One
  documented inversion: gemma-4-12b (10-run three-way, 2026-10-17) has *more*
  avg suite runs with the KB (0.9 vs 0.8) because without it a third of the
  runs die in identical-retry `create_suite` loops before ever running a
  suite: check the traces before declaring the experiment broken.
- **Dead tools are worse than no tools on weak models.** gemma-4-12b never
  called the empty `kb_search`/`kb_read` (0/110 attempts) yet scored 10/110
  with them present vs 29/110 with them absent (CIs disjoint); first-draft
  validity also dropped 110/110 → 28/110 (first `create_suite` passes the
  validator). On Qwen3.8-27B the content-off condition
  matches kb-on exactly (110/110), so this is a model-size effect, not a
  harness artifact.
- Numbers are from **3 runs per task** (temperature 0 is not determinism on
  a quantized local model); report distributions, never a single run.
  The report's `distributions` rows (min/p50/p95 across all attempts) and
  the per-category tables exist for exactly this: look at the spread and the
  strata, not the headline cell.
- A close gap inside the CI (e.g. 33/33 vs 32/33) is **inconclusive**, not a
  win or a regression; say so in prose instead of picking a winner.
- A model change is an experiment change: the committed sample reports name
  the exact model file served.

## Results: the committed data

### The original 3-run two-condition eval

Two local models via llama.cpp on a LAN GPU box, plus one hosted frontier
model (gpt-6-luna via OpenAI): 3 runs per task, temperature 0, two conditions
(kb-on / kb-off). This is the original 3-runs-per-task, two-condition eval
(66 runs per model); the 10-run three-way tables below supersede it for
pass-rate claims. Trimmed full-fidelity samples (agent-authored suites
intact, tool results truncated) in
[`sample-Qwen3.8-27B.json`](../artifacts/eval/sample-Qwen3.8-27B.json),
[`sample-gpt-6-luna.json`](../artifacts/eval/sample-gpt-6-luna.json), and
[`sample-gemma-12b.json`](../artifacts/eval/sample-gemma-12b.json) for the
3-run eval, and
[`sample-Qwen3.8-27B-3way.json`](../artifacts/eval/sample-Qwen3.8-27B-3way.json),
[`sample-gemma-12b-3way.json`](../artifacts/eval/sample-gemma-12b-3way.json),
and
[`sample-gpt-6-luna-3way.json`](../artifacts/eval/sample-gpt-6-luna-3way.json)
for the 10-run three-way (the Luna sample is stitched; its `sampleNote`
documents the merge):

| model | config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | avg tokens in/out (per run) | avg cost (usd/run) |
|---|---|---|---|---|---|---|---|---|---|
| **Qwen3.8-27B Q4_K_M** (the GIF's model) | **kb-on** | **33/33** | 33/33 | 33/33 | 13.2 | **1.0** | 13 | 53,285 / 1,098 | 0.0000 |
| Qwen3.8-27B Q4_K_M | kb-off | 32/33 | 32/33 | 32/33 | 14.6 | 1.3 | 11 | 48,993 / 1,311 | 0.0000 |
| gpt-6-luna (hosted, OpenAI) | kb-on | 20/33 | 30/33 | 20/33 | 13.7 | 1.1 | 13 | 35,298 / 809 | 0.0039 |
| gpt-6-luna (hosted, OpenAI) | kb-off | 22/33 | 28/33 | 22/33 | 22.2 | 1.1 | 19 | 58,118 / 955 | 0.0063 |
| Gemma-4-12B QAT Q4_0 | **kb-on** | **12/33** | 21/33 | 15/33 | 14.4 | 0.9 | 14 | 87,127 / 2,555 | n/a |
| Gemma-4-12B QAT Q4_0 | kb-off | 8/33 | 14/33 | 8/33 | 18.1 | 0.8 | 50 | 96,361 / 4,122 | n/a |

The short version: the KB's measurable value moves from efficiency to
pass-or-fail as the model gets weaker, and at the frontier it mostly
disappears, except on the tasks whose ground truth lives only in the KB.

- **Qwen3.8-27B (strong):** pass rate saturates (33 vs 32); the value shows
  as *efficiency*: one-shot suites (1.0 vs 1.3 re-runs), fewer tool calls
  (13.2 vs 14.6). The single failure (KB-off `unknown-account`, 2/3) is the
  class of miss the KB exists to prevent. The 10-run three-way below sharpens
  both points.
- **gpt-6-luna (hosted frontier):** pass rate is a wash at n=10 (79 vs 90,
  overlapping CIs); a strong model appears to infer the protocol from
  introspection alone, status codes included. The 3-run table's gaps (20 vs
  22 overall; 3/3 vs 1/3 on `gateway-forward-completes`) are consistent with
  n=3 noise: 10/10 in every 10-run condition, and `settle-moves-money` (3/3
  vs 2/3) narrows to 9/6/8. Its failure mode is not the budget exhaustion
  that is Gemma's miss, but a *functionally correct* suite that drops one
  ground-truth assertion: the 3-run `happy-path` kb-on 0/3 on a missing
  `Settle` ack check, and at n=10 `chaos-kill-ledger` 6/10 in both kb-on and
  kb-off on the missing final-balance assertions. Two caveats: the
  `/chat/completions` endpoint forces `reasoning_effort: "none"` for function
  tools, so every row here is the model with reasoning off, and the 66-run
  eval cost ~$0.35 at $0.10/$0.50 per M tokens. The dead-tools penalty stays
  on the 12B.
- **Gemma-4-12B (weaker):** the value shows in the *pass rate itself*: 12 vs
  8 (+50% relative), fewer tool calls (14.4 vs 18.1), 3.6× faster p50 (14 s
  vs 50 s). Mechanism visible in the data: 31 of its 66 runs exhaust the
  25-step tool budget; the KB keeps a weak model inside it (3/3 vs 2/3 on
  KB-sensitive `gateway-forward-completes`). The 10-run three-way below shows
  the ~36% ceiling is stable across runs, and the misses look like recovery
  failures rather than knowledge gaps.
- The tasks **stratify the models**: `settle-moves-money` (the prompt never
  says *where* settlement money goes) is 3/3 for Qwen in both variants,
  9/6/8 for Luna across the three conditions, and 0/3 for Gemma in both. No
  single task discriminates; the set does. Two tasks are KB-sensitive by
  construction: their ground truth lives only in the intern guides, and the
  prompts never leak it.

### The same model, three ways: Qwen3.8-27B (10 runs per task)

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
20/20 across the two KB conditions. One `kb_search` excerpt is what it
needed. With empty content, it tries the search, gets `[]`, falls through to
a committed suite (`insufficient-funds` demonstrates the rejection ack), and
still writes the right assertion before its first run.

Without the tools, the model guesses the wrong code all ten times (same
guess at temp 0), even though the red run's error prints the correct value
(`status: expected 2, got 1`). One of the ten runs updates the suite and goes
green on rerun, while the other nine wander through schema lookups and
result polling until the 25-step budget runs out. The miss looks like a
recovery-discipline failure under budget pressure rather than missing
information: the answer was on screen from step 6.

Excluding that task, the three conditions are statistically
indistinguishable on tool calls (14.3 / 15.4 / 14.3). Furthermore, the KB is
not uniformly cheaper: it costs more on `cancel-payment` and
`interleaved-payments`.

The measured value is convergence on facts the schema doesn't state, with
part of the effect living in the authoring surface (a reference to consult
before committing to a code) rather than the guide text alone. These numbers
cover one model and one task set; the empty-result condition is a content
ablation, not a matched-response control. The 9/10 failure seems more like
one deterministic first-guess behavior with a 10% recovery rate, not nine
independent failures.

### The same three ways, on the weaker model: Gemma-4-12B (10 runs per task)

Gemma-4-12B ran the identical three-way on 2026-10-17 (the Oct 13 three-run
run was served from a directory misspelled `Gemma4-12B-WAT`; same model,
directory renamed, and the pass rate barely moved):

| condition | pass | 95% CI | tool calls (mean) | suite reruns (mean) |
|---|---|---|---|---|
| kb-on | 40/110 | 28–46% | 14.4 | 0.9 |
| kb-content-off | 10/110 | 5–16% | 20.4 | 1.8 |
| kb-off | 29/110 | 19–35% | 17.8 | 0.8 |

36.4% with the KB, the same ceiling as the three-run run (12/33), with the
same four tasks carrying kb-on (`chaos-kill-ledger`, `unknown-account`,
`interleaved-payments`, and the KB-sensitive `gateway-forward-completes`). On
kb-off, `reversal-chain` also passes 10/10 (it was 3/3 there in the 3-run
data) and `gateway-forward-completes` holds 9/10; the other six tasks are
0/10 in every condition. Two mechanisms dominate, and both look like
*recovery* failures rather than knowledge gaps: 43% of all attempts (141/330)
end in five to twenty **identical failed `create_suite` calls** (the
validator says e.g. `CreatePayment: missing field txn_id`, and the model
resends the same payload until the 25-step budget dies); and red suites are
never repaired (`reversal-chain` kb-on: ten checklist-full suites that ran
red on the final balances, then the same `db_query` repeated until the budget
died, `update_suite` never called). The fail → fix → re-run loop the 27B
model shows is the loop we didn't see from the 12B in these runs. One
weak-model-specific effect: **on this model, dead tools are worse than no
tools.** `kb-content-off` (10/110) is far worse than `kb-off` (29/110), CIs
disjoint, even though Gemma never calls the dead `kb_search`/`kb_read`
(0/110 attempts; Qwen3.8-27B tries them in 70/110). Two unused tool
definitions measurably degrade first-draft quality: 28/110 vs 110/110 valid
first suites (the first `create_suite` passes the harness validator). On
Qwen3.8-27B the content-off condition matches kb-on exactly (110/110), so
this is a model-size effect, not a harness artifact. Scrubbed traces of all
three failure shapes:
[`sample-trace-gemma-shallow.md`](../artifacts/eval/sample-trace-gemma-shallow.md),
[`sample-trace-gemma-retry-loop.md`](../artifacts/eval/sample-trace-gemma-retry-loop.md),
[`sample-trace-gemma-no-repair.md`](../artifacts/eval/sample-trace-gemma-no-repair.md).

### The same three ways, at the frontier: gpt-6-luna (10 runs per task)

gpt-6-luna ran the same three-way on 2026-10-17; the Oct 14 three-run eval is
the row above, on the same reasoning-off endpoint. Two data-quality notes. The
first 10-run attempt lost 14 runs to connection stalls: a bare fetch can only
die on those, so the client now has an explicit per-request timeout plus
retries. Three (task, condition) pairs still had bad runs, so we re-ran them
and took the whole pairs from the patch runs. The OpenAI seed is best effort,
not deterministic, and the patch run redrew 10 of the 27 other slots in those
pairs. The numbers below are therefore distribution-level, not per-run.

| condition | pass | 95% CI | tool calls (mean) | suite reruns (mean) |
|---|---|---|---|---|
| kb-on | 79/110 | 63–79% | 13.5 | 1.1 |
| kb-content-off | 86/110 | 70–85% | 13.4 | 1.6 |
| kb-off | 90/110 | 74–88% | 18.4 | 1.4 |

71.8% with the KB, 81.8% without. All three CIs overlap, and the gradient,
if anything, runs the wrong way, with kb-on the lowest of the three. At the
frontier the KB is a pass-rate wash, and the two questions the 3-run data
left open both get answers.

The dead-tools penalty does not carry up the capability ladder. On Gemma,
`kb-content-off` (10/110) is far below `kb-off` (29/110), and the CIs do not
overlap. On Luna it is the best condition, 86/110 vs 79/110 for kb-on. With
Qwen3.8-27B in the middle, where content-off equals kb-on at 110/110, the
dead-tools effect is a small-model thing, not a property of the tool surface.

And the 3-run gaps close: `gateway-forward-completes` is 10/10 in every
condition (the 1/3 kb-off is consistent with n=3 noise), as is
`unknown-account`, the task that cost Qwen3.8-27B its only 10-run miss. The
frontier model appears to infer the protocol from introspection alone,
status codes included: the pass rate holds with no KB at all.

The residual KB effect shows up in one task: `settle-moves-money` goes 9/6/8
across the conditions. The frontier has its own failure shape, to go with the
12B's retry loops. `chaos-kill-ledger` fails 6/10 in both `kb-on` and
`kb-off`, and it is always the same two missing checklist items, the final
`accounts` balance assertions at 497,500 and 252,500 cents. The suite runs
green but never checks where the money landed. That is the assertion
discipline miss the 3-run `happy-path` 5/6 hint was pointing at, now
measured.

## Adding a task

1. Append an `EvalTask` in `src/eval/tasks.ts`: a prompt phrased the way a
   user would say it (do **not** spell out the mechanism you want the agent
   to discover), an exact `suiteName` (`eval-<id>`), and 3–6 checks.
2. Check kinds (see `src/eval/judge.ts`): `usesMessage` (min count),
   `hasExpectError` (optionally per message), `killsProcess`,
   `expectsAckField` (a send step pins `expectAck[field]` to a value),
   `assertsRow` (a `dbAssert` on a table pins exact column values; ground
   truth is the seed arithmetic, so fix the amounts in the prompt).
3. Verify the ground truth by hand once (run the equivalent committed suite,
   or a throwaway one), then add the task id to the smoke set if it is
   cheap and discriminating.

## Cost & scale

Local 27B (Q4, remote Metal box): a smoke run (6 agent runs) takes roughly
5–15 minutes; a full run (66 agent runs) took **≈ 17 minutes** on the LAN
llama.cpp server for the committed result. There is no API cost for a local
model (the report's `total cost (usd)` column is 0.0000 from the committed price
table in `src/eval/pricing.ts`); for hosted providers that column is what
you bill against, and an unpriced model reports `n/a` rather than a guess.
Concrete hosted example: the committed gpt-6-luna full run (66 agent runs,
OpenAI at $0.10/$0.50 per M tokens) billed **$0.34** in total.

## Regression gate (R2)

Two layers, so the agent surface has CI coverage with and without a model:

### Layer A: recorded-trace replay (deterministic, every push)

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
silently break a real agent (tool renames, schema/arg changes, KB content
regressions, error-message wording changes) before a model run could show
them. To add a trace: capture `trace[]` from a real eval report JSON (or
write the JSON by hand), assert substrings, list created suites in `cleanup`.

### Layer B: real-model job with baseline (opt-in, secrets)

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

## Per-run trace reports

Every eval run records a full tool trace (tool, args, ok/error, result
preview, duration). `npm run trace-report` turns one run of a saved eval
report into a human-readable Markdown file, with no model or backend needed:

```bash
cd harness
# one run: <report.json> <taskId>/<variant>/<run>
npm run trace-report -- ../artifacts/eval/<report>.json unknown-account/kb-off/9 --key "$EVAL_API_KEY"
# every run of a report (writes <variant>/<task>-runNN.md under DIR)
npm run trace-report -- ../artifacts/eval/<report>.json --all --out-dir /tmp/traces
```

A report shows: the run summary (outcome, failure cause, checklist,
independent rerun, tokens/cost, wall time), a phase timeline of every tool
call (discovery / kb-lookup / authoring / executing) with red suite runs
flagged inline, the suite revision history with field-level diffs between
`create_suite`/`update_suite` revisions, red suite runs with per-step
expected/actual detail, the checklist with reasons, and the agent's final
message. Tool-result text is truncated at 2000 chars in the source trace
(full text was sent to the model); truncation is marked.

Redaction: `EVAL_API_KEY` and any `--key` values are scrubbed from the
output, plus pattern matches for `Bearer` tokens and URL
`user:pass@` credentials. Scrubbed samples from the 2026-10-17 Qwen3.8-27B
10-run three-way: `artifacts/eval/sample-trace-Qwen3.8-27B-recovery.md` (a
fail → update → green recovery) and `sample-trace-Qwen3.8-27B-budget.md` (a
step-budget failure). From the 2026-10-17 gemma 10-run three-way:
`sample-trace-gemma-shallow.md` (green suite, missing ack pin,
checklist-missing), `sample-trace-gemma-retry-loop.md` (the same invalid
suite resubmitted until the step budget dies), and
`sample-trace-gemma-no-repair.md` (a checklist-full red suite that is never
updated).
