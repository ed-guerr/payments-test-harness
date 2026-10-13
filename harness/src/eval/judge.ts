/**
 * eval/judge.ts — deterministic ground-truth scoring.
 *
 * The judge never looks at the agent's prose and never calls a model: it
 * checks the generated suite JSON structurally, item by item. That makes a
 * score reproducible run-to-run and diff-able between KB on/off.
 */
import type { Suite } from "../runner/runner";
import type { Check, CheckResult, EvalTask } from "./types";

function checkUsesMessage(check: Extract<Check, { kind: "usesMessage" }>, suite: Suite): CheckResult {
  const n = suite.steps.filter((s) => "send" in s && s.send.msg === check.name).length;
  const min = check.minCount ?? 1;
  return { check, ok: n >= min, detail: `usesMessage ${check.name}: ${n} >= ${min}` };
}

function checkHasExpectError(check: Extract<Check, { kind: "hasExpectError" }>, suite: Suite): CheckResult {
  const n = suite.steps.filter(
    (s) => "send" in s && s.expectError === true && (!check.message || s.send.msg === check.message),
  ).length;
  return { check, ok: n >= 1, detail: `hasExpectError${check.message ? ` on ${check.message}` : ""}: ${n} step(s)` };
}

function checkKillsProcess(check: Extract<Check, { kind: "killsProcess" }>, suite: Suite): CheckResult {
  const n = suite.steps.filter((s) => "killProcess" in s && s.killProcess.proc === check.proc).length;
  return { check, ok: n >= 1, detail: `killsProcess ${check.proc}: ${n} step(s)` };
}

function checkExpectsAckField(check: Extract<Check, { kind: "expectsAckField" }>, suite: Suite): CheckResult {
  const hits = suite.steps.filter((s) => {
    if (!("send" in s)) return false;
    if (check.message && s.send.msg !== check.message) return false;
    const want = s.expectAck?.[check.field];
    return want !== undefined && want === check.value;
  }).length;
  return {
    check,
    ok: hits >= 1,
    detail: `expectsAckField${check.message ? ` on ${check.message}` : ""} ${check.field}=${JSON.stringify(check.value)}: ${hits} step(s)`,
  };
}

function checkAssertsRow(check: Extract<Check, { kind: "assertsRow" }>, suite: Suite): CheckResult {
  const re = new RegExp(`\\b${check.table}\\b`, "i");
  const hits = suite.steps.filter((s) => {
    if (!("dbAssert" in s)) return false;
    if (!re.test(s.dbAssert.sql)) return false;
    return Object.entries(check.expect).every(([col, want]) => s.dbAssert.expect[col] === want);
  }).length;
  const want = Object.entries(check.expect)
    .map(([c, v]) => `${c}=${JSON.stringify(v)}`)
    .join(" ");
  return { check, ok: hits >= 1, detail: `assertsRow ${check.table} (${want}): ${hits} step(s)` };
}

/** Score every ground-truth item of the task against the generated suite. */
export function judgeSuite(task: EvalTask, suite: Suite): CheckResult[] {
  return task.checks.map((check) => {
    switch (check.kind) {
      case "usesMessage":
        return checkUsesMessage(check, suite);
      case "hasExpectError":
        return checkHasExpectError(check, suite);
      case "killsProcess":
        return checkKillsProcess(check, suite);
      case "expectsAckField":
        return checkExpectsAckField(check, suite);
      case "assertsRow":
        return checkAssertsRow(check, suite);
    }
  });
}
