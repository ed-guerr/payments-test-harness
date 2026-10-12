/**
 * runner/runner.ts — headless test-suite runner.
 *
 * A suite is a JSON file: an ordered list of steps. Step kinds:
 *   send      — send a message to a process; optionally expectAck (partial
 *               field match on the decoded ack; the ack id comes from the
 *               registry's `response` field)
 *   dbAssert  — SQL query against the backend's database; expect is a
 *               partial row match
 *   delayMs   — wait (covers async inter-process forwards)
 *
 * The runner is Electron-free: it emits JSON events through a callback, so
 * the CLI prints them and the Electron UI subscribes to the same events.
 */
import fs from "node:fs";
import path from "node:path";
import { checkRow, Db } from "../db/db";
import * as codec from "../protocol/codec";
import type { Conn } from "../protocol/conn";
import type { FieldValue } from "../protocol/types";

export interface SendStep {
  id: string;
  send: { to: string; msg: string; fields: Record<string, FieldValue> };
  expectAck?: Record<string, FieldValue>;
  timeoutMs?: number;
}

export interface DbAssertStep {
  id: string;
  dbAssert: { sql: string; params?: (string | number | null)[]; expect: Record<string, string | number | null> };
}

export interface DelayStep {
  id: string;
  delayMs: number;
}

export type Step = SendStep | DbAssertStep | DelayStep;

export interface Suite {
  name: string;
  description?: string;
  steps: Step[];
}

export interface StepResult {
  suite: string;
  stepId: string;
  ok: boolean;
  detail: string;
  received?: unknown;
}

export interface SuiteResult {
  suite: string;
  ok: boolean;
  passed: number;
  failed: number;
  durationMs: number;
}

export type RunnerEvent =
  | { type: "suite-start"; suite: string }
  | (StepResult & { type: "step-result" })
  | (SuiteResult & { type: "suite-result" })
  | { type: "done"; results: SuiteResult[] };

export const DEFAULT_TIMEOUT_MS = 2000;

export interface RunnerOptions {
  /** When set, each finished run is persisted to <runsDir>/<suite>-<ts>.json. */
  runsDir?: string;
}

export class Runner {
  constructor(
    private conns: Record<string, Conn>,
    private db: Db,
    private emit: (e: RunnerEvent) => void,
    private opts: RunnerOptions = {},
  ) {}

  async runSuite(suite: Suite): Promise<SuiteResult> {
    const t0 = Date.now();
    this.emit({ type: "suite-start", suite: suite.name });
    const steps: StepResult[] = [];
    let passed = 0;
    let failed = 0;
    for (const step of suite.steps) {
      const r = await this.runStep(suite.name, step);
      steps.push(r);
      this.emit({ type: "step-result", ...r });
      if (r.ok) passed++;
      else failed++;
    }
    const result: SuiteResult = {
      suite: suite.name,
      ok: failed === 0,
      passed,
      failed,
      durationMs: Date.now() - t0,
    };
    this.emit({ type: "suite-result", ...result });
    this.persistRun(result, steps);
    return result;
  }

  private persistRun(result: SuiteResult, steps: StepResult[]): void {
    if (!this.opts.runsDir) return;
    try {
      fs.mkdirSync(this.opts.runsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(this.opts.runsDir, `${result.suite}-${ts}.json`);
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result, steps }, null, 2) + "\n");
    } catch {
      // persisting is best-effort; never fail a run because of it
    }
  }

  /** Latest persisted run for a suite (or the latest overall when name is null). */
  static latestRun(runsDir: string, suite?: string): { file: string; data: unknown } | null {
    const files = fs
      .readdirSync(runsDir)
      .filter((f) => f.endsWith(".json") && (!suite || f.startsWith(`${suite}-`)))
      .sort();
    const last = files[files.length - 1];
    if (!last) return null;
    return { file: path.join(runsDir, last), data: JSON.parse(fs.readFileSync(path.join(runsDir, last), "utf8")) };
  }

  async runSuites(suites: Suite[]): Promise<SuiteResult[]> {
    const results: SuiteResult[] = [];
    for (const suite of suites) results.push(await this.runSuite(suite));
    this.emit({ type: "done", results });
    return results;
  }

  private async runStep(suite: string, step: Step): Promise<StepResult> {
    try {
      if ("send" in step) return await this.doSend(suite, step);
      if ("dbAssert" in step) return this.doDbAssert(suite, step);
      if ("delayMs" in step) {
        await sleep(step.delayMs);
        return { suite, stepId: step.id, ok: true, detail: `waited ${step.delayMs} ms` };
      }
      // Unreachable for a typed Step (validateSuite enforces exactly one
      // kind); kept as a runtime guard for malformed JSON.
      const id = (step as { id?: string }).id ?? "?";
      return { suite, stepId: id, ok: false, detail: "unknown step kind" };
    } catch (e) {
      return { suite, stepId: step.id, ok: false, detail: (e as Error).message };
    }
  }

  private async doSend(suite: string, step: SendStep): Promise<StepResult> {
    const { to, msg, fields } = step.send;
    const conn = this.conns[to];
    if (!conn) return { suite, stepId: step.id, ok: false, detail: `no connection to ${to}` };

    const m = codec.findMessage(to, msg);
    const payload = codec.pack(to, msg, fields);
    conn.send(m.id, payload);
    const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const frame = await conn.recv(timeout);

    const ackName = this.ackName(to, frame.msgId, m.response);
    const decoded = codec.unpack(to, ackName, frame.payload);
    const received = { msgId: frame.msgId, ack: ackName, fields: decoded };

    if (frame.msgId === 255) {
      return {
        suite,
        stepId: step.id,
        ok: false,
        detail: `ErrorAck: code ${decoded.code} "${decoded.detail}"`,
        received,
      };
    }
    if (step.expectAck) {
      const problems = matchAck(decoded, step.expectAck);
      if (problems.length > 0) {
        return { suite, stepId: step.id, ok: false, detail: problems.join("; "), received };
      }
    }
    const label = step.expectAck
      ? `ack ${ackName} matches ${JSON.stringify(step.expectAck)}`
      : `ack ${ackName} received`;
    return { suite, stepId: step.id, ok: true, detail: label, received };
  }

  private doDbAssert(suite: string, step: DbAssertStep): StepResult {
    const { sql, params, expect } = step.dbAssert;
    const problems = checkRow(this.db, sql, params ?? [], expect);
    if (problems.length > 0) {
      return { suite, stepId: step.id, ok: false, detail: problems.join("; ") };
    }
    return { suite, stepId: step.id, ok: true, detail: `row matches ${JSON.stringify(expect)}` };
  }

  /** Map a received msgId to its registry name (handles ErrorAck 255). */
  private ackName(proc: string, msgId: number, expectedResponse: number): string {
    void expectedResponse; // registry cross-check happens in the CLI sanity pass
    const names: Record<number, string> = {};
    for (const m of codec.getProc(proc).messages) names[m.id] = m.name;
    return names[msgId] ?? `msgId_${msgId}`;
  }
}

/** Partial field match: only listed fields are validated. */
export function matchAck(
  got: Record<string, FieldValue>,
  want: Record<string, FieldValue>,
): string[] {
  const problems: string[] = [];
  for (const [field, expected] of Object.entries(want)) {
    if (!(field in got)) problems.push(`missing field ${field}`);
    else if (got[field] !== expected)
      problems.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got[field])}`);
  }
  return problems;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
