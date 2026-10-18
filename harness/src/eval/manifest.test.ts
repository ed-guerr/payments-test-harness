import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, sha256Hex, stableJson } from "./manifest";
import { TASKS } from "./tasks";
import type { EvalConfig } from "./types";

const config: EvalConfig = {
  model: "test-model",
  apiBase: "http://localhost/v1",
  temperature: 0,
  maxToolSteps: 25,
  seed: 1,
  runsPerTask: 3,
  variants: ["kb-on"],
  taskIds: ["happy-path"],
  outDir: "/tmp/eval-manifest-test",
  runTimeoutMs: 1000,
  chatTimeoutMs: 1000,
  chatRetries: 0,
};

const tasks = TASKS.filter((t) => t.id === "happy-path");

test("stableJson: key order does not change the hash", () => {
  assert.equal(
    sha256Hex(stableJson({ a: 1, b: { d: 2, c: 3 } })),
    sha256Hex(stableJson({ b: { c: 3, d: 2 }, a: 1 })),
  );
  assert.notEqual(stableJson({ a: 1, b: 2 }), stableJson({ a: 2, b: 1 }));
});

test("buildManifest: identity fields are deterministic and content-sensitive", () => {
  const at = "2026-10-14T00:00:00.000Z";
  const a = buildManifest(config, tasks, at, [{ variant: "kb-on", tools: 15, hash: "x" }]);
  assert.match(a.configHash, /^[0-9a-f]{64}$/);
  assert.match(a.systemPromptHash, /^[0-9a-f]{64}$/);
  assert.match(a.taskSetHash, /^[0-9a-f]{64}$/);
  // the repo's own KB manifest and registry are present in this checkout
  assert.match(a.kbManifestHash, /^[0-9a-f]{64}$/);
  assert.match(a.registryHash, /^[0-9a-f]{64}$/);
  assert.match(a.repoRevision, /^[0-9a-f]{7}$/);
  assert.match(a.runOrder, /kb-on; tasks in list order; 3 run\(s\)\/task/);

  // identical inputs hash identically
  const d = buildManifest(config, tasks, at, []);
  assert.equal(a.configHash, d.configHash);
  assert.equal(a.taskSetHash, d.taskSetHash);
  assert.equal(a.systemPromptHash, d.systemPromptHash);

  // a different config changes the config hash — and only it
  const b = buildManifest({ ...config, seed: 2 }, tasks, at, []);
  assert.notEqual(a.configHash, b.configHash);
  assert.equal(a.taskSetHash, b.taskSetHash);

  // an edited task prompt changes the task-set hash — and only it
  const c = buildManifest(config, [{ ...tasks[0]!, prompt: "changed prompt" }], at, []);
  assert.notEqual(a.taskSetHash, c.taskSetHash);
  assert.equal(a.configHash, c.configHash);
});

test("buildManifest: reasoning reflects EVAL_THINKING", () => {
  const saved = process.env.EVAL_THINKING;
  try {
    delete process.env.EVAL_THINKING;
    assert.equal(buildManifest(config, tasks, "t", []).reasoning, "off");
    process.env.EVAL_THINKING = "1";
    assert.equal(buildManifest(config, tasks, "t", []).reasoning, "on");
  } finally {
    if (saved === undefined) delete process.env.EVAL_THINKING;
    else process.env.EVAL_THINKING = saved;
  }
});
