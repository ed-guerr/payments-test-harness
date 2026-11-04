/**
 * scripts/run-mutants.ts — kill matrix for the injected backend faults.
 *
 * The backend can be built with faults compiled in (`make FAULTS=1`);
 * one fault is selected at runtime with PAY_FAULT=<name>. This script:
 *   1. ensures a FAULTS=1 build exists (runs `make -s FAULTS=1`),
 *   2. runs every committed suite once with no fault (baseline),
 *   3. runs every committed suite once per fault (fresh cluster + fresh
 *      database per run, backend logs silenced),
 *   4. writes the kill matrix to artifacts/eval/sample-mutants.md:
 *      which suites kill which faults, and — for every fault that
 *      survives all suites — what actually pins it (smoke-test check,
 *      code review, ...). Survivors are reported as-is; the notes are
 *      claims to keep honest, not a pass/fail gate.
 *
 *   npm run eval:mutants
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendCluster } from "../src/backend/cluster";
import { backendBuildDir, SUITES_DIR } from "../src/backend/paths";
import { listSuites, loadSuite } from "../src/backend/suites";
import { Runner } from "../src/runner/runner";
import type { SuiteResult } from "../src/runner/runner";

const HARN = path.resolve(__dirname, "..");
const BACKEND = path.resolve(HARN, "..", "backend");
const OUT = path.resolve(HARN, "..", "artifacts", "eval", "sample-mutants.md");

/* The eight faults (backend/include/pay/faults.h + the fault sites).
 * "business" = a plausible business-logic regression; "real-bug" = a
 * one-line revert of an actual bug found and fixed in this codebase. */
const FAULTS: { name: string; kind: "business" | "real-bug"; desc: string }[] = [
  { name: "skip_forward", kind: "business", desc: "Authorize approves but never forwards CompletePayment (payment stays open)" },
  { name: "settle_wrong_acct", kind: "business", desc: "Settle moves the amount into ACCT-002 instead of the reserve" },
  { name: "double_settle_ok", kind: "business", desc: "the already-settled check is skipped, so a second Settle is not rejected as settled" },
  { name: "reverse_noop", kind: "business", desc: "ReverseTransfer is acked TR_OK without touching the ledger" },
  { name: "skip_balance_check", kind: "real-bug", desc: "db_transfer debits with no sufficiency guard — the pre-fix check-then-act race (clamped by the fix's non-negative backstop)" },
  { name: "oob_copy", kind: "real-bug", desc: "unbounded 16-byte copies of sqlite text columns — the pre-fix out-of-bounds read" },
  { name: "no_field_validation", kind: "real-bug", desc: "dispatch skips wire-field validation (unterminated strings, out-of-range amounts)" },
  { name: "db_error_as_no_entry", kind: "real-bug", desc: "a reverse db error is reported as the business status TR_NO_ENTRY instead of ErrorAck" },
];

/* What pins a fault if no committed suite kills it. Only used when the
 * run actually shows the fault surviving; a wrong note is a bug here. */
const SURVIVOR_PINS: Record<string, string> = {
  oob_copy:
    "code review — the overrun stays inside SQLite's own heap block, so the ASan build does not flag it either",
  no_field_validation:
    "smoke_test.py malformed-frame checks (the committed suites only send well-formed frames via the codec)",
  db_error_as_no_entry: "smoke_test.py db-error check (no committed suite forces a db-layer error)",
};

async function runSuite(binDir: string, tmpDb: string, suiteName: string): Promise<SuiteResult> {
  const cluster = await BackendCluster.start(binDir, tmpDb, () => {});
  const runner = new Runner(cluster.conns, cluster.db, () => {}, {
    reportsDir: "",
    killProcess: (p, s) => cluster.kill(p, s),
  });
  try {
    return await runner.runSuite(loadSuite(path.join(SUITES_DIR(), `${suiteName}.json`)));
  } finally {
    await cluster.stop();
  }
}

async function main(): Promise<void> {
  execSync("make -s FAULTS=1", { cwd: BACKEND, stdio: "pipe" });
  const binDir = backendBuildDir();
  const suites = listSuites()
    .map((m) => m.name)
    .filter((s) => s !== "assertion-failure-demo"); // intentionally red; excluded
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mutants-"));
  const results: Record<string, Record<string, boolean>> = {}; // fault|null -> suite -> red?

  try {
    const all = [null, ...FAULTS.map((f) => f.name)];
    for (const fault of all) {
      if (fault) process.env.PAY_FAULT = fault;
      else delete process.env.PAY_FAULT;
      results[fault ?? "baseline"] = {};
      for (const s of suites) {
        const dbFile = path.join(work, `${(fault ?? "baseline")}-${s}.db`);
        const r = await runSuite(binDir, dbFile, s);
        results[fault ?? "baseline"][s] = !r.ok;
        const tag = fault ?? "baseline";
        console.log(`${tag.padEnd(22)} ${s.padEnd(24)} ${r.ok ? "green" : "RED"}`);
      }
    }
  } finally {
    delete process.env.PAY_FAULT;
    fs.rmSync(work, { recursive: true, force: true });
  }

  const base = results["baseline"];
  const killedBy = (fault: string): string[] => suites.filter((s) => results[fault][s]);

  const L: string[] = [];
  L.push("# Fault kill matrix");
  L.push("");
  L.push(
    `Generated by \`npm run eval:mutants\` on ${new Date().toISOString().slice(0, 10)} — every committed suite (excluding the intentionally red \`assertion-failure-demo\`) run against a FAULTS=1 backend build, once per fault.`,
  );
  L.push("");
  L.push("## Faults");
  L.push("");
  L.push(
    "Eight one-line faults, compiled only with `make FAULTS=1` (`-DPAY_FAULTS`), selected at runtime with `PAY_FAULT=<name>`. Four are business-logic regressions; four are literal reverts of real bugs found and fixed in this codebase (each revert is the pre-fix behavior, in one place).",
  );
  L.push("");
  L.push("| fault | kind | description |");
  L.push("|---|---|---|");
  for (const f of FAULTS) L.push(`| \`${f.name}\` | ${f.kind} | ${f.desc} |`);
  L.push("");
  L.push("## Kill matrix");
  L.push("");
  L.push("A cell is ✓ when the suite fails (kills the fault).");
  L.push("");
  const header = "| fault | " + suites.join(" | ") + " | killed by |";
  const sep = "|---|" + suites.map(() => "---|").join("");
  L.push(header);
  L.push(sep);
  for (const f of FAULTS) {
    const killers = killedBy(f.name);
    L.push(
      `| \`${f.name}\` | ${suites.map((s) => (results[f.name][s] ? "✓" : "—")).join(" | ")} | ${
        killers.length ? killers.join(", ") : "**survivor**"
      } |`,
    );
  }
  L.push("");
  const killedCount = FAULTS.filter((f) => killedBy(f.name).length > 0).length;
  L.push(`**${killedCount}/${FAULTS.length} faults killed** by the committed suites.`);
  L.push("");
  L.push("## Survivors — what actually pins them");
  L.push("");
  L.push(
    "A fault surviving every suite is not automatically a gap in the suite: some of these bugs are only observable through inputs or states the committed suites never produce. The table says what pins each survivor in this repo:",
  );
  L.push("");
  const survivors = FAULTS.filter((f) => killedBy(f.name).length === 0);
  if (survivors.length === 0) {
    L.push("None — every fault is killed by at least one committed suite.");
  } else {
    L.push("| fault | survives all of | pinned by |");
    L.push("|---|---|---|");
    for (const f of survivors) {
      const pin = SURVIVOR_PINS[f.name];
      if (!pin) throw new Error(`no pin recorded for surviving fault ${f.name} — add one or a suite`);
      L.push(`| \`${f.name}\` | ${suites.length} suites | ${pin} |`);
    }
  }
  L.push("");
  L.push("## Baseline (no fault)");
  L.push("");
  const baseRed = suites.filter((s) => base[s]);
  L.push(
    baseRed.length === 0
      ? `All ${suites.length} suites green without a fault.`
      : `Unexplained red without a fault: ${baseRed.join(", ")} — the build or the suites are broken.`,
  );
  L.push("");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, L.join("\n"));
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
