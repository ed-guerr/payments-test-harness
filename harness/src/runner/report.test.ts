/**
 * runner/report.test.ts — the HTML run report is how a human verifies a
 * failing run, so pin that a mismatched dbAssert column renders with its
 * expected vs actual values (the "assertion-failure-demo" UX, without a
 * full cluster).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtmlReport } from "./report";
import type { Suite, StepResult, StepTiming, SuiteResult } from "./runner";

const suite: Suite = {
  name: "unit-report-check",
  steps: [
    {
      id: "assert-balance",
      dbAssert: {
        sql: "SELECT balance_cents FROM accounts WHERE acct = ?",
        params: ["ACCT-001"],
        expect: { balance_cents: 100 },
      },
    },
  ],
};

const steps: (StepResult & StepTiming)[] = [
  {
    suite: suite.name,
    stepId: "assert-balance",
    ok: false,
    detail: "balance_cents: expected 100, got 99",
    received: { sql: "SELECT balance_cents FROM accounts WHERE acct = ?", row: { balance_cents: 99 } },
    startedAtMs: 0,
    durationMs: 5,
  },
];

const result: SuiteResult = { suite: suite.name, ok: false, passed: 0, failed: 1, durationMs: 5 };

test("a failing run renders the expected vs actual diff", () => {
  const html = renderHtmlReport({ suite, result, steps, at: new Date().toISOString() });
  assert.match(html, /unit-report-check/);
  assert.match(html, /balance_cents/);
  // expected (100) and actual (99) values both present in the rendered diff
  assert.match(html, /100/);
  assert.match(html, /99/);
});
