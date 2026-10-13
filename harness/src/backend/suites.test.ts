/**
 * backend/suites.test.ts — validation is the first line of defense against
 * an agent-authored (or hostile) suite: it must reject anything the registry
 * doesn't know, and the hostile cases below pin the security model that
 * docs/security.md describes (roadmap R4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateSuite, loadSuite } from "./suites";
import { safeSuiteFile, SUITES_DIR } from "./paths";
import type { Step, Suite } from "../runner/runner";

const okSuite = (): Suite => ({
  name: "unit-check",
  steps: [
    {
      id: "create",
      send: {
        to: "pay-orders",
        msg: "CreatePayment",
        fields: { txn_id: 1001, account: "ACCT-001", amount_cents: 100, currency: "USD" },
      },
      expectAck: { status: 0 },
    },
    { id: "wait", delayMs: 50 },
    { id: "bal", dbAssert: { sql: "SELECT balance_cents FROM accounts WHERE acct = ?", params: ["ACCT-001"], expect: { balance_cents: 499900 } } },
  ],
});

test("a valid suite passes validation", () => {
  assert.doesNotThrow(() => validateSuite(okSuite()));
});

test("a committed suite still loads + validates (sanity)", () => {
  assert.doesNotThrow(() => loadSuite(path.join(SUITES_DIR(), "payment-happy-path.json")));
});

test("unknown message name is rejected (registry is the source of truth)", () => {
  const s = okSuite();
  (s.steps[0] as { send: { msg: string } }).send.msg = "RefundPayment"; // no such message
  assert.throws(() => validateSuite(s), /unknown message/);
});

test("missing registry field in send.fields is rejected", () => {
  // pack() checks presence of every registry field (unknown extra fields are
  // tolerated on the wire — they are simply not packed).
  const s = okSuite();
  delete (s.steps[0] as { send: { fields: Record<string, unknown> } }).send.fields.currency;
  assert.throws(() => validateSuite(s), /missing field currency/);
});

test("unknown process is rejected", () => {
  const s = okSuite();
  (s.steps[0] as { send: { to: string } }).send.to = "billing";
  assert.throws(() => validateSuite(s), /unknown message/);
});

test("a step with two kinds is rejected", () => {
  const s = okSuite();
  (s.steps[1] as unknown as Record<string, unknown>).send = (s.steps[0] as { send: unknown }).send;
  assert.throws(() => validateSuite(s), /expected exactly one of/);
});

test("killProcess: unknown process and bad signal are rejected", () => {
  const bad = (): Suite => ({ name: "u", steps: [{ id: "k", killProcess: { proc: "billing" } }] });
  assert.throws(() => validateSuite(bad()), /unknown process/);
  const sig = (): Suite => ({
    name: "u",
    // SIGSTOP is not a legal signal — deliberately outside the Step union
    steps: [{ id: "k", killProcess: { proc: "ledger", signal: "SIGSTOP" } } as unknown as Step],
  });
  assert.throws(() => validateSuite(sig()), /SIGKILL or SIGTERM/);
});

/* Hostile-suite cases (roadmap R4) — every one must be rejected or neutralized. */

test("hostile: dbAssert DDL is rejected at validation", () => {
  const s = (): Suite => ({ name: "h", steps: [{ id: "x", dbAssert: { sql: "DROP TABLE accounts", params: [], expect: {} } }] });
  assert.throws(() => validateSuite(s()), /SELECT or WITH/);
});

test("hostile: multi-statement dbAssert is rejected at validation", () => {
  const s = (): Suite => ({ name: "h", steps: [{ id: "x", dbAssert: { sql: "SELECT 1; DROP TABLE accounts", params: [], expect: {} } }] });
  assert.throws(() => validateSuite(s()), /single statement/);
});

test("hostile: suite name cannot escape the suites directory", () => {
  for (const name of ["../../etc/evil", "..%2F..%2Fetc", ".hidden", "evil.json", "a/b"]) {
    assert.throws(() => safeSuiteFile(name), /unsafe suite name/, `should reject: ${name}`);
  }
  const safe = safeSuiteFile("payment-happy-path");
  assert.ok(safe.startsWith(SUITES_DIR()), "safe names resolve inside suites/");
});
