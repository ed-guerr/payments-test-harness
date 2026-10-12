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
export const DATA_DIR = (): string => path.join(packageRoot(), "data");
/** Backend build output: <repo>/backend/build (sibling of harness/). */
export const backendBuildDir = (): string => path.join(packageRoot(), "..", "backend", "build");
/** The backend's SQL schema + seed file. */
export const schemaFile = (): string => path.join(packageRoot(), "..", "backend", "db", "schema.sql");
