/**
 * eval/manifest.ts — experiment identity.
 *
 * Records enough to know exactly what a report's runs were and to compare
 * two runs: config, prompts, task set, model-visible tool surface per
 * condition, KB and registry identity, repo revision. All hashes are
 * sha256 over stable (key-sorted) JSON so identical content hashes the
 * same regardless of field order.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../backend/paths";
import { SYSTEM_PROMPT } from "./prompt";
import type { EvalConfig, EvalTask, ExperimentManifest } from "./types";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return value;
}

/** Deterministic JSON: object keys sorted at every depth. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function fileHash(file: string): string {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return "missing";
  }
}

export function repoRevision(): string {
  try {
    const repoRoot = path.resolve(packageRoot(), "..");
    return execSync(`git -C ${JSON.stringify(repoRoot)} rev-parse --short HEAD`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "not-a-git-checkout";
  }
}

export function buildManifest(
  config: EvalConfig,
  tasks: EvalTask[],
  startedAt: string,
  toolSurface: ExperimentManifest["toolSurface"],
): ExperimentManifest {
  const repoRoot = path.resolve(packageRoot(), "..");
  return {
    startedAt,
    runOrder: `${config.variants.join(" -> ")}; tasks in list order; ` +
      `${config.runsPerTask} run(s)/task; sequential`,
    configHash: sha256Hex(stableJson(config)),
    systemPromptHash: sha256Hex(SYSTEM_PROMPT),
    taskSetHash: sha256Hex(
      stableJson(
        tasks.map((t) => ({
          id: t.id,
          prompt: t.prompt,
          suiteName: t.suiteName,
          kbSensitive: t.kbSensitive ?? false,
          categories: t.categories ?? [],
          checks: t.checks,
        })),
      ),
    ),
    toolSurface,
    kbManifestHash: fileHash(path.join(repoRoot, "knowledge", ".manifest.json")),
    registryHash: fileHash(path.join(packageRoot(), "src", "protocol", "registry.json")),
    repoRevision: repoRevision(),
    reasoning: process.env.EVAL_THINKING === "1" ? "on" : "off",
  };
}
