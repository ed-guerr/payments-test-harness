/**
 * Per-run trace report generator (Phase D, §3).
 *
 * Usage:
 *   npm run trace-report -- <eval-report.json> <taskId>/<variant>/<run> [--out FILE] [--key SECRET]...
 *   npm run trace-report -- <eval-report.json> --all --out-dir DIR [--key SECRET]...
 *
 * Renders one run (or every run) of a saved eval report to Markdown:
 * summary, phase timeline, suite revision history with diffs, red suite
 * runs with per-step detail, checklist, and the agent's final message.
 * Secrets (EVAL_API_KEY + --key values, Bearer tokens, URL credentials)
 * are redacted from the output. No model or backend is required.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MIN_SECRET_LEN, renderTraceReport } from "../src/eval/tracereport";
import type { EvalReport } from "../src/eval/types";

function fail(msg: string): never {
  console.error(`trace-report: ${msg}`);
  console.error("usage: npm run trace-report -- <report.json> <taskId>/<variant>/<run> [--out FILE] [--key SECRET]");
  console.error("       npm run trace-report -- <report.json> --all --out-dir DIR [--key SECRET]");
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") fail("missing <report.json>");

const positionals: string[] = [];
const flags: Record<string, string[]> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--all") flags.all = ["1"];
  else if (a === "--out" || a === "--key" || a === "--out-dir") {
    const v = argv[++i];
    if (v === undefined) fail(`missing value for ${a}`);
    (flags[a] ??= []).push(v);
  } else if (!a.startsWith("-")) positionals.push(a);
  else fail(`unknown flag ${a}`);
}

const reportPath = positionals[0]!;
let report: EvalReport;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8")) as EvalReport;
} catch (e) {
  fail(`cannot read report ${reportPath}: ${(e as Error).message}`);
}

const secrets = [process.env.EVAL_API_KEY, ...(flags["--key"] ?? [])].filter((s): s is string => !!s && s.length >= MIN_SECRET_LEN);
const source = basename(reportPath);

if (flags.all) {
  const dir = flags["--out-dir"]?.[0];
  if (!dir) fail("--all requires --out-dir");
  let n = 0;
  for (const run of report.runs) {
    const md = renderTraceReport(report.config, run, { source, redact: secrets });
    const outDir = join(dir, run.variant);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${run.taskId}-run${String(run.run).padStart(2, "0")}.md`);
    writeFileSync(file, md);
    n++;
  }
  console.log(`wrote ${n} trace reports under ${dir}`);
  process.exit(0);
}

const ref = positionals[1];
if (!ref) fail("missing run reference (taskId/variant/run) or --all");
const [taskId, variant, runIdx] = ref.split("/");
if (!taskId || !variant || !runIdx || !/^\d+$/.test(runIdx)) fail(`bad run reference "${ref}" — expected <taskId>/<variant>/<run>`);

const run = report.runs.find((r) => r.taskId === taskId && r.variant === variant && r.run === Number(runIdx));
if (!run) {
  const available = report.runs
    .filter((r) => r.taskId === taskId && r.variant === variant)
    .map((r) => `${taskId}/${variant}/${r.run}`);
  fail(`no run ${ref}. available: ${available.length ? available.join(", ") : `no runs for ${taskId}/${variant}`}`);
}

const md = renderTraceReport(report.config, run, { source, redact: secrets });
if (flags["--out"]?.[0]) {
  writeFileSync(flags["--out"][0]!, md);
  console.log(`wrote ${flags["--out"][0]}`);
} else {
  process.stdout.write(md + "\n");
}
