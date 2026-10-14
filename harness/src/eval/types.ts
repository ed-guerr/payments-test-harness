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

/** A variant of the experiment: KB tools available, or schema-only. */
export type Variant = "kb-on" | "kb-off";

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

/** One agent attempt at one task (one cell of the experiment). */
export interface TaskRunRecord {
  taskId: string;
  variant: Variant;
  run: number;
  model: string;
  kbSensitive: boolean;
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
  perTask: { taskId: string; kbSensitive: boolean; pass: number; of: number }[];
}

export interface EvalConfig {
  model: string;
  apiBase: string;
  temperature: number;
  maxToolSteps: number;
  runsPerTask: number;
  variants: Variant[];
  taskIds: string[];
  outDir: string;
  runTimeoutMs: number;
}

export interface EvalReport {
  generatedAt: string;
  config: EvalConfig;
  runs: TaskRunRecord[];
  summary: VariantSummary[];
  /** Regression gate (roadmap R2 Layer B): per-variant min pass for this model
   *  (committed baseline, or --min-pass override); failed lists violations,
   *  skipped lists variants where the baseline wasn't comparable. */
  gate?: {
    minPass: Partial<Record<Variant, number>>;
    failed: string[];
    skipped: string[];
  };
}
