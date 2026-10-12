/**
 * mcp/server.ts — Model Context Protocol server for the payments test
 * harness (stdio transport).
 *
 * This is how an AI agent authors and runs tests: it introspects the wire
 * protocol from the registry, reads the database, composes suite JSON
 * (validated against the registry before it is written), and executes suites
 * against a fresh backend cluster.
 *
 * Run: npm run mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { BackendCluster } from "../backend/cluster";
import {
  backendBuildDir,
  DATA_DIR,
  packageRoot,
  RUNS_DIR,
  SUITES_DIR,
} from "../backend/paths";
import { listSuites, loadSuite, validateSuite } from "../backend/suites";
import { Db } from "../db/db";
import { Runner } from "../runner/runner";
import type { Suite } from "../runner/runner";
import * as codec from "../protocol/codec";
import type { Registry } from "../protocol/types";
import registryJson from "../protocol/registry.json";

const registry = registryJson as unknown as Registry;

const server = new McpServer({ name: "payments-test-harness", version: "0.1.0" });

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

function suiteFile(name: string): string {
  // Names come from list_suites or an agent-supplied id; allow only safe ids.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`unsafe suite name: ${name}`);
  return path.join(SUITES_DIR(), `${name}.json`);
}

/* ------------------------------------------------------------------ */
/* Protocol introspection                                              */
/* ------------------------------------------------------------------ */

server.registerTool(
  "list_processes",
  { description: "List the backend processes and their listen addresses.", inputSchema: {} },
  () =>
    text(
      Object.fromEntries(
        Object.entries(registry.procs).map(([p, d]) => [p, { listen: d.listen, messages: d.messages.length }]),
      ),
    ),
);

server.registerTool(
  "list_messages",
  {
    description: "List all messages of a process with ids, directions, and sizes.",
    inputSchema: { process: z.string().describe("Process name: pay-orders | ledger | auth-gateway") },
  },
  ({ process: proc }) => {
    const d = registry.procs[proc];
    if (!d) throw new Error(`unknown process ${proc}`);
    return text(d.messages.map((m) => ({ id: m.id, name: m.name, direction: m.direction, size: m.size })));
  },
);

server.registerTool(
  "get_message_schema",
  {
    description:
      "Full wire schema for one message: id, direction, total size, fields with names, C types, sizes, and packed offsets. Use this to author correct send steps.",
    inputSchema: {
      process: z.string().describe("Process name: pay-orders | ledger | auth-gateway"),
      message: z.string().describe("Message name, e.g. CreatePayment"),
    },
  },
  ({ process: proc, message }) => text(codec.findMessage(proc, message)),
);

/* ------------------------------------------------------------------ */
/* Suites                                                              */
/* ------------------------------------------------------------------ */

server.registerTool("list_suites", { description: "List all test suites (name, description, step count).", inputSchema: {} }, () =>
  text(listSuites()),
);

server.registerTool(
  "get_suite",
  { description: "Read one test suite's full JSON.", inputSchema: { name: z.string() } },
  ({ name }) => text(loadSuite(suiteFile(name))),
);

const stepShape = z.object({ id: z.string().describe("Unique step id within the suite") }).passthrough();

server.registerTool(
  "create_suite",
  {
    description:
      "Author a new test suite and write it to harness/suites/<name>.json. Step kinds: " +
      '{id, send:{to,msg,fields},expectAck?,timeoutMs?} | {id, dbAssert:{sql,params?,expect}} | {id, delayMs}. ' +
      "The suite is validated against the protocol registry before writing (unknown messages or missing fields are rejected).",
    inputSchema: {
      name: z.string().describe("Suite id, e.g. wire-echo-test"),
      description: z.string().optional(),
      steps: z.array(stepShape).min(1),
    },
  },
  ({ name, description, steps }) => {
    const suite: Suite = { name, description, steps: steps as unknown as Suite["steps"] };
    validateSuite(suite);
    const file = suiteFile(name);
    fs.writeFileSync(file, JSON.stringify(suite, null, 2) + "\n");
    return text({ created: file, steps: suite.steps.length });
  },
);

server.registerTool(
  "update_suite",
  {
    description: "Replace an existing suite's steps (full replacement, validated like create_suite).",
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      steps: z.array(stepShape).min(1),
    },
  },
  ({ name, description, steps }) => {
    const existing = loadSuite(suiteFile(name));
    const suite: Suite = { name, description: description ?? existing.description, steps: steps as unknown as Suite["steps"] };
    validateSuite(suite);
    fs.writeFileSync(suiteFile(name), JSON.stringify(suite, null, 2) + "\n");
    return text({ updated: name, steps: suite.steps.length });
  },
);

server.registerTool(
  "delete_suite",
  {
    description: "Delete a suite file. Refuses to delete the four shipped sample suites.",
    inputSchema: { name: z.string() },
  },
  ({ name }) => {
    const PROTECTED = new Set(["payment-happy-path", "insufficient-funds", "cancel-payment", "assertion-failure-demo"]);
    if (PROTECTED.has(name)) throw new Error(`${name} is a shipped sample suite and is protected`);
    fs.rmSync(suiteFile(name), { force: true });
    return text({ deleted: name });
  },
);

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

async function runSuiteByName(name: string): Promise<unknown> {
  const suite = loadSuite(suiteFile(name));
  const cluster = await BackendCluster.start(backendBuildDir(), path.join(DATA_DIR(), `${name}.db`));
  const runner = new Runner(cluster.conns, cluster.db, () => undefined, { runsDir: RUNS_DIR() });
  try {
    const summary = await runner.runSuite(suite);
    const latest = Runner.latestRun(RUNS_DIR(), name);
    return { ...summary, file: latest?.file, steps: latest?.data };
  } finally {
    await cluster.stop();
  }
}

server.registerTool(
  "run_suite",
  {
    description:
      "Run one suite against a fresh backend cluster (new database + the three processes), return per-step results.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => text(await runSuiteByName(name)),
);

server.registerTool(
  "run_all_suites",
  {
    description: "Run every suite (fresh backend per suite). Note: assertion-failure-demo is designed to fail.",
    inputSchema: {},
  },
  async () => {
    const out: unknown[] = [];
    for (const s of listSuites()) out.push(await runSuiteByName(s.name));
    return text(out);
  },
);

server.registerTool(
  "get_run_results",
  {
    description: "Latest persisted run result for a suite (or the most recent run of any suite).",
    inputSchema: { name: z.string().optional() },
  },
  ({ name }) => text(Runner.latestRun(RUNS_DIR(), name) ?? { error: "no runs persisted yet — run a suite first" }),
);

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

server.registerTool(
  "db_schema",
  {
    description: "Schema of the harness databases (tables, columns, constraints) — from the backend's schema.sql.",
    inputSchema: {},
  },
  () => text(fs.readFileSync(path.join(packageRoot(), "..", "backend", "db", "schema.sql"), "utf8")),
);

server.registerTool(
  "db_query",
  {
    description:
      "Read-only SQL query against a per-suite database (a file in harness/data/, e.g. payment-happy-path.db). SELECT only; the connection is opened readonly.",
    inputSchema: {
      file: z.string().describe("Database file name in harness/data/"),
      sql: z.string().describe("A single SELECT statement"),
    },
  },
  ({ file, sql }) => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("only SELECT statements are allowed");
    if (!/^\S+\.db$/.test(file)) throw new Error(`bad db file name: ${file}`);
    const db = Db.readOnly(path.join(DATA_DIR(), file));
    try {
      return text(db.all(sql));
    } finally {
      db.close();
    }
  },
);

/* kb_search / kb_read are registered in mcp/kbTools.ts (knowledge base, P5). */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("mcp server failed:", e);
  process.exit(1);
});
