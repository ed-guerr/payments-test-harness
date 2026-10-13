/**
 * backend/suites.ts — suite loading and validation (shared by CLI, Electron
 * main, and the MCP server).
 */
import fs from "node:fs";
import path from "node:path";
import { SUITES_DIR } from "./paths";
import * as codec from "../protocol/codec";
import type { Suite } from "../runner/runner";

export interface SuiteMeta {
  name: string;
  description: string;
  stepCount: number;
}

export function listSuites(): SuiteMeta[] {
  return fs
    .readdirSync(SUITES_DIR())
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const s = loadSuite(path.join(SUITES_DIR(), f));
      return { name: s.name, description: s.description ?? "", stepCount: s.steps.length };
    });
}

export function loadSuite(file: string): Suite {
  const s = JSON.parse(fs.readFileSync(file, "utf8")) as Suite;
  validateSuite(s);
  return s;
}

/**
 * Structural validation against the registry: unknown process/message names
 * and missing fields throw here, before anything is executed.
 */
export function validateSuite(s: Suite): void {
  if (typeof s.name !== "string" || !Array.isArray(s.steps)) throw new Error("suite must have name + steps[]");
  s.steps.forEach((step, i) => {
    if (typeof step.id !== "string") throw new Error(`step ${i}: missing id`);
    const kinds = ["send", "dbAssert", "delayMs", "killProcess"].filter((k) => k in step);
    if (kinds.length !== 1) {
      throw new Error(`step ${i} (${step.id}): expected exactly one of send|dbAssert|delayMs|killProcess`);
    }
    if ("send" in step) {
      const { to, msg, fields } = step.send;
      codec.findMessage(to, msg);
      codec.pack(to, msg, fields);
      if (step.expectError !== undefined && typeof step.expectError !== "boolean") {
        throw new Error(`step ${i} (${step.id}): expectError must be a boolean`);
      }
    }
    if ("dbAssert" in step) {
      const sql = (step.dbAssert?.sql ?? "").trim();
      if (!/^(SELECT|WITH)\b/i.test(sql)) {
        throw new Error(`step ${i} (${step.id}): dbAssert.sql must be a SELECT or WITH statement (the runner executes it on a read-only connection)`);
      }
      if (sql.includes(";")) {
        throw new Error(`step ${i} (${step.id}): dbAssert.sql must be a single statement (no semicolons)`);
      }
    }
    if ("killProcess" in step) {
      const { proc, signal } = step.killProcess;
      if (!codec.listProcs().includes(proc)) {
        throw new Error(`step ${i} (${step.id}): unknown process "${proc}" (known: ${codec.listProcs().join(", ")})`);
      }
      if (signal !== undefined && signal !== "SIGKILL" && signal !== "SIGTERM") {
        throw new Error(`step ${i} (${step.id}): signal must be SIGKILL or SIGTERM`);
      }
    }
  });
}
