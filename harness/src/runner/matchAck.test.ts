/**
 * runner/matchAck.test.ts — partial-match ack semantics are the contract
 * every suite's `expectAck` relies on: pin what matters, ignore the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAck } from "./runner";

test("partial match: extra fields in the ack are ignored", () => {
  const got = { status: 0, txn_id: 1001, extra: "x" };
  assert.deepEqual(matchAck(got, { status: 0 }), []);
  assert.deepEqual(matchAck(got, {}), []);
});

test("partial match: a pinned field that is missing fails", () => {
  assert.deepEqual(matchAck({ status: 0 }, { status: 0, txn_id: 1 }), ["missing field txn_id"]);
});

test("partial match: a wrong value reports expected vs actual", () => {
  const problems = matchAck({ status: 1 }, { status: 0 });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /status: expected 0, got 1/);
});
