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
import type { EvalConfig, Variant } from "./types";

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
  const { json, md } = writeReport(report, config.outDir);
  console.log("\n" + toMarkdown(report));
  console.log(`[eval] report: ${json}\n[eval] table:  ${md}`);

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
  const minPass = f.minPass;
  if (minPass !== null) {
    const bad = report.summary.filter((s) => s.pass < minPass);
    if (bad.length > 0) {
      console.error(`[eval] FAIL: below --min-pass ${minPass}: ${bad.map((s) => `${s.variant}=${s.pass}`).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`[eval] gate: all variants >= ${f.minPass} — PASS`);
    }
  }
}

main().catch((e) => {
  console.error(`[eval] error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
