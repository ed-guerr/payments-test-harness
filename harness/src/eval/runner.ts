/**
 * eval/runner.ts — experiment orchestration.
 *
 * For each variant (kb-on / kb-content-off / kb-off):
 *   spawn ONE MCP server (MCP_NO_KB=1 flips the variant)
 *   for each task, for each run:
 *     1. agent loop (chat + MCP tools)
 *     2. judge the generated suite against the task's ground truth
 *     3. re-run the generated suite INDEPENDENTLY on a fresh cluster —
 *        the agent's own run_suite result is not trusted; the artifact is
 *     4. clean up the eval suite file + database
 *
 * The agent may run the suite itself via run_suite (that is the natural
 * workflow); the independent re-run is what scores it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { BackendCluster } from "../backend/cluster";
import { DATA_DIR, SUITES_DIR, backendBuildDir, packageRoot } from "../backend/paths";
import { loadSuite } from "../backend/suites";
import { Runner } from "../runner/runner";
import type { Suite } from "../runner/runner";
import { Agent } from "./agent";
import type { AgentConfig } from "./agent";
import { costUsd } from "./pricing";
import { SYSTEM_PROMPT, taskUserPrompt } from "./prompt";
import type { EvalConfig, EvalReport, EvalTask, TaskRunRecord, Variant } from "./types";
import { judgeSuite } from "./judge";
import { buildManifest, sha256Hex, stableJson } from "./manifest";
import { classifyFailure, summarize } from "./report";

const EVAL_REPORTS_DIR = (): string => path.join(packageRoot(), "..", "artifacts", "eval");

export interface EvalRuntime {
  config: EvalConfig;
  agentCfg: AgentConfig;
  tasks: EvalTask[];
}

async function spawnMcpServer(variant: Variant): Promise<Client> {
  const tsxCli = path.join(packageRoot(), "node_modules", "tsx", "dist", "cli.mjs");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // kbEnabled() treats anything !== "1" as enabled; set explicitly per variant.
  // Keep KB tools present for the content-only ablation, but make their
  // server-side responses empty; this retains a fixed MCP surface.
  env.MCP_NO_KB = variant === "kb-off" ? "1" : "0";
  // Content-only ablation keeps KB tools registered but makes their results empty.
  if (variant === "kb-content-off") env.MCP_KB_CONTENT_OFF = "1";
  else delete env.MCP_KB_CONTENT_OFF;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(packageRoot(), "src", "mcp", "server.ts")],
    cwd: packageRoot(),
    env,
  });
  const client = new Client({ name: "eval-agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`run timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Independent re-run of the generated suite on a fresh cluster + database. */
async function runSuiteFresh(suite: Suite): Promise<{ green: boolean; steps: number; durationMs: number }> {
  const cluster = await BackendCluster.start(backendBuildDir(), path.join(DATA_DIR(), `${suite.name}.db`));
  try {
    const runner = new Runner(cluster.conns, cluster.db, () => undefined, {
      runsDir: path.join(EVAL_REPORTS_DIR(), "runs"),
      reportsDir: "", // eval runs do not write HTML reports into artifacts/test-reports
      killProcess: (p, s) => cluster.kill(p, s),
    });
    const summary = await runner.runSuite(suite);
    return { green: summary.ok, steps: summary.passed + summary.failed, durationMs: summary.durationMs };
  } finally {
    await cluster.stop();
  }
}

function cleanupTaskArtifacts(taskSuiteName: string): void {
  fs.rmSync(path.join(SUITES_DIR(), `${taskSuiteName}.json`), { force: true });
  const dbFile = path.join(DATA_DIR(), `${taskSuiteName}.db`);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
}

async function runTask(
  rt: EvalRuntime,
  client: Client,
  task: EvalTask,
  variant: Variant,
  run: number,
): Promise<TaskRunRecord> {
  const t0 = Date.now();
  const rec: TaskRunRecord = {
    taskId: task.id,
    variant,
    run,
    model: rt.config.model,
    kbSensitive: Boolean(task.kbSensitive),
    categories: task.categories ?? [],
    agentWallMs: 0,
    totalWallMs: 0,
    toolCalls: 0,
    distinctTools: [],
    suiteRuns: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: null,
    finalText: "",
    agentError: null,
    suiteCreated: false,
    suiteGreen: null,
    suiteSteps: null,
    suiteDurationMs: null,
    checks: [],
    checklistFull: false,
    pass: false,
    failureReason: null,
    trace: [],
  };
  try {
    const agent = new Agent(rt.agentCfg, client, {
      kbAblation: variant === "kb-content-off" ? "content-only" : "enabled",
    });
    await agent.discoverTools();
    const pending = agent.run(SYSTEM_PROMPT, taskUserPrompt(task.prompt, task.suiteName));
    let ar;
    try {
      ar = await withTimeout(pending, rt.config.runTimeoutMs);
    } catch (e) {
      // Timeout: let the in-flight loop die before the next task reuses the client.
      await pending.catch(() => undefined);
      ar = {
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        finalText: "",
        wallMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    rec.agentWallMs = ar.wallMs;
    rec.toolCalls = ar.toolCalls.length;
    rec.distinctTools = [...new Set(ar.toolCalls.map((c) => c.name))];
    rec.suiteRuns = ar.toolCalls.filter((c) => c.name === "run_suite").length;
    rec.tokensIn = ar.tokensIn;
    rec.tokensOut = ar.tokensOut;
    rec.costUsd = costUsd(rt.config.model, ar.tokensIn, ar.tokensOut);
    rec.finalText = ar.finalText;
    rec.agentError = ar.error;
    rec.trace = ar.toolCalls;

    const suiteFile = path.join(SUITES_DIR(), `${task.suiteName}.json`);
    if (fs.existsSync(suiteFile)) {
      const suite = loadSuite(suiteFile); // also re-validates against the registry
      rec.suiteCreated = true;
      rec.checks = judgeSuite(task, suite);
      rec.checklistFull = rec.checks.every((c) => c.ok);
      const r = await runSuiteFresh(suite);
      rec.suiteGreen = r.green;
      rec.suiteSteps = r.steps;
      rec.suiteDurationMs = r.durationMs;
    }
    rec.pass = rec.suiteCreated && rec.checklistFull && rec.suiteGreen === true;
  } catch (e) {
    rec.agentError = e instanceof Error ? e.message : String(e);
    rec.pass = false;
  } finally {
    rec.totalWallMs = Date.now() - t0;
    cleanupTaskArtifacts(task.suiteName);
  }
  return rec;
}

export async function runEval(rt: EvalRuntime): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const runs: TaskRunRecord[] = [];
  const toolSurface: { variant: Variant; tools: number; hash: string }[] = [];
  for (const variant of rt.config.variants) {
    const client = await spawnMcpServer(variant);
    try {
      // Record the exact model-visible tool surface for this condition before
      // any run — content-off rewrites are included, so the hash captures what
      // the model actually saw, not just what the server registered.
      const probe = new Agent(rt.agentCfg, client, {
        kbAblation: variant === "kb-content-off" ? "content-only" : "enabled",
      });
      await probe.discoverTools();
      const surface = probe.toolSurface();
      toolSurface.push({ variant, tools: surface.length, hash: sha256Hex(stableJson(surface)) });
      for (const task of rt.tasks) {
        for (let run = 1; run <= rt.config.runsPerTask; run++) {
          const rec = await runTask(rt, client, task, variant, run);
          rec.failureReason = classifyFailure(rec);
          runs.push(rec);
          const wall = (rec.totalWallMs / 1000).toFixed(0);
          const checks = `${rec.checks.filter((c) => c.ok).length}/${rec.checks.length}`;
          console.log(
            `[eval] ${variant} ${task.id} #${run} -> ${rec.pass ? "PASS" : "FAIL"} ` +
              `(checklist ${checks}, suite ${rec.suiteGreen === null ? "n/a" : rec.suiteGreen ? "green" : "RED"}, ` +
              `${rec.toolCalls} tool calls, ${wall}s)${rec.agentError ? ` [agent: ${rec.agentError}]` : ""}`,
          );
        }
      }
    } finally {
      await client.close();
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    config: rt.config,
    runs,
    summary: summarize(runs),
    manifest: buildManifest(rt.config, rt.tasks, startedAt, toolSurface),
  };
}
