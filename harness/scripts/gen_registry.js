#!/usr/bin/env node
/*
 * gen_registry.js — single source of truth for the wire protocol.
 *
 * Runs each backend binary with --introspect (which prints the compiled
 * function-pointer message tables as JSON) and merges the output into
 * src/protocol/registry.json. Everything downstream — the codec, the UI
 * forms, the runner, the MCP tool schemas — is generated from this file.
 *
 * Usage: npm run gen:registry   (after `make` in backend/)
 */
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const backendBuild = path.join(root, "backend", "build");
const PROCS = ["pay-orders", "ledger", "auth-gateway"];
const outPath = path.join(__dirname, "..", "src", "protocol", "registry.json");

const registry = {
  generatedAt: new Date().toISOString(),
  procs: {},
};

for (const proc of PROCS) {
  const bin = path.join(backendBuild, proc);
  if (!fs.existsSync(bin)) {
    console.error(`missing binary ${bin} — run \`make\` in backend/ first`);
    process.exit(1);
  }
  const out = execFileSync(bin, ["--introspect"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  if (parsed.process !== proc) {
    console.error(`${proc}: introspect reported name "${parsed.process}"`);
    process.exit(1);
  }
  registry.procs[proc] = parsed;
  const n = parsed.messages.length;
  console.log(`  ${proc}: ${n} messages`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + "\n");
console.log(`wrote ${path.relative(root, outPath)}`);
