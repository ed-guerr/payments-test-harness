#!/usr/bin/env node
/**
 * clean-runs.js — prune generated per-run artifacts under <repo>/artifacts/.
 *
 * Usage: npm run runs:clean [-- --days N --keep N --dry-run]
 *   --days N   prune files strictly older than N days (default 7)
 *   --keep N   per directory, always keep the N newest files (default 500)
 *   --dry-run  report what would be deleted, delete nothing
 *
 * A file is deleted only if it is BOTH older than --days AND outside the
 * newest --keep. Targets are the three per-run artifact dirs:
 *   artifacts/suite-runs/  (run JSONs from every run_suite caller)
 *   artifacts/test-reports/ (self-contained HTML run reports)
 *   artifacts/eval/runs/   (independent rerun JSONs backing eval reports)
 * Never touches experiment report files (artifacts/eval/*.json|md),
 * committed samples (artifacts/eval/sample-*), or anything else.
 */
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const opts = { days: 7, keep: 500, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} needs a value`);
      return v;
    };
    if (a === "--days") opts.days = Number(next());
    else if (a === "--keep") opts.keep = Number(next());
    else if (a === "--dry-run") opts.dryRun = true;
    else throw new Error(`unknown flag ${a} (see header of clean-runs.js)`);
  }
  if (!Number.isFinite(opts.days) || opts.days < 0) throw new Error(`--days must be >= 0 (got ${opts.days})`);
  if (!Number.isInteger(opts.keep) || opts.keep < 0) throw new Error(`--keep must be a non-negative integer (got ${opts.keep})`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(__dirname, "..", "..");
const targets = [
  path.join(repoRoot, "artifacts", "suite-runs"),
  path.join(repoRoot, "artifacts", "test-reports"),
  path.join(repoRoot, "artifacts", "eval", "runs"),
];
const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000;

let totalFiles = 0;
let totalBytes = 0;
for (const dir of targets) {
  if (!fs.existsSync(dir)) continue;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { file: path.join(dir, e.name), mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const deletable = entries.slice(opts.keep).filter((f) => f.mtimeMs < cutoff);
  for (const f of deletable) {
    if (!opts.dryRun) fs.rmSync(f.file);
    totalFiles += 1;
    totalBytes += f.size;
  }
  console.log(
    `[runs:clean] ${path.relative(repoRoot, dir)}: ${entries.length} file(s), ${deletable.length} deleted` +
      (opts.dryRun ? " (dry-run)" : "") +
      ` (days=${opts.days}, keep=${opts.keep})`,
  );
}
console.log(
  `[runs:clean] total: ${totalFiles} file(s), ${(totalBytes / 1024 / 1024).toFixed(2)} MB ${opts.dryRun ? "would be deleted" : "deleted"}`,
);
