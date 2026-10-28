/**
 * Per-run trace report (roadmap Phase D, §3): renders one eval run's
 * recorded tool trace + outcome fields into a human-readable Markdown
 * report. Pure rendering — no I/O, no model, no backend — so the whole
 * surface is testable on synthetic traces.
 *
 * Design notes:
 * - `create_suite`/`update_suite` trace args carry the FULL suite object
 *   (name/description/steps), so suite revision history and diffs are
 *   reconstructed from the trace itself.
 * - `run_suite` tool results are JSON text (ok/passed/failed/steps with
 *   per-step detail); the tool call is "ok" even when the suite is red,
 *   so red runs are detected by parsing the result text. Result text is
 *   truncated at TRUNCATED_AT chars at record time (see agent.ts).
 * - Redaction is applied to the finished document: configured secret
 *   values are replaced with [REDACTED], plus always-on pattern matches for
 *   `Bearer <token>`, URL user:pass credentials, and RFC1918 (LAN)
 *   endpoints, plus always-on value redaction of the home dir, the repo
 *   root, and model ids that are filesystem paths (the single-model
 *   llama.cpp server reports the GGUF path).
 */
import { homedir } from "node:os";
import type { Check, EvalConfig, TaskRunRecord, ToolCallRecord } from "./types";

/** Must match MAX_RECORD_TEXT in agent.ts (tool-result text truncation). */
export const TRUNCATED_AT = 2000;

export interface TraceReportOptions {
  /** Secret values to scrub from the rendered document. */
  redact?: string[];
  /** Optional label for the source report (e.g. file name). */
  source?: string;
  /** Max chars of a single inline preview in the timeline table. */
  previewLen?: number;
  /** Home dir to redact from the document (default: os.homedir()). */
  homeDir?: string;
  /** Repo root to redact from the document (default: none). */
  repoRoot?: string;
}

// ---------------------------------------------------------------- redaction

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const URL_CREDS_RE = /(:\/\/)[^@/\s:]+:[^@/\s]+(@)/g;

/** Full RFC1918 address (the 10/8, 192.168/16, and 172.16/12 blocks). */
const RFC1918_IP =
  "10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" +
  "|192\\.168\\.\\d{1,3}\\.\\d{1,3}" +
  "|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}";
const URL_LAN_HOST_RE = new RegExp(`((?:https?|wss?)://)(?:${RFC1918_IP})(:\\d+)?`, "g");
const LAN_IP_RE = new RegExp(`\\b(?:${RFC1918_IP})\\b`, "g");

/** Exact-value scrubbing only for secrets this long (shorter values risk false hits). */
export const MIN_SECRET_LEN = 6;

/**
 * Replace configured secrets (longest first) and pattern-match credentials
 * and RFC1918 (LAN) endpoints — the LAN patterns always apply, not only
 * for configured secrets.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].filter((s) => s.length >= MIN_SECRET_LEN).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("[REDACTED]");
  }
  out = out.replace(BEARER_RE, "Bearer [REDACTED]");
  out = out.replace(URL_CREDS_RE, "$1[REDACTED]$2");
  out = out.replace(URL_LAN_HOST_RE, "$1<lan-host>$2");
  out = out.replace(LAN_IP_RE, "<lan-ip>");
  return out;
}

/**
 * Display label for a model id: a filesystem path (the single-model
 * llama.cpp server reports the GGUF path) is reduced to its basename so
 * rendered reports never carry local disk layout.
 */
export function modelLabel(model: string): string {
  return model.includes("/") ? (model.split("/").pop() as string) : model;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Value-level personal redaction: the home dir, the repo root, and model
 * ids that are filesystem paths. Applied longest first (so the repo root
 * wins over the home dir) and only where the value is a path unit — the
 * next character must not extend a path name — so a home dir never matches
 * inside a longer sibling path (a different username sharing a prefix),
 * but does match at end of line or before punctuation like a closing
 * backtick.
 */
export function redactPersonal(
  text: string,
  values: { homeDir?: string; repoRoot?: string; modelId?: string },
): string {
  const subs: Array<[string, string]> = [];
  if (values.repoRoot) subs.push([values.repoRoot, "<repo>"]);
  if (values.homeDir) subs.push([values.homeDir, "<home>"]);
  const m = values.modelId;
  if (m && m.includes("/")) subs.push([m, modelLabel(m)]);
  subs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [value, repl] of subs) {
    out = out.replace(new RegExp(escapeRe(value) + "(?![A-Za-z0-9._-])", "g"), repl);
  }
  return out;
}

// -------------------------------------------------------------- suite diff

export interface SuiteDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  from?: unknown;
  to?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

/** Field-level diff between two suite objects (added/removed/changed paths). */
export function diffSuites(a: unknown, b: unknown, cap = 50): SuiteDiffEntry[] {
  const out: SuiteDiffEntry[] = [];
  const push = (e: SuiteDiffEntry) => {
    if (out.length < cap) out.push(e);
  };
  const walk = (x: unknown, y: unknown, path: string) => {
    if (out.length >= cap) return;
    if (sameValue(x, y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const p = `${path}[${i}]`;
        if (i >= y.length) push({ path: p, kind: "removed", from: x[i] });
        else if (i >= x.length) push({ path: p, kind: "added", to: y[i] });
        else walk(x[i], y[i], p);
      }
      return;
    }
    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in y)) push({ path: p, kind: "removed", from: x[k] });
        else if (!(k in x)) push({ path: p, kind: "added", to: y[k] });
        else walk(x[k], y[k], p);
      }
      return;
    }
    push({ path: path || "(root)", kind: "changed", from: x, to: y });
  };
  walk(a, b, "");
  return out;
}

// ---------------------------------------------------------- trace helpers

const PHASES: Record<string, string> = {
  db_schema: "discovery",
  db_query: "discovery",
  list_messages: "discovery",
  list_processes: "discovery",
  get_message_schema: "discovery",
  list_suites: "discovery",
  get_suite: "discovery",
  kb_search: "kb-lookup",
  kb_read: "kb-lookup",
  create_suite: "authoring",
  update_suite: "authoring",
  run_suite: "executing",
  get_run_results: "executing",
};

export function phaseOf(toolName: string): string {
  return PHASES[toolName] ?? "other";
}

interface SuiteStepResult {
  stepId: string;
  ok: boolean;
  detail: string;
  received?: unknown;
}

export interface SuiteRunResult {
  ok: boolean;
  passed: number;
  failed: number;
  durationMs: number;
  steps: SuiteStepResult[];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Parse a `run_suite` tool-result text; null when not a suite result (incl. truncated JSON). */
export function parseSuiteRunText(text: string): SuiteRunResult | null {
  const v = safeParse(text) as Record<string, unknown> | null;
  if (!isPlainObject(v) || typeof v.ok !== "boolean" || typeof v.passed !== "number") return null;
  const stepsRaw = (v.steps as Record<string, unknown> | undefined)?.steps;
  const steps: SuiteStepResult[] = Array.isArray(stepsRaw)
    ? (stepsRaw as Record<string, unknown>[])
        .filter((s) => isPlainObject(s) && typeof s.stepId === "string")
        .map((s) => ({
          stepId: s.stepId as string,
          ok: s.ok === true,
          detail: typeof s.detail === "string" ? s.detail : "",
          received: s.received,
        }))
    : [];
  return { ok: v.ok, passed: v.passed, failed: (v.failed as number) ?? 0, durationMs: (v.durationMs as number) ?? 0, steps };
}

/** The suite object as recorded in create_suite/update_suite args (null if absent). */
export function suiteFromArgs(args: unknown): Record<string, unknown> | null {
  if (!isPlainObject(args) || !Array.isArray(args.steps)) return null;
  const out: Record<string, unknown> = { name: args.name };
  if (typeof args.description === "string") out.description = args.description;
  out.steps = args.steps;
  return out;
}

// ------------------------------------------------------------- markdown

function escInline(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\|/g, "\\|").replace(/\r?\n/g, " ⏎ ");
}

function preview(s: string, len: number): string {
  const oneLine = s.replace(/\r?\n/g, " ⏎ ").trim();
  return oneLine.length > len ? oneLine.slice(0, len - 1) + "…" : oneLine;
}

function codeBlock(s: string): string {
  const fence = "```";
  const safe = s.includes(fence) ? "~~~~" : fence;
  return `${safe}json\n${s}\n${safe}`;
}

function jsonPretty(v: unknown): string {
  return JSON.stringify(v, null, 2) ?? String(v);
}

/** Human label for a check (the Check union has no common name field). */
export function checkLabel(c: Check): string {
  switch (c.kind) {
    case "usesMessage":
      return `usesMessage ${c.name}`;
    case "hasExpectError":
      return c.message ? `hasExpectError (${c.message})` : "hasExpectError";
    case "killsProcess":
      return `killsProcess ${c.proc}`;
    case "expectsAckField":
      return c.message ? `expectsAckField ${c.message}.${c.field}` : `expectsAckField ${c.field}`;
    case "assertsRow":
      return `assertsRow ${c.table}`;
  }
}

// ---------------------------------------------------------------- render

export function renderTraceReport(
  config: EvalConfig,
  run: TaskRunRecord,
  opts: TraceReportOptions = {},
): string {
  const previewLen = opts.previewLen ?? 70;
  const out: string[] = [];
  const personalValues = {
    homeDir: opts.homeDir ?? homedir(),
    repoRoot: opts.repoRoot,
    modelId: run.model,
  };
  // Scrub recorded tool text before rendering, not just in the finished
  // document: the renderer truncates strings to 70-char previews (and the
  // final message to 1500 chars), and a path cut mid-string no longer
  // matches its full value at the document level. The final pass below
  // stays as the second net for everything else.
  const scrub = (s: string): string => redact(redactPersonal(s, personalValues), opts.redact ?? []);

  // ---- header
  out.push(`# Trace report — \`${run.taskId}\` · ${run.variant} · run ${run.run}`, "");
  const src = opts.source ? `Source: \`${opts.source}\`. ` : "";
  out.push(
    `${src}Config: model \`${run.model}\` @ \`${config.apiBase}\`, temp ${config.temperature}` +
      `, seed ${config.seed ?? "unset"}, max steps ${config.maxToolSteps}, ` +
      `${config.runsPerTask} run(s)/task, variants ${config.variants.join(", ")}.`,
    "",
  );

  // ---- summary
  out.push("## Summary", "");
  const outcome = run.pass
    ? "PASS"
    : `FAIL (${run.failureReason ?? "unknown"})${run.agentError ? ` — agent error: ${run.agentError}` : ""}`;
  const rerun =
    run.suiteGreen === true
      ? `green (${run.suiteSteps ?? "?"} step${(run.suiteSteps ?? 0) === 1 ? "" : "s"}, ${(run.suiteDurationMs ?? 0) / 1000}s)`
      : run.suiteGreen === false
        ? "not green"
        : "not run";
  const kb = run.kbSensitive ? " (KB-sensitive)" : "";
  out.push(
    "| | |",
    "|---|---|",
    `| Task | \`${run.taskId}\`${kb}${run.categories.length ? ` — ${run.categories.join(", ")}` : ""} |`,
    `| Condition | ${run.variant} |`,
    `| Outcome | ${escInline(outcome)} |`,
    `| Checklist | ${run.checks.filter((c) => c.ok).length}/${run.checks.length}${run.checklistFull ? " (full)" : ""} |`,
    `| Suite created | ${run.suiteCreated ? "yes" : "no"} |`,
    `| Independent rerun | ${rerun} |`,
    `| Agent suite runs | ${run.suiteRuns} |`,
    `| Tool calls | ${run.toolCalls} (${run.distinctTools.length} distinct) |`,
    `| Wall | agent ${run.agentWallMs / 1000}s, total ${run.totalWallMs / 1000}s |`,
    `| Tokens | ${run.tokensIn.toLocaleString()} in / ${run.tokensOut.toLocaleString()} out${run.costUsd !== null ? ` — $${run.costUsd}` : ""} |`,
    "",
  );

  // ---- timeline
  out.push("## Tool timeline", "");
  if (run.trace.length === 0) {
    out.push("_No tool calls recorded._", "");
  } else {
    out.push("| # | phase | tool | args | result | ms |", "|---|---|---|---|---|---|");
    for (const t of run.trace) {
      out.push(timelineRow(t, previewLen, scrub));
    }
    out.push("");
  }

  // ---- suite revisions
  const revisions = run.trace
    .filter((t) => t.name === "create_suite" || t.name === "update_suite")
    .map((t) => ({ step: t.step, tool: t.name, suite: suiteFromArgs(t.args) }));
  out.push("## Suite revisions", "");
  if (revisions.length === 0) {
    out.push("_No suite was created in this run._", "");
  } else {
    for (let i = 0; i < revisions.length; i++) {
      const r = revisions[i]!;
      if (r.suite === null) {
        out.push(`### revision ${i + 1} — ${r.tool} (step ${r.step})`, "",
          "_Suite content not reconstructible: the recorded args did not include `steps`._", "");
        continue;
      }
      out.push(`### revision ${i + 1} — ${r.tool} (step ${r.step}) — \`${String(r.suite.name)}\``, "");
      out.push(codeBlock(jsonPretty(r.suite)), "");
      if (i > 0 && revisions[i - 1]!.suite !== null) {
        const diff = diffSuites(revisions[i - 1]!.suite, r.suite);
        out.push(`Diff revision ${i} → ${i + 1}:`, "");
        if (diff.length === 0) out.push("_no field-level changes detected_");
        for (const d of diff) {
          const val =
            d.kind === "added" ? `+ ${short(d.to)}` :
            d.kind === "removed" ? `− ${short(d.from)}` :
            `~ ${short(d.from)} → ${short(d.to)}`;
          out.push(`- \`${d.path}\`: ${escInline(val)}`);
        }
        if (diff.length >= 50) out.push("- _…(diff capped at 50 entries)_");
        out.push("");
      }
    }
  }

  // ---- red suite runs
  const redRuns: { step: number; result: SuiteRunResult }[] = [];
  for (const t of run.trace) {
    if (t.name !== "run_suite") continue;
    const parsed = parseSuiteRunText(scrub(t.text));
    if (parsed && !parsed.ok) redRuns.push({ step: t.step, result: parsed });
  }
  if (redRuns.length > 0) {
    out.push("## Red suite runs (agent-observed failures)", "");
    for (const { step, result } of redRuns) {
      out.push(`### red run at step ${step} — ${result.passed}/${result.passed + result.failed} steps passed`);
      out.push("");
      const failed = result.steps.filter((s) => !s.ok);
      for (const s of failed.length > 0 ? failed : result.steps) {
        out.push(`- \`${s.stepId}\`: ${escInline(s.detail || "(no detail)")}`);
        if (s.received !== undefined) out.push("", codeBlock(jsonPretty(s.received)));
      }
      out.push("");
    }
  } else if (revisions.length > 0) {
    out.push("## Red suite runs (agent-observed failures)", "", "_none — every agent suite run was green._", "");
  }

  // ---- checklist
  out.push("## Checklist", "");
  if (run.checks.length === 0) {
    out.push("_No checklist checks recorded._", "");
  } else {
    for (const c of run.checks) {
      out.push(`- [${c.ok ? "x" : " "}] \`${checkLabel(c.check)}\` — ${escInline(c.detail)}`);
    }
    out.push("");
  }

  // ---- final message
  out.push("## Agent final message", "");
  if (run.finalText) {
    const ft = scrub(run.finalText);
    out.push(codeBlock(ft.length > 1500 ? ft.slice(0, 1500) + "\n…(truncated)" : ft), "");
  } else {
    out.push("_empty_", "");
  }

  // ---- redaction note
  const nSecrets = (opts.redact ?? []).filter((s) => s.length >= MIN_SECRET_LEN).length;
  out.push("---", "",
    `Redaction: ${nSecrets} secret value(s) configured for scrubbing; \`Bearer\` tokens, URL credentials, ` +
    `RFC1918 endpoints, and personal home/repo paths are always redacted. ` +
    `Tool-result text in the source trace is truncated at ${TRUNCATED_AT} chars (full text was sent to the model).`);

  const doc = out.join("\n");
  return redact(redactPersonal(doc, personalValues), opts.redact ?? []);
}

function timelineRow(t: ToolCallRecord, previewLen: number, scrub: (s: string) => string): string {
  const text = scrub(t.text);
  const argsStr = scrub(JSON.stringify(t.args ?? null) ?? "null");
  let args: string;
  if (t.name === "create_suite" || t.name === "update_suite") {
    const s = suiteFromArgs(t.args);
    args = s ? `\`${String(s.name)}\`, ${(s.steps as unknown[]).length} steps` : escInline(preview(argsStr, previewLen));
  } else {
    args = escInline(preview(argsStr, previewLen));
  }

  let result: string;
  if (t.name === "run_suite") {
    const parsed = parseSuiteRunText(text);
    result = parsed
      ? parsed.ok
        ? `${parsed.passed}/${parsed.passed + parsed.failed} green`
        : `**${parsed.passed}/${parsed.passed + parsed.failed} — RED**`
      : escInline(preview(text, previewLen));
  } else if (t.ok) {
    result = escInline(preview(text, previewLen));
  } else {
    result = `**ERR**: ${escInline(preview(text, previewLen))}`;
  }

  const trunc = t.text.length >= TRUNCATED_AT ? " …(truncated)" : "";
  result += trunc;
  return `| ${t.step} | ${phaseOf(t.name)} | \`${t.name}\` | ${args} | ${result} | ${t.durationMs} |`;
}
