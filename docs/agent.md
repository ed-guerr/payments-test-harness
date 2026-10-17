# Agent & tool design — why the MCP surface looks the way it does

Status: current as of 2026-10-13 (roadmap M3). Companion doc:
[`security.md`](security.md) (threat model for the same surface). Every claim
here links to a file or a committed report.

The premise of this repo: an LLM agent is the **primary author** of the test
suites, not a demo. The GIF shows one session; the eval
(`harness/eval-reports/sample-qwen3-27b.md`) is the controlled measurement.
This doc explains the design decisions that make agent authoring *safe,
replayable, and debuggable* — and what was deliberately not built.

## 1. Design goals

Every agent-authored artifact must be:

1. **Validated before it exists.** `create_suite` runs the suite through
   `validateSuite` (`harness/src/backend/suites.ts`) against the generated
   protocol registry before anything is written to disk: unknown messages,
   unknown fields, unknown processes, bad step shapes, non-SELECT `dbAssert`
   SQL — all rejected with a structured error. An agent cannot persist an
   invalid suite; it can only see why.
2. **Replayable.** A suite is plain JSON on disk
   (`harness/suites/*.json`, 8 committed). The same file runs identically in
   the Electron UI, the headless CLI (`src/runner/cli.ts`), the MCP server,
   and the eval — one runner (`src/runner/runner.ts`), no UI dependency.
3. **Explainable.** A red run can produce an HTML report with per-step
   expected-vs-actual for the failing assertion
   (`src/runner/report.ts`, pinned by `src/runner/report.test.ts`; opt in
   with `HARNESS_HTML_REPORTS=1`, off by default). A failed validation returns the
   offending message plus KB hints (see §3). Nothing in the loop requires
   trusting the agent's narrative.

## 2. The tool surface

`harness/src/mcp/server.ts` exposes **15 tools** (13 with `MCP_NO_KB=1` —
the A/B switch the eval uses). The tool list is the agent's entire world;
there is no back door.

| Group | Tools | Design point |
|---|---|---|
| Introspect | `list_processes`, `list_messages`, `get_message_schema` | The registry is the source of truth. `get_message_schema` also carries a `notes` field with the KB row for that message (`src/mcp/kbTools.ts` → `messageKbNotes`) — the agent gets side-effect knowledge *at the moment it needs it*, not as a separate research step |
| Suite CRUD | `list_suites`, `get_suite`, `create_suite`, `update_suite`, `delete_suite` | `create_suite`/`update_suite` validate against the registry and append KB hints to validation errors (server.ts, the `kbHintsFor` path). Suite names go through `safeSuiteFile` (`src/backend/paths.ts`) — the id charset is a security boundary, see security.md |
| Execute | `run_suite`, `run_all_suites`, `get_run_results` | `run_suite` takes a **suite id, not raw JSON**: the file on disk is the single source of truth, so "what ran" is always inspectable. Each run persists a timestamped JSON + the run returns per-step results |
| Database | `db_schema`, `db_query` | Read-only: `db_query` accepts only `SELECT`/`WITH` and only `*.db` files (server.ts); the driver connection is opened `readOnly: true` (`src/db/db.ts`) |
| Knowledge | `kb_search`, `kb_read` | Deterministic retrieval over the committed intern guides (`knowledge/`), §4 |

Two decisions worth calling out:

- **Structured errors, not booleans.** `create_suite` on a bad suite returns
  `unknown message pay-orders/RefundPayment` *plus* `kbHints: …` — the
  error text is written as an instruction the agent can act on (the agent
  reads it, searches the KB, fixes the suite, retries). This is the whole
  "error messages as steering" idea, §3.
- **`run_suite` separates authoring from execution.** Authoring (CRUD) and
  execution (fresh cluster per run, `src/backend/cluster.ts`) never share a
  code path with the UI — the eval agent, a human via MCP, and the Electron
  app all hit the same runner.

## 3. Error messages as steering

The agent loop is: plan → author → run → read the result → fix. Each failure
mode has a specific tool surface that deflects it, and the failure modes are
pinned by the replay gate (`src/eval/traces/validation-errors-kb-on.json`,
run on every push by `npm run eval:replay`):

| Agent failure mode | Tool response that redirects it | Where |
|---|---|---|
| Invents a protocol message | `create_suite` → `unknown message pay-orders/RefundPayment kbHints: knowledge/backend/… :: …` | `validateSuite` (suites.ts) + `kbHintsFor` (kbTools.ts, appended in server.ts) |
| Misses a required field / wrong type | `pack` error names the field (`missing field currency`) | `src/protocol/codec.ts` |
| Wrong ack expectation | `run_suite` step result: `status: expected 0, got 1` — partial match, extra fields ignored | `matchAck` (runner.ts, pinned by matchAck.test.ts) |
| Wrong balance math | `dbAssert` failure lists expected vs actual per column plus the actual row | `checkRow` (runner.ts), rendered in report.ts |
| Missing side-effect knowledge (e.g. where settlement money goes) | `get_message_schema` carries the KB `notes` row; `kb_search`/`kb_read` for the rest | `messageKbNotes` (kbTools.ts); A/B-pinned in the replay traces (notes present iff KB on) |
| Suite not green | `run_suite` per-step results → `update_suite` → re-run (the self-correction loop the eval measures as `suiteRuns`) | runner + traces |

The eval's honest finding (sample report, 33/33 KB-on vs 32/33 KB-off on
Qwen3.8-27B): on a *strong* model the loop converges even schema-only, so the
KB's measurable value there is **one-shot correctness** (avg suite runs 1.0
vs 1.3) and fewer tool calls (13.2 vs 14.6) — the single failure was KB-off
on exactly the class of miss the KB exists to prevent.

## 4. Deterministic retrieval — deliberately no vector DB

`kb_search` (`src/kb/index.ts`) is ~100 lines of plain TypeScript:
`tokenize` (lowercase, split, stopwords) + `scoreSection` (term frequency
per section, path/title weighted). Corpus: 12 committed guides, ~28 KB,
fixed §6.2 section schema (`src/kb/meta.ts` + `src/kb/forge.ts`).

Why not embeddings:

- **Flake-freeness.** Same query → same top hit, every time, on any machine.
  The retrieval is testable in CI (`src/kb/kb.test.ts` pins that the
  eval's KB-sensitive query lands on `auth_gateway`), and the replay gate
  pins that `kb_search` results still contain the guides the eval depends
  on. A vector index over 28 KB would make both of those flaky.
- **Explainability.** Results carry `score` + `excerpt`, so a human can see
  *why* the agent was pointed somewhere. The eval's traces show agents using
  the scores to decide what to read.
- **Scale rule.** Revisit only if the corpus grows ~10× (roadmap §1
  non-goals) or the top-1 hit on a known-good query stops being right.

## 5. The knowledge pipeline's role in output quality

The guides are **generated from source, not hand-maintained**: `npm run kb`
(`src/kb/forge.ts`) assembles file tables, function signatures, message
tables from the registry, and curated facts (`src/kb/meta.ts`), and writes
the guides + a manifest with per-source content hashes. `kb:check` (in
`npm run verify`) fails when a source drifts from its guide — the KB cannot
silently go stale.

Two committed artifacts show the effect at the design level (not just the
eval level): `docs/designs/` holds a matched pair — `add-a-refund-message-
that-reverses-a-set-2026-10-12-kb.md` and its `-no-kb.md` sibling: the same
task, two agent sessions. The KB-grounded session cites the
settlement/forwarding rows from `auth_gateway.md` and places its assertions
on `RESERVE`; the schema-only session has to infer side effects from ack
fields alone.

## 6. What was tried and rejected

| Idea | Why rejected |
|---|---|
| Free-form agent-authored step JSON (no registry validation) | Invented messages then fail at *runtime* with a wire error, not at authoring with a steering error. Validation moves failure to the cheapest moment |
| LLM-judged scoring for the eval | Non-reproducible and unauditable. The eval scores programmatic ground truth (exact checklist from seed data) + an independent re-run (`src/eval/judge.ts`). No LLM anywhere in the scoring path |
| Vector retrieval | Flake risk + untestability at a 28 KB corpus (§4) |
| Letting the agent edit the registry / protocol | The registry is *generated from the compiled binaries* (`harness/scripts/gen_registry.js`); hand-edits would be overwritten and break the C↔TS contract |
| Extra agent "supervisor" loop | The runner's red→fix→re-run loop already gives the agent ground truth; a supervisor adds latency and opacity for no measured gain |

## 7. Model & prompt versioning

- The system prompt is code: `harness/src/eval/prompt.ts`
  (`SYSTEM_PROMPT` + `taskUserPrompt`). Changing it is a code change — it
  appears in the diff, the commit, and the history.
- Model, base URL, temperature, max tool steps, and runs/task are the
  experiment config, recorded verbatim in every report's `config` block
  (`src/eval/types.ts`), so any committed number is reproducible in one
  command (`docs/eval.md`).
- `EVAL_THINKING` (default off) controls Qwen-style reasoning tokens; the
  committed numbers are with thinking off. Two hosted-API quirks are
  auto-detected on the first 400 and retried, no extra env var needed:
  OpenAI rejects the Qwen template parameter (retried without it), and
  reasoning models like `gpt-6-luna` refuse function tools in
  `/chat/completions` unless `reasoning_effort: "none"` is set (retried with
  it). The latter means such models are evaluated with reasoning off in this
  endpoint — see `docs/eval.md` for the trade-off.
- Per-model regression baselines are committed data:
  `harness/src/eval/baseline.json` (roadmap R2 Layer B). A model swap is
  therefore a *measurable event*: run the eval, compare against that
  model's baseline, commit the new baseline with a source note.
