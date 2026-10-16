import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, summarize, toMarkdown, wilsonInterval95 } from "./report";
import type { EvalConfig, EvalReport, TaskRunRecord } from "./types";

const config: EvalConfig = {
  model: "test-model",
  apiBase: "http://localhost/v1",
  temperature: 0,
  maxToolSteps: 25,
  seed: 1234,
  runsPerTask: 2,
  variants: ["kb-on"],
  taskIds: ["task-a"],
  outDir: "/tmp/eval-report-test",
  runTimeoutMs: 1000,
};

function run(run: number, pass: boolean): TaskRunRecord {
  return {
    taskId: "task-a",
    variant: "kb-on",
    run,
    model: "test-model",
    kbSensitive: true,
    categories: ["cross-process", "knowledge-dependent"],
    agentWallMs: 1200,
    totalWallMs: 1500,
    toolCalls: 8,
    distinctTools: ["kb_search", "create_suite"],
    suiteRuns: 1,
    tokensIn: 300,
    tokensOut: 50,
    costUsd: 0,
    finalText: "DONE",
    agentError: null,
    suiteCreated: true,
    suiteGreen: pass,
    suiteSteps: 4,
    suiteDurationMs: 300,
    checks: [],
    checklistFull: pass,
    pass,
    failureReason: pass ? null : "suite-red",
    trace: [],
  };
}

test("summarize retains categories and per-task denominator", () => {
  const summary = summarize([run(1, true), run(2, false)]);
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0]?.perTask, [{
    taskId: "task-a",
    kbSensitive: true,
    categories: ["cross-process", "knowledge-dependent"],
    pass: 1,
    of: 2,
  }]);
});

test("markdown report shows categories and scope caveats", () => {
  const report: EvalReport = {
    generatedAt: "2026-10-14T00:00:00.000Z",
    config,
    runs: [run(1, true), run(2, false)],
    summary: summarize([run(1, true), run(2, false)]),
  };
  const markdown = toMarkdown(report);
  assert.match(markdown, /seed 1234/);
  assert.match(markdown, /cross-process, knowledge-dependent/);
  assert.match(markdown, /empty results/);
  assert.match(markdown, /small run counts/);
});

test("wilsonInterval95: pinned edge values", () => {
  // all pass: lower bound is the whole interval, upper clamps to 1
  assert.deepEqual(wilsonInterval95(33, 33), { low: 0.8957, high: 1 });
  // none pass: lower bound is 0
  assert.deepEqual(wilsonInterval95(0, 3), { low: 0, high: 0.5615 });
  // no runs: no interval
  assert.equal(wilsonInterval95(0, 0), null);
  // interval always contains the point estimate and stays in [0,1]
  const mid = wilsonInterval95(1, 3);
  assert.ok(mid && mid.low <= 1 / 3 && 1 / 3 <= mid.high && mid.low >= 0 && mid.high <= 1);
});

test("classifyFailure: every failure mode maps to its cause", () => {
  const base = run(1, true);
  assert.equal(classifyFailure(base), null);
  const r = (over: Partial<TaskRunRecord>): TaskRunRecord => ({ ...base, pass: false, ...over });
  assert.equal(classifyFailure(r({ agentError: "run timed out after 15s" })), "timeout");
  assert.equal(classifyFailure(r({ agentError: "no final answer after 25 tool steps" })), "step-budget");
  assert.equal(classifyFailure(r({ agentError: "HTTP 400 bad request" })), "agent-error");
  assert.equal(classifyFailure(r({ agentError: null, suiteCreated: false })), "no-suite");
  assert.equal(classifyFailure(r({ agentError: null, suiteCreated: true, suiteGreen: false, checklistFull: false })), "suite-red");
  assert.equal(classifyFailure(r({ agentError: null, suiteCreated: true, suiteGreen: true, checklistFull: false })), "checklist-missing");
});

test("summarize: denominators, categories, failures, distributions, CI", () => {
  const a = run(1, true); // toolCalls 8, suiteRuns 1, wall 1.5s
  const b = run(2, false); // toolCalls 8, suiteRuns 1, wall 1.5s
  const c: TaskRunRecord = { ...b, taskId: "task-b", categories: ["negative", "cross-process"], toolCalls: 20, suiteRuns: 3, totalWallMs: 5000 };
  const s = summarize([a, b, c])[0];
  assert.ok(s);
  // every attempt is in the denominator exactly once
  assert.equal(s.runs, 3);
  assert.equal(s.pass + Object.values(s.failures).reduce((x, y) => x + y, 0), s.runs);
  assert.equal(s.failures["suite-red"], 2);
  assert.equal(s.failures["timeout"], 0);
  // category rows: a run tagged twice counts in both; rows overlap by design
  assert.deepEqual(s.perCategory, [
    { category: "cross-process", pass: 1, of: 3 },
    { category: "knowledge-dependent", pass: 1, of: 2 },
    { category: "negative", pass: 0, of: 1 },
  ]);
  // distributions span ALL attempts, not just successes
  assert.deepEqual(s.distributions.toolCalls, { min: 8, p50: 8, p95: 20 });
  assert.deepEqual(s.distributions.suiteRuns, { min: 1, p50: 1, p95: 3 });
  assert.deepEqual(s.distributions.wallSec, { min: 1.5, p50: 1.5, p95: 5 });
  // CI is the wilson interval for the same k/n
  assert.deepEqual(s.passCi95, wilsonInterval95(1, 3));
  // per-task denominators still exact
  assert.equal(s.perTask.length, 2);
  assert.deepEqual(s.perTask.map((t) => [t.taskId, t.pass, t.of]), [["task-a", 1, 2], ["task-b", 0, 1]]);
});

test("summarize: no runs produces no summary rows", () => {
  assert.deepEqual(summarize([]), []);
});

test("markdown: CI column, per-category, distributions, failures, manifest", () => {
  const runs = [run(1, true), run(2, false)];
  const report: EvalReport = {
    generatedAt: "2026-10-14T00:00:00.000Z",
    config,
    runs,
    summary: summarize(runs),
    manifest: {
      startedAt: "2026-10-14T00:00:00.000Z",
      runOrder: "kb-on; tasks in list order; 2 run(s)/task; sequential",
      configHash: "a".repeat(64),
      systemPromptHash: "b".repeat(64),
      taskSetHash: "c".repeat(64),
      toolSurface: [{ variant: "kb-on", tools: 15, hash: "d".repeat(64) }],
      kbManifestHash: "e".repeat(64),
      registryHash: "f".repeat(64),
      repoRevision: "abc1234",
      reasoning: "off",
    },
  };
  const md = toMarkdown(report);
  assert.match(md, /95% CI \(pass\)/);
  assert.match(md, /per-category/);
  assert.match(md, /distributions \(all attempts, min\/p50\/p95\)/);
  assert.match(md, /failures by cause/);
  assert.match(md, /suite-red 1/);
  assert.match(md, /experiment manifest/);
  assert.match(md, /sha256:a{64}/);
  assert.match(md, /abc1234/);
  assert.match(md, /uncertainty over repeated runs of THIS fixed setup/);
});

