/**
 * eval/types.ts — shared types for the test-authoring eval.
 *
 * The eval answers one question: given a plain-English task, how well does an
 * LLM agent author a correct, deep-asserting test suite through the harness
 * MCP tools — with the knowledge base available vs. schema-only?
 *
 * Success is objective and programmatic (no LLM judge):
 *   pass = the agent created a suite AND it runs green AND the full
 *          ground-truth checklist is satisfied.
 */

/** Experiment conditions: KB on, tool-preserving content ablation, or schema-only. */
export type Variant = "kb-on" | "kb-off" | "kb-content-off";

/**
 * Ground-truth checks, evaluated structurally against the generated suite
 * JSON. All values are exact (seed data is fixed), so a check is either
 * satisfied or it isn't — no thresholds, no judgment.
 */
export type Check =
  /** At least minCount send steps use this message name. */
  | { kind: "usesMessage"; name: string; minCount?: number }
  /** A send step (optionally for a specific message) has expectError: true. */
  | { kind: "hasExpectError"; message?: string }
  /** A killProcess step targets this process. */
  | { kind: "killsProcess"; proc: string }
  /**
   * A send step (optionally for a specific message) pins expectAck[field]
   * to exactly value.
   */
  | { kind: "expectsAckField"; message?: string; field: string; value: string | number | null }
  /**
   * A dbAssert step queries this table (word-boundary match on the SQL) and
   * pins every column in `expect` to the given value in its row match.
   */
  | { kind: "assertsRow"; table: string; expect: Record<string, string | number | null> };

export interface CheckResult {
  check: Check;
  ok: boolean;
  detail: string;
}

/** One eval task: a plain-English prompt + exact ground truth. */
export interface EvalTask {
  id: string;
  prompt: string;
  /** The suite name the agent must use (enforced in the user prompt). */
  suiteName: string;
  /** True when the task discriminates KB-grounded from schema-only authoring. */
  kbSensitive?: boolean;
  /** Optional tags for stratified reporting (e.g. lifecycle, negative, chaos). */
  categories?: string[];
  checks: Check[];
}

/** One recorded tool call (result text truncated for report size). */
export interface ToolCallRecord {
  step: number;
  name: string;
  args: unknown;
  ok: boolean;
  text: string;
  durationMs: number;
}

/**
 * Why an attempt failed to pass (null when pass === true). Every attempt
 * stays in the report denominator regardless of which of these hit.
 */
export type FailureReason =
  /** agent loop itself failed (API error, malformed tool call, ...) */
  | "agent-error"
  /** the per-run wall-clock timeout fired */
  | "timeout"
  /** the agent exhausted maxToolSteps without a final answer */
  | "step-budget"
  /** the agent finished but never created a suite */
  | "no-suite"
  /** the independent re-run of the generated suite was red */
  | "suite-red"
  /** suite green but the ground-truth checklist is incomplete */
  | "checklist-missing";

/** One agent attempt at one task (one cell of the experiment). */
export interface TaskRunRecord {
  taskId: string;
  variant: Variant;
  run: number;
  model: string;
  kbSensitive: boolean;
  /** Task tags copied from EvalTask for stratified summaries. */
  categories: string[];
  /** agent loop wall time (chat + tool round trips) */
  agentWallMs: number;
  /** agent loop + independent suite re-run */
  totalWallMs: number;
  toolCalls: number;
  distinctTools: string[];
  /** how many times the agent ran the suite itself (1 = one-shot; >1 = iterated) */
  suiteRuns: number;
  tokensIn: number;
  tokensOut: number;
  /** USD for this run per pricing.ts; null = model not in the price table */
  costUsd: number | null;
  finalText: string;
  /** set when the agent loop itself failed (API error, timeout, max steps) */
  agentError: string | null;
  /** the generated suite file existed after the agent finished */
  suiteCreated: boolean;
  /** independent re-run of the generated suite: green / not green / not run */
  suiteGreen: boolean | null;
  suiteSteps: number | null;
  suiteDurationMs: number | null;
  checks: CheckResult[];
  checklistFull: boolean;
  /** the score: suite created + runs green + full checklist */
  pass: boolean;
  /** Why this attempt did not pass; null for passing runs. */
  failureReason: FailureReason | null;
  trace: ToolCallRecord[];
}

export interface VariantSummary {
  variant: Variant;
  runs: number;
  pass: number;
  suiteGreen: number;
  checklistFull: number;
  avgToolCalls: number;
  avgSuiteRuns: number;
  p50WallS: number;
  tokensIn: number;
  tokensOut: number;
  /** per-run averages of tokensIn / tokensOut */
  avgTokensIn: number;
  avgTokensOut: number;
  /** sum of per-run costUsd; null when the model has no committed price */
  costUsd: number | null;
  /** per-run average cost; null when the model has no committed price */
  avgCostUsd: number | null;
  perTask: { taskId: string; kbSensitive: boolean; categories: string[]; pass: number; of: number }[];
  /** Wilson 95% interval for pass/runs; null when there are no runs. */
  passCi95: { low: number; high: number } | null;
  /** min/p50/p95 across ALL attempts (failed attempts included). */
  distributions: {
    toolCalls: { min: number; p50: number; p95: number };
    suiteRuns: { min: number; p50: number; p95: number };
    wallSec: { min: number; p50: number; p95: number };
  };
  /** Failed attempts by cause; pass + sum(failures) === runs. */
  failures: Record<FailureReason, number>;
  /** Per-category pass counts; a run tagged with several categories counts in each row. */
  perCategory: { category: string; pass: number; of: number }[];
}

export interface EvalConfig {
  model: string;
  apiBase: string;
  temperature: number;
  maxToolSteps: number;
  /** Seed passed to compatible chat-completion endpoints, if configured. */
  seed: number | null;
  runsPerTask: number;
  variants: Variant[];
  taskIds: string[];
  outDir: string;
  runTimeoutMs: number;
  /** Per-request timeout for /chat/completions (ms). */
  chatTimeoutMs: number;
  /** Retries for fetch-level failures (network stall/timeout). */
  chatRetries: number;
}

/**
 * Enough identity to know exactly what a report's runs were: the config,
 * the prompts, the task set, the model-visible tool surface per condition,
 * and the KB/registry/repo revisions. Hashes are sha256 over stable
 * (key-sorted) JSON — compare two manifests to see what changed between runs.
 */
export interface ExperimentManifest {
  startedAt: string;
  /** How conditions/tasks/runs were sequenced. */
  runOrder: string;
  /** sha256 of the normalized EvalConfig. */
  configHash: string;
  /** sha256 of the agent system prompt. */
  systemPromptHash: string;
  /** sha256 of the selected tasks (id, prompt, suiteName, tags, checks). */
  taskSetHash: string;
  /** Model-visible tool surface per condition (content-off rewrites included). */
  toolSurface: { variant: Variant; tools: number; hash: string }[];
  /** sha256 of knowledge/.manifest.json (KB content identity). */
  kbManifestHash: string;
  /** sha256 of the wire-protocol registry suites are validated against. */
  registryHash: string;
  /** git HEAD at run start, or "not-a-git-checkout". */
  repoRevision: string;
  /** Qwen-style reasoning tokens (EVAL_THINKING): on/off. */
  reasoning: string;
}

export interface EvalReport {
  generatedAt: string;
  config: EvalConfig;
  runs: TaskRunRecord[];
  summary: VariantSummary[];
  /** Experiment identity; present in reports produced after 2026-10-14. */
  manifest?: ExperimentManifest;
  /** Regression gate (roadmap R2 Layer B): per-variant min pass for this model
   *  (committed baseline, or --min-pass override); failed lists violations,
   *  skipped lists variants where the baseline wasn't comparable. */
  gate?: {
    minPass: Partial<Record<Variant, number>>;
    failed: string[];
    skipped: string[];
  };
  /** True for committed sample reports (trimmed + scrubbed derivatives of a
   *  full-fidelity report; the full report stays gitignored). */
  sample?: boolean;
  /** Provenance for committed samples: what was trimmed/scrubbed and which
   *  full-fidelity report(s) it was derived from. */
  sampleNote?: string;
}
