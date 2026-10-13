/**
 * eval/cli.ts — `npm run eval` / `npm run eval:smoke`.
 *
 * Config: env first, flags override.
 *   EVAL_API_BASE      OpenAI-compatible base URL (default http://127.0.0.1:8080/v1)
 *   EVAL_API_MODEL     model name (default "local")
 *   EVAL_API_KEY       optional (hosted providers)
 *   EVAL_TEMPERATURE   default 0
 *   EVAL_MAX_TOOL_STEPS default 25
 *   EVAL_RUN_TIMEOUT_MS default 900000 (15 min per agent run)
 *
 * Flags:
 *   --smoke                 3 tasks (incl. the KB-sensitive one) x 1 run, both variants
 *   --tasks a,b,c           task ids (see tasks.ts)
 *   --runs N                runs per task (default 3; smoke: 1)
 *   --variant on|off|both   which variant(s) (default both)
 *   --model M / --base URL / --key K
 *   --max-steps N           max tool steps per run
 *   --out DIR               report directory (default harness/eval-reports)
 *   --min-pass N            exit 1 if any variant's pass count < N (CI gate)
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { backendBuildDir, packageRoot } from "../backend/paths";
import * as codec from "../protocol/codec";
import { SMOKE_TASK_IDS, TASKS, taskById } from "./tasks";
import { runEval } from "./runner";
import type { EvalRuntime } from "./runner";
import { toMarkdown, writeReport } from "./report";
import type { EvalConfig, EvalReport, Variant } from "./types";

interface Flags {
  smoke: boolean;
  tasks: string[];
  runs: number;
  variant: Variant[];
  model: string;
  base: string;
  key: string;
  maxSteps: number;
  out: string;
  minPass: number | null;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    smoke: false,
    tasks: TASKS.map((t) => t.id),
    runs: 3,
    variant: ["kb-on", "kb-off"],
    model: process.env.EVAL_API_MODEL ?? "local",
    base: process.env.EVAL_API_BASE ?? "http://127.0.0.1:8080/v1",
    key: process.env.EVAL_API_KEY ?? "",
    maxSteps: Number(process.env.EVAL_MAX_TOOL_STEPS ?? 25),
    out: path.join(packageRoot(), "eval-reports"),
    minPass: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--smoke":
        f.smoke = true;
        break;
      case "--tasks":
        f.tasks = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--runs":
        f.runs = Number(next());
        break;
      case "--variant": {
        const v = next();
        if (v === "both") f.variant = ["kb-on", "kb-off"];
        else if (v === "on") f.variant = ["kb-on"];
        else if (v === "off") f.variant = ["kb-off"];
        else throw new Error(`--variant must be on|off|both (got ${v})`);
        break;
      }
      case "--model":
        f.model = next();
        break;
      case "--base":
        f.base = next();
        break;
      case "--key":
        f.key = next();
        break;
      case "--max-steps":
        f.maxSteps = Number(next());
        break;
      case "--out":
        f.out = path.resolve(next());
        break;
      case "--min-pass":
        f.minPass = Number(next());
        break;
      default:
        throw new Error(`unknown flag ${a} (see header of eval/cli.ts)`);
    }
  }
  if (f.smoke) {
    f.tasks = [...SMOKE_TASK_IDS];
    f.runs = 1;
  }
  for (const id of f.tasks) taskById(id); // validate eagerly
  if (!Number.isInteger(f.runs) || f.runs < 1) throw new Error(`--runs must be a positive integer (got ${f.runs})`);
  if (!Number.isInteger(f.maxSteps) || f.maxSteps < 1) throw new Error(`--max-steps must be a positive integer`);
  return f;
}

async function preflight(f: Flags): Promise<void> {
  const binDir = backendBuildDir();
  for (const proc of codec.listProcs()) {
    if (!fs.existsSync(path.join(binDir, proc))) {
      throw new Error(`missing backend binary ${path.join(binDir, proc)} — run \`make -C backend\` first`);
    }
  }
  const base = f.base.replace(/\/+$/, "");
  let models: unknown;
  try {
    const res = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(5000),
      ...(f.key ? { headers: { authorization: `Bearer ${f.key}` } } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = await res.json();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `no OpenAI-compatible server at ${base} (${why}).\n` +
        `Start one, e.g.:\n` +
        `  llama-server -m /path/to/model.gguf --port 8080   # then EVAL_API_MODEL=<its name>\n` +
        `or point EVAL_API_BASE/EVAL_API_KEY at a hosted provider.`,
    );
  }
  const list = (models as { data?: { id: string }[] })?.data ?? [];
  // Single-model llama.cpp servers list the GGUF path, not the alias — only
  // warn when the server actually offers multiple models.
  if (list.length > 1 && !list.some((m) => m.id === f.model)) {
    console.error(`[eval] warning: model "${f.model}" not in server's model list: ${list.map((m) => m.id).join(", ")}`);
  }
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  const config: EvalConfig = {
    model: f.model,
    apiBase: f.base,
    temperature: Number(process.env.EVAL_TEMPERATURE ?? 0),
    maxToolSteps: f.maxSteps,
    runsPerTask: f.runs,
    variants: f.variant,
    taskIds: f.tasks,
    outDir: f.out,
    runTimeoutMs: Number(process.env.EVAL_RUN_TIMEOUT_MS ?? 900000),
  };
  const tasks = f.tasks.map(taskById);
  console.log(
    `[eval] model=${config.model} base=${config.apiBase} tasks=${tasks.map((t) => t.id).join(",")} ` +
      `runs/task=${config.runsPerTask} variants=${config.variants.join("+")} maxSteps=${config.maxToolSteps}`,
  );
  await preflight(f);
  const rt: EvalRuntime = {
    config,
    agentCfg: {
      apiBase: f.base,
      model: f.model,
      apiKey: f.key,
      temperature: config.temperature,
      maxToolSteps: config.maxToolSteps,
    },
    tasks,
  };
  const report = await runEval(rt);

  // Repo hygiene: the eval must never leave the committed suites modified.
  // The agent is told to name its suite eval-*; if it still touched a
  // tracked suite, surface it (no auto-restore: user changes are sacred).
  try {
    const repoRoot = path.resolve(packageRoot(), "..");
    const dirty = execSync(`git -C ${JSON.stringify(repoRoot)} status --porcelain -- harness/suites/`, {
      encoding: "utf8",
    }).trim();
    if (dirty) console.error(`[eval] warning: git sees changes under harness/suites/ — inspect and restore:
${dirty}`);
  } catch {
    // not a git checkout / git unavailable — nothing to check
  }
  const gate = applyGate(report, resolveMinPass(config.model, f.minPass));
  const { json, md } = writeReport(report, config.outDir);
  console.log("\n" + toMarkdown(report));
  console.log(`[eval] report: ${json}\n[eval] table:  ${md}`);
  if (gate.failed.length > 0) {
    for (const m of gate.failed) console.error(`[eval] FAIL: ${m}`);
    process.exitCode = 1;
  } else if (Object.keys(gate.minPass).length > 0) {
    console.log(`[eval] gate: no regressions vs baseline (${gate.source})`);
  } else {
    console.log(`[eval] gate: no baseline for this model — recorded, not gated (${gate.source})`);
  }
}

/* ------------------------------------------------------------------ */
/* Regression gate (roadmap R2, Layer B)                               */
/* ------------------------------------------------------------------ */

interface BaselineEntry {
  pass: number;
  total: number;
}

interface BaselineFile {
  note?: string;
  models: Record<string, { source?: string; kb?: BaselineEntry; no_kb?: BaselineEntry }>;
}

const VARIANT_BASELINE_KEY: Record<Variant, "kb" | "no_kb"> = { "kb-on": "kb", "kb-off": "no_kb" };

/** Min pass per variant: --min-pass override wins; otherwise the committed
 *  baseline for this model (src/eval/baseline.json). */
export function resolveMinPass(
  model: string,
  override: number | null,
): { minPass: Partial<Record<Variant, number>>; totals: Partial<Record<Variant, number>>; source: string } {
  if (override !== null) {
    return { minPass: { "kb-on": override, "kb-off": override }, totals: {}, source: "--min-pass override" };
  }
  const file = path.join(packageRoot(), "src", "eval", "baseline.json");
  if (!fs.existsSync(file)) return { minPass: {}, totals: {}, source: "no baseline.json" };
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as BaselineFile;
  const entry = data.models[model];
  if (!entry) return { minPass: {}, totals: {}, source: `no baseline for model "${model}"` };
  const minPass: Partial<Record<Variant, number>> = {};
  const totals: Partial<Record<Variant, number>> = {};
  for (const v of ["kb-on", "kb-off"] as Variant[]) {
    const e = entry[VARIANT_BASELINE_KEY[v]];
    if (e) {
      minPass[v] = e.pass;
      totals[v] = e.total;
    }
  }
  return { minPass, totals, source: entry.source ?? `baseline for ${model}` };
}

/** Evaluate the gate and attach it to the report (mutates + returns).
 *  A variant is only gated when the baseline is comparable (same task
 *  count) — a smoke run (3 tasks) must not be judged against the full-11
 *  baseline. */
export function applyGate(
  report: EvalReport,
  r: { minPass: Partial<Record<Variant, number>>; totals: Partial<Record<Variant, number>>; source: string },
): NonNullable<EvalReport["gate"]> & { source: string } {
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const s of report.summary) {
    const mp = r.minPass[s.variant];
    if (mp === undefined) {
      skipped.push(`${s.variant}: no baseline`);
      continue;
    }
    const total = r.totals[s.variant];
    if (total !== undefined && total !== s.runs) {
      skipped.push(`${s.variant}: baseline covers ${total} runs, this run has ${s.runs} (different task set)`);
      continue;
    }
    if (s.pass < mp) failed.push(`${s.variant}: ${s.pass}/${s.runs} below baseline ${mp} (${r.source})`);
  }
  const gate: NonNullable<EvalReport["gate"]> & { source: string } = {
    minPass: r.minPass,
    failed,
    skipped,
    source: r.source,
  };
  report.gate = gate;
  return gate;
}

/* Standalone entry: npm run eval / eval:smoke (guarded so this module is
 * importable for tests without firing the whole experiment). */
if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  main().catch((e) => {
    console.error(`[eval] error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
