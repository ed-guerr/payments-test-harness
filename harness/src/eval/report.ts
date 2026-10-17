/**
 * eval/report.ts — summary math, JSON report, markdown table.
 *
 * The JSON report is the source of truth (full per-run traces included);
 * the markdown table is what the README quotes. Both are written to
 * harness/eval-reports/ (gitignored except committed samples).
 */
import fs from "node:fs";
import path from "node:path";
import type { EvalConfig, EvalReport, TaskRunRecord, VariantSummary } from "./types";

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

export function summarize(runs: TaskRunRecord[]): VariantSummary[] {
  const variants = [...new Set(runs.map((r) => r.variant))];
  return variants.map((variant) => {
    const vr = runs.filter((r) => r.variant === variant);
    const taskIds = [...new Set(vr.map((r) => r.taskId))];
    return {
      variant,
      runs: vr.length,
      pass: vr.filter((r) => r.pass).length,
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
  out.push("| config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | avg tokens in/out (per run) | avg cost (usd/run) | total tokens in/out | total cost (usd) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.summary) {
    out.push(
      `| ${s.variant} | ${s.pass}/${s.runs} | ${s.suiteGreen}/${s.runs} | ${s.checklistFull}/${s.runs} | ` +
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
  }
  out.push("");
  out.push("## Interpretation limits");
  out.push("");
  out.push("- Results describe this task set, prompt, tool surface, backend, model build, and endpoint; they do not establish a general effect across production systems.");
  out.push("- KB-on versus KB-off changes tool availability. The `kb-content-off` condition retains those tool names but returns empty results; it is a closer content ablation, though empty results still differ from real retrieval.");
  out.push("- Pass rates are descriptive. With small run counts, inspect per-task outcomes and repeat runs before drawing causal conclusions.");
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
