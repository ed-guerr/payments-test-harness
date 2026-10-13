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
 *   killProcess — chaos: SIGKILL/SIGTERM a backend process mid-suite
 *
 * Send steps also support expectError: assert that the send fails
 * (transport error or ErrorAck) — for testing failure modes.
 *
 * The runner is Electron-free: it emits JSON events through a callback, so
 * the CLI prints them and the Electron UI subscribes to the same events.
 */
import fs from "node:fs";
import path from "node:path";
import { REPORTS_DIR } from "../backend/paths";
import { checkRow, Db } from "../db/db";
import * as codec from "../protocol/codec";
import type { Conn } from "../protocol/conn";
import type { FieldValue, Frame } from "../protocol/types";
import { writeHtmlReport } from "./report";

export interface SendStep {
  id: string;
  send: { to: string; msg: string; fields: Record<string, FieldValue> };
  expectAck?: Record<string, FieldValue>;
  /** When true, the step passes if the send fails (transport error or ErrorAck). */
  expectError?: boolean;
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

export interface KillStep {
  id: string;
  killProcess: { proc: string; signal?: "SIGKILL" | "SIGTERM" };
}

export type Step = SendStep | DbAssertStep | DelayStep | KillStep;

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

/** Per-step timing, relative to the suite start (steps run sequentially). */
export interface StepTiming {
  /** ms from suite start when the step began */
  startedAtMs: number;
  /** how long the step took, including any delayMs sleep */
  durationMs: number;
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
  | ((StepResult & StepTiming) & { type: "step-result" })
  | (SuiteResult & { type: "suite-result" })
  | { type: "done"; results: SuiteResult[] };

export const DEFAULT_TIMEOUT_MS = 2000;

export interface RunnerOptions {
  /** When set, each finished run is persisted to <runsDir>/<suite>-<ts>.json. */
  runsDir?: string;
  /** Chaos: kill a backend process mid-suite. True if a live process was killed. */
  killProcess?: (proc: string, signal: NodeJS.Signals) => boolean;
  /**
   * Each finished run also writes a self-contained HTML report to
   * <reportsDir>/<suite>_<ts>.html. Defaults to <repo>/docs/test-runs;
   * pass "" to disable.
   */
  reportsDir?: string;
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
    const steps: (StepResult & StepTiming)[] = [];
    let passed = 0;
    let failed = 0;
    for (const step of suite.steps) {
      const startedAtMs = Date.now() - t0;
      const base = await this.runStep(suite.name, step);
      const r: StepResult & StepTiming = { ...base, startedAtMs, durationMs: Date.now() - t0 - startedAtMs };
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
    // One timestamp for both artifacts so the run JSON and the HTML report
    // pair up by name.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const at = new Date().toISOString();
    this.persistRun(result, steps, ts, at);
    this.writeReport(suite, result, steps, ts, at);
    return result;
  }

  private persistRun(result: SuiteResult, steps: (StepResult & StepTiming)[], ts: string, at: string): void {
    if (!this.opts.runsDir) return;
    try {
      fs.mkdirSync(this.opts.runsDir, { recursive: true });
      const file = path.join(this.opts.runsDir, `${result.suite}-${ts}.json`);
      fs.writeFileSync(file, JSON.stringify({ at, ...result, steps }, null, 2) + "\n");
    } catch {
      // persisting is best-effort; never fail a run because of it
    }
  }

  /** Best-effort HTML report; a report failure must never fail a run. */
  private writeReport(
    suite: Suite,
    result: SuiteResult,
    steps: (StepResult & StepTiming)[],
    ts: string,
    at: string,
  ): void {
    const dir = this.opts.reportsDir ?? REPORTS_DIR();
    if (!dir) return;
    try {
      writeHtmlReport({ suite, result, steps, at }, dir, ts);
    } catch {
      // reports are best-effort; never fail a run because of them
    }
  }

  /** Latest persisted run for a suite (or the latest overall when name is null). */
  static latestRun(runsDir: string, suite?: string): { file: string; data: unknown } | null {
    const files = fs
      .readdirSync(runsDir)
      .filter((f) => {
        if (!f.endsWith(".json")) return false;
        if (suite) {
          // "<suite>-" must be followed by a timestamp digit, so a sibling
          // suite whose name extends this one (no-double-settle-minimal)
          // doesn't match no-double-settle's runs.
          if (!f.startsWith(`${suite}-`)) return false;
          if (!/^\d/.test(f.slice(suite.length + 1))) return false;
        }
        return true;
      })
      .sort(); // ISO timestamps in the filename sort chronologically
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
      if ("killProcess" in step) return this.doKill(suite, step);
      // Unreachable for a typed Step (validateSuite enforces exactly one
      // kind); kept as a runtime guard for malformed JSON.
      const id = (step as { id?: string }).id ?? "?";
      return { suite, stepId: id, ok: false, detail: "unknown step kind" };
    } catch (e) {
      return { suite, stepId: step.id, ok: false, detail: (e as Error).message };
    }
  }

  /** Chaos: kill a backend process mid-suite. The cluster owns the child
   * processes; the runner only holds the injected capability. */
  private doKill(suite: string, step: KillStep): StepResult {
    const { proc, signal = "SIGKILL" } = step.killProcess;
    if (!this.opts.killProcess) {
      return { suite, stepId: step.id, ok: false, detail: "killProcess not supported in this context" };
    }
    const killed = this.opts.killProcess(proc, signal);
    return {
      suite,
      stepId: step.id,
      ok: killed,
      detail: killed ? `killed ${proc} (${signal})` : `no live process to kill: ${proc}`,
    };
  }

  private async doSend(suite: string, step: SendStep): Promise<StepResult> {
    const { to, msg, fields } = step.send;
    const conn = this.conns[to];
    if (!conn) {
      const detail = `no connection to ${to}`;
      return step.expectError
        ? { suite, stepId: step.id, ok: true, detail: `failed as expected: ${detail}` }
        : { suite, stepId: step.id, ok: false, detail };
    }
    if (conn.destroyed) {
      const detail = `connection to ${to} is closed`;
      return step.expectError
        ? { suite, stepId: step.id, ok: true, detail: `failed as expected: ${detail}` }
        : { suite, stepId: step.id, ok: false, detail };
    }

    const m = codec.findMessage(to, msg);
    const payload = codec.pack(to, msg, fields);
    const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let frame: Frame;
    try {
      conn.send(m.id, payload);
      frame = await conn.recv(timeout);
    } catch (e) {
      if (!step.expectError) throw e;
      return { suite, stepId: step.id, ok: true, detail: `failed as expected: ${(e as Error).message}` };
    }

    const ackName = this.ackName(to, frame.msgId, m.response);
    const decoded = codec.unpack(to, ackName, frame.payload);
    const received = { msgId: frame.msgId, ack: ackName, fields: decoded };

    if (frame.msgId === 255) {
      const detail = `ErrorAck: code ${decoded.code} "${decoded.detail}"`;
      return step.expectError
        ? { suite, stepId: step.id, ok: true, detail: `failed as expected: ${detail}`, received }
        : { suite, stepId: step.id, ok: false, detail, received };
    }
    if (step.expectAck) {
      const problems = matchAck(decoded, step.expectAck);
      if (problems.length > 0) {
        return { suite, stepId: step.id, ok: false, detail: problems.join("; "), received };
      }
    }
    if (step.expectError) {
      return { suite, stepId: step.id, ok: false, detail: `expected error but got ack ${ackName}`, received };
    }
    const label = step.expectAck
      ? `ack ${ackName} matches ${JSON.stringify(step.expectAck)}`
      : `ack ${ackName} received`;
    return { suite, stepId: step.id, ok: true, detail: label, received };
  }

  private doDbAssert(suite: string, step: DbAssertStep): StepResult {
    const { sql, params, expect } = step.dbAssert;
    const { problems, row } = checkRow(this.assertDb(), sql, params ?? [], expect);
    // Attach the actual row so reports can show expected vs actual per column.
    const received = { sql, row };
    if (problems.length > 0) {
      return { suite, stepId: step.id, ok: false, detail: problems.join("; "), received };
    }
    return { suite, stepId: step.id, ok: true, detail: `row matches ${JSON.stringify(expect)}`, received };
  }

  /**
   * Read-only view used for dbAssert: suite SQL is agent-authored, so the
   * assertion path must be structurally incapable of mutating the database
   * (the runner's own handle is the cluster's read-write connection).
   */
  private roDb: Db | null = null;
  private assertDb(): Db {
    if (!this.roDb) this.roDb = Db.readOnly(this.db.file);
    return this.roDb;
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
