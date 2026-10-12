/**
 * runner/cli.ts — headless execution: `npm run run:cli -- <suite|dir>`.
 *
 * Self-contained: initializes a fresh database, starts the three backend
 * processes, runs the suite(s), prints results, and tears everything down.
 * With --json it prints one JSON event per line (machine-readable).
 */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Db } from "../db/db";
import * as codec from "../protocol/codec";
import { Conn } from "../protocol/conn";
import { Runner, sleep } from "./runner";
import type { RunnerEvent, Suite, SuiteResult } from "./runner";

const ROOT = path.join(__dirname, "..", "..", "..");
const SUITES_DIR = path.join(__dirname, "..", "..", "suites");

interface Options {
  targets: string[];
  json: boolean;
  binDir: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { targets: [], json: false, binDir: path.join(ROOT, "backend", "build") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--bin-dir") opts.binDir = path.resolve(argv[++i] as string);
    else opts.targets.push(a);
  }
  return opts;
}

function loadSuites(targets: string[]): Suite[] {
  let files: string[];
  if (targets.length === 0) {
    files = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(SUITES_DIR, f));
  } else {
    files = targets.map((t) => path.resolve(t));
  }
  return files.map((f) => {
    const s = JSON.parse(fs.readFileSync(f, "utf8")) as Suite;
    validateSuite(s);
    return s;
  });
}

/** Cheap structural validation; zod schemas replace this when the MCP server lands. */
function validateSuite(s: Suite): void {
  if (typeof s.name !== "string" || !Array.isArray(s.steps)) throw new Error("suite must have name + steps[]");
  s.steps.forEach((step, i) => {
    if (typeof step.id !== "string") throw new Error(`step ${i}: missing id`);
    const kinds = ["send", "dbAssert", "delayMs"].filter((k) => k in step);
    if (kinds.length !== 1) throw new Error(`step ${i} (${step.id}): expected exactly one of send|dbAssert|delayMs`);
    if ("send" in step) {
      const { to, msg, fields } = step.send;
      codec.findMessage(to, msg); // throws if unknown process/message
      codec.pack(to, msg, fields); // throws if fields are missing
    }
  });
}

interface Backend {
  procs: Record<string, ChildProcess>;
  db: Db;
  conns: Record<string, Conn>;
}

/**
 * One backend cluster per suite: suites are independent, so each gets a
 * fresh database (data/<suite>.db, kept after the run for inspection) and
 * its own process trio. This mirrors how the smoke test runs.
 */
async function startBackends(binDir: string, label: string): Promise<Backend> {
  const dbFile = path.join(__dirname, "..", "..", "data", `${label}.db`);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
  const db = Db.open(dbFile);

  const procs: Record<string, ChildProcess> = {};
  const conns: Record<string, Conn> = {};
  try {
    for (const proc of codec.listProcs()) {
      const bin = path.join(binDir, proc);
      if (!fs.existsSync(bin)) throw new Error(`missing backend binary ${bin} — run \`make\` in backend/`);
      const child = spawn(bin, ["--db", dbFile], { stdio: ["ignore", "pipe", "pipe"] });
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${proc}] ${d}`));
      procs[proc] = child;
    }
    for (const proc of codec.listProcs()) {
      const port = Number(codec.getProc(proc).listen.split(":")[1]);
      conns[proc] = await waitForConn(port, 5000);
    }
    return { procs, db, conns };
  } catch (e) {
    for (const c of Object.values(conns)) c.close();
    for (const p of Object.values(procs)) p.kill("SIGKILL");
    db.close();
    throw e;
  }
}

async function waitForConn(port: number, timeoutMs: number): Promise<Conn> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await Conn.connect(port);
    } catch {
      if (Date.now() > deadline) throw new Error(`process on port ${port} not reachable within ${timeoutMs} ms`);
      await sleep(100);
    }
  }
}

function teardown(b: Backend): void {
  for (const c of Object.values(b.conns)) c.close();
  for (const [name, p] of Object.entries(b.procs)) {
    p.kill("SIGKILL");
    process.stderr.write(`stopped ${name}\n`);
  }
  b.db.close();
}

function printEvent(e: RunnerEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(e));
    return;
  }
  switch (e.type) {
    case "suite-start":
      console.log(`\n=== ${e.suite} ===`);
      break;
    case "step-result":
      console.log(`  ${e.ok ? "PASS" : "FAIL"}  ${e.stepId}  ${e.detail}`);
      break;
    case "suite-result":
      console.log(`  ${e.ok ? "✓" : "✗"} ${e.suite}: ${e.passed} passed, ${e.failed} failed (${e.durationMs} ms)`);
      break;
    case "done":
      break;
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const suites = loadSuites(opts.targets);

  const results: SuiteResult[] = [];
  for (const suite of suites) {
    const backend = await startBackends(opts.binDir, suite.name);
    const runner = new Runner(backend.conns, backend.db, (e) => printEvent(e, opts.json));
    for (const c of Object.values(backend.conns)) c.on("error", () => undefined); // failures surface via recv()
    try {
      results.push(await runner.runSuite(suite));
    } finally {
      teardown(backend);
    }
  }

  if (!opts.json) {
    console.log(`\nsummary: ${results.filter((r) => r.ok).length}/${results.length} suites passed`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
