import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSuites,
  modelLabel,
  parseSuiteRunText,
  redact,
  redactPersonal,
  renderTraceReport,
  suiteFromArgs,
} from "./tracereport";
import type { EvalConfig, TaskRunRecord, ToolCallRecord } from "./types";

const config: EvalConfig = {
  model: "test-model",
  apiBase: "http://localhost/v1",
  temperature: 0,
  maxToolSteps: 25,
  seed: 7,
  runsPerTask: 10,
  variants: ["kb-on", "kb-off"],
  taskIds: ["task-a"],
  outDir: "/tmp/eval-report-test",
  runTimeoutMs: 60000,
  chatTimeoutMs: 60000,
  chatRetries: 0,
};

function rec(step: number, name: string, args: unknown, ok: boolean, text: string): ToolCallRecord {
  return { step, name, args, ok, text, durationMs: 12 };
}

const suiteV1 = { name: "eval-t", description: "d", steps: [{ id: "a", expectAck: { status: 2 } }] };
const suiteV2 = { name: "eval-t", steps: [{ id: "a", expectAck: { status: 1 } }, { id: "b" }] };

const redText = JSON.stringify({
  suite: "eval-t", ok: false, passed: 1, failed: 1, durationMs: 1,
  steps: {
    at: "2026-01-01T00:00:00Z", suite: "eval-t", ok: false, passed: 1, failed: 1, durationMs: 1,
    steps: [
      { suite: "eval-t", stepId: "a", ok: false, detail: "status: expected 2, got 1", received: { status: 1 } },
      { suite: "eval-t", stepId: "b", ok: true, detail: "row matches" },
    ],
  },
});
const greenText = JSON.stringify({
  suite: "eval-t", ok: true, passed: 2, failed: 0, durationMs: 1,
  steps: {
    at: "2026-01-01T00:00:01Z", suite: "eval-t", ok: true, passed: 2, failed: 0, durationMs: 1,
    steps: [
      { suite: "eval-t", stepId: "a", ok: true, detail: "ack ok" },
      { suite: "eval-t", stepId: "b", ok: true, detail: "row matches" },
    ],
  },
});

function run(over: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return {
    taskId: "task-a",
    variant: "kb-on",
    run: 1,
    model: "test-model",
    kbSensitive: false,
    categories: ["cross-process"],
    agentWallMs: 5000,
    totalWallMs: 6000,
    toolCalls: 3,
    distinctTools: ["create_suite", "run_suite"],
    suiteRuns: 1,
    tokensIn: 3000,
    tokensOut: 400,
    costUsd: null,
    finalText: "DONE",
    agentError: null,
    suiteCreated: true,
    suiteGreen: true,
    suiteSteps: 2,
    suiteDurationMs: 40,
    checks: [{ check: { kind: "usesMessage", name: "CreatePayment" }, ok: true, detail: "1 >= 1" }],
    checklistFull: true,
    pass: true,
    failureReason: null,
    trace: [
      rec(1, "create_suite", suiteV1, true, '{"created": "eval-t"}'),
      rec(2, "run_suite", { name: "eval-t" }, true, greenText),
    ],
    ...over,
  };
}

test("first-attempt success: one authoring attempt plus green rerun", () => {
  const md = renderTraceReport(config, run());
  assert.match(md, /# Trace report — `task-a` · kb-on · run 1/);
  assert.match(md, /\| Outcome \| PASS \|/);
  assert.match(md, /\| Independent rerun \| green \(2 steps, 0\.04s\)/);
  assert.match(md, /### revision 1 — create_suite \(step 1\) — `eval-t`/);
  assert.match(md, /none — every agent suite run was green\./);
  assert.match(md, /Redaction:/);
});

test("fail → update → retry renders in trace order with diff", () => {
  const r = run({
    suiteRuns: 2,
    toolCalls: 4,
    distinctTools: ["create_suite", "run_suite", "update_suite"],
    trace: [
      rec(1, "create_suite", suiteV1, true, '{"created": "eval-t"}'),
      rec(2, "run_suite", { name: "eval-t" }, true, redText),
      rec(3, "update_suite", suiteV2, true, '{"updated": "eval-t", "steps": 2}'),
      rec(4, "run_suite", { name: "eval-t" }, true, greenText),
    ],
  });
  const md = renderTraceReport(config, r);
  // sections are grouped (all revisions, then red runs): within each, trace order
  const iV1 = md.indexOf("### revision 1");
  const iV2 = md.indexOf("### revision 2");
  const iDiff = md.indexOf("Diff revision 1 → 2");
  const iRed = md.indexOf("### red run at step 2");
  const iCheck = md.indexOf("## Checklist");
  assert.ok(iV1 >= 0 && iV2 > iV1 && iDiff > iV2 && iRed > iDiff && iCheck > iRed, `order violated: ${iV1} ${iV2} ${iDiff} ${iRed} ${iCheck}`);
  assert.match(md, /\*1\/2 — RED\*\*/);
  assert.match(md, /`steps\[0\]\.expectAck\.status`: ~ 2 → 1/);
  assert.match(md, /`steps\[1\]`: \+ /);
  assert.match(md, /`a`: status: expected 2, got 1/);
});

test("timeline: red suite run shows per-step failure and received fields", () => {
  const r = run({
    pass: false,
    suiteGreen: false,
    checklistFull: false,
    failureReason: "suite-red",
    checks: [],
    trace: [rec(1, "run_suite", { name: "eval-t" }, true, redText)],
  });
  const md = renderTraceReport(config, r);
  assert.match(md, /\| 1 | executing | `run_suite` \|.*\*\*1\/2 — RED\*\*/);
  assert.match(md, /"status": 1/); // received fields rendered
});

test("diffSuites: added, removed, changed at the right paths", () => {
  const a = { steps: [{ id: "x", expectAck: { status: 2, extra: true } }, { id: "y" }] };
  const b = { steps: [{ id: "x", expectAck: { status: 1 } }, { id: "y" }, { id: "z" }] };
  const d = diffSuites(a, b);
  const path = (e: { path: string }) => e.path;
  assert.ok(d.some((e) => path(e) === "steps[0].expectAck.status" && e.kind === "changed" && e.from === 2 && e.to === 1));
  assert.ok(d.some((e) => path(e) === "steps[0].expectAck.extra" && e.kind === "removed"));
  assert.ok(d.some((e) => path(e) === "steps[2]" && e.kind === "added"));
  assert.equal(d.filter((e) => e.kind === "changed").length, 1);
});

test("escaping: pipes, backticks, and newlines cannot break the table", () => {
  const r = run({
    trace: [rec(1, "db_schema", {}, true, "a|b`c\nd")],
  });
  const md = renderTraceReport(config, r);
  assert.ok(md.includes("a\\|b\\`c ⏎ d"), "expected escaped inline text");
  const timeline = md.slice(md.indexOf("## Tool timeline"), md.indexOf("## Suite revisions"));
  // header + separator + 1 row = exactly 3 table rows
  assert.equal(timeline.split("\n").filter((l) => l.startsWith("|")).length, 3);
});

test("truncated tool text is clearly marked", () => {
  const r = run({
    trace: [rec(1, "db_schema", {}, true, "x".repeat(2000))],
  });
  const md = renderTraceReport(config, r);
  assert.match(md, /…\(truncated\)/);
});

test("secrets are redacted: configured values, Bearer tokens, URL credentials", () => {
  const r = run({
    finalText: "connect with sk-test-1234",
    trace: [
      rec(1, "run_suite", { url: "http://user:pass@host/v1" }, false, "Authorization: Bearer sk-test-1234 denied"),
    ],
  });
  const md = renderTraceReport(config, r, { redact: ["sk-test-1234"] });
  assert.ok(!md.includes("sk-test-1234"), "secret leaked");
  assert.ok(!md.includes("user:pass@"), "URL creds leaked");
  assert.match(md, /Bearer \[REDACTED\]/);
  assert.match(md, /:\/\/\[REDACTED\]@/);
  assert.match(md, /\[REDACTED\] denied/);
  assert.match(md, /1 secret value\(s\) configured/);
});

test("redact: pattern matches work standalone and short secrets are ignored", () => {
  assert.equal(redact("Bearer abc.def_123", []), "Bearer [REDACTED]");
  assert.equal(redact("http://u:p@h/x", []), "http://[REDACTED]@h/x");
  assert.equal(redact("sk-12", ["sk-12"]), "sk-12"); // < MIN_SECRET_LEN not value-scrubbed
});

test("redact: RFC1918 endpoints are redacted, public endpoints untouched", () => {
  // Synthetic private-range addresses only — never a real LAN address, so
  // this test file can never carry a live endpoint into history.
  assert.equal(redact("http://10.0.0.5:8080/v1", []), "http://<lan-host>:8080/v1");
  assert.equal(redact("ws://172.16.0.1:9000", []), "ws://<lan-host>:9000");
  assert.equal(redact("the box at 172.31.255.254 died", []), "the box at <lan-ip> died");
  // 172.15/172.32 are outside 172.16.0.0/12; 8.8.8.8 is public.
  assert.equal(redact("172.15.0.1 and 172.32.0.1 and 8.8.8.8 stay", []), "172.15.0.1 and 172.32.0.1 and 8.8.8.8 stay");
  assert.equal(redact("https://api.example.com/v1", []), "https://api.example.com/v1");
  assert.equal(redact("http://localhost:8080/v1", []), "http://localhost:8080/v1");
});

test("personal values are redacted: LAN URL, home dir, repo root, GGUF model path", () => {
  const personalConfig: EvalConfig = { ...config, apiBase: "http://10.0.0.5:8080/v1" };
  const gguf = "/srv/models/demo-12b-it-q4_0/demo-12b-it-qat-q4_0.gguf";
  const home = "/tmp/agent-home";
  const repo = `${home}/projects/demo-repo`;
  const r = run({
    model: gguf,
    trace: [rec(1, "get_suite", { file: `${repo}/harness/suites/x.json` }, true, "ok")],
  });
  const md = renderTraceReport(personalConfig, r, { homeDir: home, repoRoot: repo });
  assert.ok(!md.includes("10.0.0.5"), "LAN IP leaked");
  assert.ok(!md.includes("/tmp/agent-home"), "home dir leaked");
  assert.ok(!md.includes("/srv/models"), "model path leaked");
  assert.match(md, /http:\/\/<lan-host>:8080\/v1/);
  assert.match(md, /<repo>\/harness\/suites\/x\.json/);
  assert.match(md, /demo-12b-it-qat-q4_0\.gguf/);
  assert.match(md, /home\/repo paths are always redacted/);
});

test("redactPersonal: substitutes only whole path units, longest value first", () => {
  const home = "/tmp/agent";
  const repo = `${home}/projects/demo-repo`;
  assert.equal(
    redactPersonal("a /tmp/agent/x and /tmp/agent2 and /tmp/agent", { homeDir: home }),
    "a <home>/x and /tmp/agent2 and <home>",
  );
  assert.equal(
    redactPersonal(`path \`${repo}/src/a.c\` and \`${repo}\``, { homeDir: home, repoRoot: repo }),
    "path `<repo>/src/a.c` and `<repo>`",
  );
});

test("modelLabel: paths reduce to basename, ids pass through", () => {
  assert.equal(modelLabel("/srv/models/demo-12b-it-q4_0/demo-12b-it-qat-q4_0.gguf"), "demo-12b-it-qat-q4_0.gguf");
  assert.equal(modelLabel("gpt-6-luna"), "gpt-6-luna");
});

test("checklist: passing and failing items both show their detail", () => {
  const r = run({
    checklistFull: false,
    pass: false,
    failureReason: "checklist-missing",
    checks: [
      { check: { kind: "usesMessage", name: "A" }, ok: true, detail: "1 >= 1" },
      { check: { kind: "assertsRow", table: "payments", expect: { n: 0 } }, ok: false, detail: "expected status" },
    ],
  });
  const md = renderTraceReport(config, r);
  assert.match(md, /- \[x\] `usesMessage A` — 1 >= 1/);
  assert.match(md, /- \[ \] `assertsRow payments` — expected status/);
  assert.match(md, /\| Checklist \| 1\/2 \|/);
});

test("budget exhaustion with no suite renders without crashing", () => {
  const r = run({
    pass: false,
    suiteCreated: false,
    suiteGreen: null,
    suiteSteps: null,
    failureReason: "step-budget",
    agentError: "max tool steps exceeded (25)",
    checks: [],
    finalText: "",
    trace: [],
  });
  const md = renderTraceReport(config, r);
  assert.match(md, /FAIL \(step-budget\) — agent error: max tool steps exceeded \(25\)/);
  assert.match(md, /No suite was created/);
  assert.match(md, /No tool calls recorded/);
  assert.match(md, /No checklist checks recorded/);
  assert.match(md, /_empty_/);
});

test("tool error row keeps the useful result text", () => {
  const r = run({
    trace: [rec(1, "get_suite", { name: "nope" }, false, "suite not found: nope")],
  });
  const md = renderTraceReport(config, r);
  assert.match(md, /\*\*ERR\*\*: suite not found: nope/);
});

test("parseSuiteRunText: valid, non-JSON, and truncated JSON", () => {
  assert.equal(parseSuiteRunText(greenText)?.ok, true);
  assert.equal(parseSuiteRunText("not json"), null);
  const truncated = redText.slice(0, redText.length - 5); // breaks the JSON
  assert.equal(parseSuiteRunText(truncated), null);
  const noSteps = JSON.stringify({ suite: "s", ok: true, passed: 3, failed: 0 });
  assert.equal(parseSuiteRunText(noSteps)?.steps.length, 0);
});

test("suiteFromArgs: full steps required; anything else is null", () => {
  assert.deepEqual(suiteFromArgs(suiteV1)?.steps, suiteV1.steps);
  assert.equal(suiteFromArgs({ name: "x" }), null);
  assert.equal(suiteFromArgs("nope"), null);
  assert.equal(suiteFromArgs(null), null);
});

test("render: no secret config still renders the redaction note", () => {
  const md = renderTraceReport(config, run());
  assert.match(md, /0 secret value\(s\) configured/);
});
