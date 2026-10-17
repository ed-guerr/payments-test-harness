/**
 * backend/paths.ts — path resolution that works identically under tsx
 * (source) and the compiled dist/ layout: find the nearest package.json
 * upward from this file and anchor everything to it.
 */
import fs from "node:fs";
import path from "node:path";

let root: string | null = null;

export function packageRoot(): string {
  if (root) return root;
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      root = dir;
      return root;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not find package root above " + __dirname);
    dir = parent;
  }
}

export const SUITES_DIR = (): string => path.join(packageRoot(), "suites");

/**
 * Resolve a suite id to its file path. Ids come from the agent (MCP
 * create_suite/update_suite) or the file system (list_suites), so the
 * charset is the trust boundary: only `[a-z0-9-]` (no dots, no slashes),
 * which rules out path traversal ("../../etc/evil") and hidden files.
 */
export function safeSuiteFile(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`unsafe suite name: ${name}`);
  return path.join(SUITES_DIR(), `${name}.json`);
}
export const DATA_DIR = (): string => path.join(packageRoot(), "data");
/** Persisted run results (one JSON file per suite run). */
/** Per-run JSON artifacts (every run_suite caller): <repo>/artifacts/suite-runs. */
export const RUNS_DIR = (): string => path.join(packageRoot(), "..", "artifacts", "suite-runs");
/** HTML run reports: <repo>/artifacts/test-reports (one self-contained .html per run). */
export const REPORTS_DIR = (): string => path.join(packageRoot(), "..", "artifacts", "test-reports");
/** Backend build output: <repo>/backend/build (sibling of harness/). */
export const backendBuildDir = (): string => path.join(packageRoot(), "..", "backend", "build");
/** The backend's SQL schema + seed file. */
export const schemaFile = (): string => path.join(packageRoot(), "..", "backend", "db", "schema.sql");
