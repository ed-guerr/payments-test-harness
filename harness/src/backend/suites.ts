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
    const kinds = ["send", "dbAssert", "delayMs"].filter((k) => k in step);
    if (kinds.length !== 1) {
      throw new Error(`step ${i} (${step.id}): expected exactly one of send|dbAssert|delayMs`);
    }
    if ("send" in step) {
      const { to, msg, fields } = step.send;
      codec.findMessage(to, msg);
      codec.pack(to, msg, fields);
    }
  });
}
