/**
 * runner/cli.ts — headless execution: `npm run run:cli -- <suite|dir>`.
 *
 * Self-contained: for each suite it initializes a fresh database, starts the
 * three backend processes, runs the suite, prints results, and tears
 * everything down. With --json it prints one JSON event per line on stdout
 * (backend logs go to stderr).
 */
import path from "node:path";
import { BackendCluster } from "../backend/cluster";
import { backendBuildDir, DATA_DIR, SUITES_DIR } from "../backend/paths";
import { listSuites, loadSuite } from "../backend/suites";
import { Runner } from "./runner";
import type { RunnerEvent, Suite, SuiteResult } from "./runner";

interface Options {
  targets: string[];
  json: boolean;
  binDir: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { targets: [], json: false, binDir: backendBuildDir() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--bin-dir") opts.binDir = path.resolve(argv[++i] as string);
    else opts.targets.push(a);
  }
  return opts;
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
  const suites: Suite[] =
    opts.targets.length === 0
      ? listSuites().map((m) => loadSuite(path.join(SUITES_DIR(), `${m.name}.json`)))
      : opts.targets.map((t) => loadSuite(path.resolve(t)));

  const results: SuiteResult[] = [];
  for (const suite of suites) {
    const cluster = await BackendCluster.start(opts.binDir, path.join(DATA_DIR(), `${suite.name}.db`), (p, line) =>
      process.stderr.write(`[${p}] ${line}\n`),
    );
    const runner = new Runner(cluster.conns, cluster.db, (e) => printEvent(e, opts.json));
    try {
      results.push(await runner.runSuite(suite));
    } finally {
      await cluster.stop();
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
