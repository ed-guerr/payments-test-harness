/**
 * eval/report.ts — summary math, JSON report, markdown table.
 *
 * The JSON report is the source of truth (full per-run traces included);
 * the markdown table is what the README quotes. Both are written to
 * artifacts/eval/ (gitignored except committed samples).
 */
import fs from "node:fs";
import path from "node:path";
import type { EvalConfig, EvalReport, FailureReason, TaskRunRecord, VariantSummary } from "./types";

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? 0;
  const lo = s[mid - 1];
  const hi = s[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : 0;
}

/** Nearest-rank percentile (deterministic; p in 0..1). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1));
  return s[idx] ?? 0;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * Wilson score 95% interval for a binomial proportion (k successes of n).
 * Unlike the normal approximation it stays inside [0,1] for small n and
 * extreme p — the small-run counts this eval produces.
 */
export function wilsonInterval95(k: number, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, round4(center - half)), high: Math.min(1, round4(center + half)) };
}

/** Why an attempt failed to pass; null for passing runs. */
export function classifyFailure(rec: TaskRunRecord): FailureReason | null {
  if (rec.pass) return null;
  if (rec.agentError) {
    if (rec.agentError.includes("timed out")) return "timeout";
    if (rec.agentError.includes("tool steps")) return "step-budget";
    return "agent-error";
  }
  if (!rec.suiteCreated) return "no-suite";
  if (rec.suiteGreen !== true) return "suite-red";
  return "checklist-missing";
}

function distInt(values: number[]): { min: number; p50: number; p95: number } {
  return { min: values.length ? Math.min(...values) : 0, p50: Math.round(median(values)), p95: Math.round(percentile(values, 0.95)) };
}

function distSec(values: number[]): { min: number; p50: number; p95: number } {
  const r = (x: number): number => Math.round(x * 10) / 10;
  return { min: r(values.length ? Math.min(...values) : 0), p50: r(median(values)), p95: r(percentile(values, 0.95)) };
}

function emptyFailures(): Record<FailureReason, number> {
  return { "agent-error": 0, timeout: 0, "step-budget": 0, "no-suite": 0, "suite-red": 0, "checklist-missing": 0 };
}

export function summarize(runs: TaskRunRecord[]): VariantSummary[] {
  const variants = [...new Set(runs.map((r) => r.variant))];
  return variants.map((variant) => {
    const vr = runs.filter((r) => r.variant === variant);
    const taskIds = [...new Set(vr.map((r) => r.taskId))];
    const passCount = vr.filter((r) => r.pass).length;
    const failures = emptyFailures();
    for (const r of vr) {
      // fall back to re-classification so pre-manifest reports still summarize
      const fr = r.failureReason ?? classifyFailure(r);
      if (fr) failures[fr]++;
    }
    const categoryNames = [...new Set(vr.flatMap((r) => r.categories))].sort();
    return {
      variant,
      runs: vr.length,
      pass: passCount,
      suiteGreen: vr.filter((r) => r.suiteGreen === true).length,
      checklistFull: vr.filter((r) => r.checklistFull).length,
      avgToolCalls: vr.length ? Math.round((vr.reduce((a, r) => a + r.toolCalls, 0) / vr.length) * 10) / 10 : 0,
      avgSuiteRuns: vr.length ? Math.round((vr.reduce((a, r) => a + r.suiteRuns, 0) / vr.length) * 10) / 10 : 0,
      p50WallS: Math.round(median(vr.map((r) => r.totalWallMs)) / 1000),
      tokensIn: vr.reduce((a, r) => a + r.tokensIn, 0),
      tokensOut: vr.reduce((a, r) => a + r.tokensOut, 0),
      avgTokensIn: vr.length ? Math.round(vr.reduce((a, r) => a + r.tokensIn, 0) / vr.length) : 0,
      avgTokensOut: vr.length ? Math.round(vr.reduce((a, r) => a + r.tokensOut, 0) / vr.length) : 0,
      // null when the model has no committed price (never a guess)
      costUsd: vr.some((r) => r.costUsd === null) ? null : Math.round(vr.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 10000) / 10000,
      avgCostUsd: vr.length && !vr.some((r) => r.costUsd === null)
        ? Math.round((vr.reduce((a, r) => a + (r.costUsd ?? 0), 0) / vr.length) * 1e6) / 1e6
        : null,
      perTask: taskIds.map((taskId) => {
        const tr = vr.filter((r) => r.taskId === taskId);
        return {
          taskId,
          kbSensitive: tr.some((r) => r.kbSensitive),
          categories: [...new Set(tr.flatMap((r) => r.categories))].sort(),
          pass: tr.filter((r) => r.pass).length,
          of: tr.length,
        };
      }),
      passCi95: wilsonInterval95(passCount, vr.length),
      distributions: {
        toolCalls: distInt(vr.map((r) => r.toolCalls)),
        suiteRuns: distInt(vr.map((r) => r.suiteRuns)),
        wallSec: distSec(vr.map((r) => r.totalWallMs / 1000)),
      },
      failures,
      perCategory: categoryNames.map((c) => {
        const cr = vr.filter((r) => r.categories.includes(c));
        return { category: c, pass: cr.filter((r) => r.pass).length, of: cr.length };
      }),
    };
  });
}

export function toMarkdown(report: EvalReport): string {
  const out: string[] = [];
  out.push(`# eval — ${report.config.model} @ ${report.config.apiBase}`);
  out.push("");
  out.push(`generated ${report.generatedAt} · ${report.config.runsPerTask} run(s)/task · ` +
    `temperature ${report.config.temperature} · seed ${report.config.seed ?? "unsupported/unset"} · max ${report.config.maxToolSteps} tool steps`);
  out.push("");
  out.push("| config | pass | 95% CI (pass) | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | avg tokens in/out (per run) | avg cost (usd/run) | total tokens in/out | total cost (usd) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.summary) {
    const ci = s.passCi95 ? `${Math.round(s.passCi95.low * 100)}–${Math.round(s.passCi95.high * 100)}%` : "n/a";
    out.push(
      `| ${s.variant} | ${s.pass}/${s.runs} | ${ci} | ${s.suiteGreen}/${s.runs} | ${s.checklistFull}/${s.runs} | ` +
        `${s.avgToolCalls} | ${s.avgSuiteRuns} | ${s.p50WallS} | ${s.avgTokensIn} / ${s.avgTokensOut} | ` +
        `${s.avgCostUsd === null ? "n/a" : s.avgCostUsd.toFixed(4)} | ${s.tokensIn} / ${s.tokensOut} | ` +
        `${s.costUsd === null ? "n/a" : s.costUsd.toFixed(4)} |`,
    );
  }
  for (const s of report.summary) {
    out.push("");
    out.push(`## per-task — ${s.variant}`);
    out.push("");
    out.push("| task | kb-sensitive | categories | pass | tool calls | wall (s) |");
    out.push("|---|---|---|---|---|---|");
    const rows = s.perTask;
    for (const row of rows) {
      const tr = report.runs.filter((r) => r.variant === s.variant && r.taskId === row.taskId);
      const avgCalls = tr.length ? Math.round((tr.reduce((a, r) => a + r.toolCalls, 0) / tr.length) * 10) / 10 : 0;
      const wall = Math.round(median(tr.map((r) => r.totalWallMs)) / 1000);
      out.push(`| ${escapeMarkdownCell(row.taskId)} | ${row.kbSensitive ? "yes" : ""} | ${escapeMarkdownCell(row.categories.join(", "))} | ${row.pass}/${row.of} | ${avgCalls} | ${wall} |`);
    }
    out.push("");
    if (s.perCategory.length > 0) {
      out.push(`## per-category — ${s.variant}`);
      out.push("");
      out.push("| category | pass | of |");
      out.push("|---|---|---|");
      for (const row of s.perCategory) {
        out.push(`| ${escapeMarkdownCell(row.category)} | ${row.pass}/${row.of} |`);
      }
      out.push("");
      out.push("_a run tagged with several categories counts in each row_");
    }
    out.push("");
    out.push(`**distributions (all attempts, min/p50/p95):** tool calls ` +
      `${s.distributions.toolCalls.min}/${s.distributions.toolCalls.p50}/${s.distributions.toolCalls.p95} · ` +
      `suite runs ${s.distributions.suiteRuns.min}/${s.distributions.suiteRuns.p50}/${s.distributions.suiteRuns.p95} · ` +
      `wall (s) ${s.distributions.wallSec.min}/${s.distributions.wallSec.p50}/${s.distributions.wallSec.p95}`);
    out.push("");
    const failedParts = (Object.entries(s.failures) as [FailureReason, number][])
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${reason} ${n}`);
    out.push(`**failures by cause:** ${failedParts.length === 0 ? "none — all attempts passed" : failedParts.join(" · ")}`);
  }
  if (report.manifest) {
    out.push("");
    out.push("## experiment manifest");
    out.push("");
    const m = report.manifest;
    out.push(`- started ${m.startedAt}`);
    out.push(`- run order: ${escapeMarkdownCell(m.runOrder)}`);
    for (const t of m.toolSurface) {
      out.push(`- tool surface ${t.variant}: ${t.tools} tools, sha256:${t.hash}`);
    }
    out.push(`- config sha256:${m.configHash}`);
    out.push(`- system prompt sha256:${m.systemPromptHash}`);
    out.push(`- task set sha256:${m.taskSetHash}`);
    out.push(`- KB manifest sha256:${m.kbManifestHash} · registry sha256:${m.registryHash}`);
    out.push(`- repo ${m.repoRevision} · reasoning ${m.reasoning}`);
  }
  out.push("");
  out.push("## Interpretation limits");
  out.push("");
  out.push("- Results describe this task set, prompt, tool surface, backend, model build, and endpoint; they do not establish a general effect across production systems.");
  out.push("- KB-on versus KB-off changes tool availability. The `kb-content-off` condition retains those tool names but returns empty results; it is a closer content ablation, though empty results still differ from real retrieval.");
  out.push("- Pass rates are descriptive. With small run counts, inspect per-task outcomes and repeat runs before drawing causal conclusions.");
  out.push("- The 95% CI is a Wilson interval: uncertainty over repeated runs of THIS fixed setup (task set, prompts, backend, endpoint), not an estimate of general performance on other systems.");
  if (report.gate) {
    out.push("");
    out.push("## regression gate");
    out.push("");
    for (const s of report.summary) {
      const mp = report.gate.minPass[s.variant];
      out.push(`- ${s.variant}: ${mp === undefined ? "no baseline (not gated)" : `min pass ${mp}`} — got ${s.pass}/${s.runs}`);
    }
    for (const m of report.gate.skipped) out.push(`- skipped: ${m}`);
    for (const m of report.gate.failed) out.push(`- **FAIL**: ${m}`);
    if (report.gate.failed.length === 0 && Object.keys(report.gate.minPass).length > 0) {
      out.push("- PASS: no regressions vs baseline");
    }
  }
  out.push("");
  out.push("pass = agent created the suite AND it runs green (independent re-run) AND the full ground-truth checklist is satisfied.");
  return out.join("\n") + "\n";
}

export function writeReport(report: EvalReport, outDir: string): { json: string; md: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `${stamp}-${report.config.model.replace(/[^a-z0-9]/gi, "-").slice(0, 24)}`;
  const json = path.join(outDir, `${base}.json`);
  const md = path.join(outDir, `${base}.md`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(md, toMarkdown(report));
  return { json, md };
}

export function configOf(report: EvalReport): EvalConfig {
  return report.config;
}
