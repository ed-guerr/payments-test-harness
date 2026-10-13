/**
 * eval/replay.ts — deterministic regression gate on the agent surface.
 *
 * Replays recorded agent tool-call traces (src/eval/traces/*.json) against
 * the live MCP server, asserting *properties* of each result instead of
 * pinning full text. Zero LLM involved, so it runs in CI on every push:
 * it catches tool renames, schema/arg changes, KB content regressions
 * (the `notes` pin on get_message_schema), error-message wording changes
 * (the kbHints surface), and runner/cluster regressions on those exact
 * suites — the same failure classes that would silently break a real agent.
 *
 *   npm run eval:replay     (part of `npm run verify`)
 *
 * Trace format: { id, source, noKb, calls: [{ tool, args, expect }], cleanup? }
 *   expect.ok: true  -> the tool must not error (default)
 *   expect.ok: false -> the tool MUST error, and errorContains are checked
 *   expect.contains / notContains -> substring properties on the result text
 *   cleanup: suite names to delete after the trace (via MCP delete_suite)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../backend/paths";

export interface TraceExpect {
  ok?: boolean;
  contains?: string[];
  notContains?: string[];
  errorContains?: string[];
}

export interface TraceCall {
  tool: string;
  args: Record<string, unknown>;
  expect: TraceExpect;
}

export interface Trace {
  id: string;
  source: string;
  noKb: boolean;
  calls: TraceCall[];
  cleanup?: string[];
}

function toolResultText(r: CallToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function envFor(noKb: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.MCP_NO_KB = noKb ? "1" : "0";
  return env;
}

export async function replayTrace(client: Client, trace: Trace): Promise<string[]> {
  const failures: string[] = [];
  const tools = (await client.listTools()).tools.map((t) => t.name);
  if (trace.noKb && tools.includes("kb_search")) {
    failures.push("kb_search present in a noKb trace — MCP_NO_KB switch broken");
  }
  if (!trace.noKb && !tools.includes("kb_search")) {
    failures.push("kb_search missing in a KB trace — MCP_NO_KB switch broken");
  }
  for (let i = 0; i < trace.calls.length; i++) {
    const call = trace.calls[i];
    if (call === undefined) continue;
    const e = call.expect;
    let isError = false;
    let text = "";
    try {
      const r = (await client.callTool({ name: call.tool, arguments: call.args })) as unknown as CallToolResult;
      isError = r.isError === true;
      text = toolResultText(r);
    } catch (err) {
      isError = true;
      text = err instanceof Error ? err.message : String(err);
    }
    const wantOk = e.ok !== false;
    if (isError !== !wantOk) {
      failures.push(`call ${i + 1} (${call.tool}): expected ${wantOk ? "ok" : "error"}, got ${isError ? "error" : "ok"}: ${text.slice(0, 120)}`);
    }
    for (const s of e.contains ?? []) {
      if (!text.includes(s)) failures.push(`call ${i + 1} (${call.tool}): result missing "${s}"`);
    }
    for (const s of e.notContains ?? []) {
      if (text.includes(s)) failures.push(`call ${i + 1} (${call.tool}): result unexpectedly contains "${s}"`);
    }
    for (const s of e.errorContains ?? []) {
      if (!text.includes(s)) failures.push(`call ${i + 1} (${call.tool}): error text missing "${s}"`);
    }
  }
  for (const name of trace.cleanup ?? []) {
    try {
      await client.callTool({ name: "delete_suite", arguments: { name } });
    } catch {
      /* the suite may not exist; the trace itself already failed if it should */
    }
  }
  return failures;
}

export async function replayAll(tracesDir: string): Promise<{ total: number; failedTraces: number; failures: string[] }> {
  const files = fs
    .readdirSync(tracesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const all: string[] = [];
  let failedTraces = 0;
  for (const f of files) {
    const trace = JSON.parse(fs.readFileSync(path.join(tracesDir, f), "utf8")) as Trace;
    const tsxCli = path.join(packageRoot(), "node_modules", "tsx", "dist", "cli.mjs");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, path.join(packageRoot(), "src", "mcp", "server.ts")],
      cwd: packageRoot(),
      env: envFor(trace.noKb),
    });
    const client = new Client({ name: "eval-replay", version: "0" });
    try {
      await client.connect(transport);
      const failures = await replayTrace(client, trace);
      if (failures.length > 0) {
        failedTraces++;
        for (const msg of failures) all.push(`[${trace.id}] ${msg}`);
        console.error(`[replay] FAIL ${trace.id}: ${failures.length} problem(s)`);
      } else {
        console.log(`[replay] ok   ${trace.id} (${trace.calls.length} calls, kb ${trace.noKb ? "off" : "on"})`);
      }
    } finally {
      await client.close();
    }
  }
  return { total: files.length, failedTraces, failures: all };
}

/** Standalone entry: npm run eval:replay */
if (process.argv[1] && process.argv[1].endsWith("replay.ts")) {
  const tracesDir = path.join(packageRoot(), "src", "eval", "traces");
  replayAll(tracesDir)
    .then((r) => {
      for (const f of r.failures) console.error(`[replay]   ${f}`);
      if (r.failedTraces > 0) {
        console.error(`[replay] ${r.failedTraces}/${r.total} traces failed`);
        process.exit(1);
      }
      console.log(`[replay] all ${r.total} traces green (deterministic; no LLM)`);
    })
    .catch((e) => {
      console.error("[replay] error:", e);
      process.exit(1);
    });
}
