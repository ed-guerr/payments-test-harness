import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, toMarkdown } from "./report";
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

