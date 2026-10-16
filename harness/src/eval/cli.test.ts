import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags, resolveMinPass } from "./cli";
import { SMOKE_TASK_IDS } from "./tasks";

test("parseFlags: variant spellings select the intended conditions", () => {
  assert.deepEqual(parseFlags([]).variant, ["kb-on", "kb-off"]);
  assert.deepEqual(parseFlags(["--variant", "both"]).variant, ["kb-on", "kb-off"]);
  assert.deepEqual(parseFlags(["--variant", "three-way"]).variant, ["kb-on", "kb-content-off", "kb-off"]);
  assert.deepEqual(parseFlags(["--variant", "on"]).variant, ["kb-on"]);
  assert.deepEqual(parseFlags(["--variant", "off"]).variant, ["kb-off"]);
  assert.deepEqual(parseFlags(["--variant", "content-off"]).variant, ["kb-content-off"]);
  assert.throws(() => parseFlags(["--variant", "nope"]), /--variant must be/);
});

test("parseFlags: seed from flag or env, integer-checked", () => {
  const saved = process.env.EVAL_SEED;
  try {
    delete process.env.EVAL_SEED;
    assert.equal(parseFlags([]).seed, null);
    process.env.EVAL_SEED = "7";
    assert.equal(parseFlags([]).seed, 7);
    delete process.env.EVAL_SEED;
    assert.equal(parseFlags(["--seed", "42"]).seed, 42);
    assert.throws(() => parseFlags(["--seed", "abc"]), /--seed must be an integer/);
    assert.throws(() => parseFlags(["--seed", "1.5"]), /--seed must be an integer/);
  } finally {
    if (saved === undefined) delete process.env.EVAL_SEED;
    else process.env.EVAL_SEED = saved;
  }
});

test("parseFlags: positive-integer and task-id validation", () => {
  assert.throws(() => parseFlags(["--runs", "0"]), /--runs must be a positive integer/);
  assert.throws(() => parseFlags(["--runs", "2.5"]), /--runs must be a positive integer/);
  assert.throws(() => parseFlags(["--max-steps", "-1"]), /--max-steps must be a positive integer/);
  assert.throws(() => parseFlags(["--tasks", "no-such-task"]), /no-such-task/);
  assert.throws(() => parseFlags(["--bogus"]), /unknown flag/);
});

test("parseFlags: smoke pins one run over the smoke task set", () => {
  const f = parseFlags(["--smoke"]);
  assert.deepEqual(f.tasks, [...SMOKE_TASK_IDS]);
  assert.equal(f.runs, 1);
});

test("resolveMinPass: --min-pass override wins for both baseline variants", () => {
  const o = resolveMinPass("whatever-model", 5);
  assert.equal(o.minPass["kb-on"], 5);
  assert.equal(o.minPass["kb-off"], 5);
  assert.equal(o.source, "--min-pass override");
});

test("resolveMinPass: unknown model is not gated; content-off never baselined", () => {
  const u = resolveMinPass("no-such-model", null);
  assert.deepEqual(u.minPass, {});
  assert.match(u.source, /no baseline/);
  const q = resolveMinPass("qwen3", null);
  assert.equal(q.minPass["kb-on"], 33);
  assert.equal(q.minPass["kb-off"], 32);
  assert.equal(q.minPass["kb-content-off"], undefined);
});
