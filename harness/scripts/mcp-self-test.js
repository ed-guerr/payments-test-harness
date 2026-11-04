#!/usr/bin/env node
/*
 * mcp-self-test.js — drives the MCP server over stdio (JSON-RPC) to verify
 * the full agent workflow without a real MCP client:
 *   initialize -> tools/list -> create_suite -> run_suite -> db_query.
 * Exits 0 on success.
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const server = spawn(process.execPath, [require("node:path").join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "mcp", "server.ts")], {
  cwd: root,
  env: { ...process.env, MCP_NO_KB: process.env.MCP_NO_KB ?? "" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = Buffer.alloc(0);
const pending = new Map();
const nextId = { n: 1 };

server.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    // MCP stdio framing: newline-delimited JSON
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return;
    const line = buf.subarray(0, nl).toString("utf8");
    buf = buf.subarray(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId.n++;
  const req = { jsonrpc: "2.0", id, method, params };
  server.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => pending.set(id, { resolve }));
}

async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
  const t = res.result?.content?.[0]?.text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

(async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "self-test", version: "0.0.1" },
  });
  if (init.error) throw new Error("initialize failed: " + JSON.stringify(init.error));
  console.log(`initialize ok: server ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

  const list = await rpc("tools/list", {});
  const tools = list.result.tools.map((t) => t.name);
  console.log(`tools (${tools.length}): ${tools.join(", ")}`);
  const noKb = process.env.MCP_NO_KB === "1";
  const expected = ["list_processes", "list_messages", "get_message_schema", "list_suites", "get_suite", "create_suite", "update_suite", "delete_suite", "run_suite", "run_all_suites", "get_run_results", "db_schema", "db_query"];
  if (!noKb) expected.push("kb_search", "kb_read");
  for (const t of expected) {
    if (!tools.includes(t)) throw new Error(`missing tool ${t}`);
  }

  const schema = await callTool("get_message_schema", { process: "pay-orders", message: "CreatePayment" });
  if (schema.name !== "CreatePayment" || schema.size !== 28) throw new Error("bad CreatePayment schema");
  console.log("get_message_schema ok: CreatePayment 28B, fields:", schema.fields.map((f) => f.name).join(","));

  const suite = {
    name: "mcp-selftest-suite",
    description: "created by the MCP self-test",
    steps: [
      { id: "create", send: { to: "pay-orders", msg: "CreatePayment", fields: { txn_id: 4242, account: "ACCT-002", amount_cents: 1500, currency: "USD" } }, expectAck: { status: 0 } },
      { id: "cancel", send: { to: "pay-orders", msg: "CancelPayment", fields: { txn_id: 4242, reason: "mcp-test" } }, expectAck: { status: 0 } },
      { id: "assert", dbAssert: { sql: "SELECT status FROM payments WHERE txn_id = ?", params: [4242], expect: { status: "cancelled" } } },
    ],
  };
  await callTool("create_suite", suite);
  console.log("create_suite ok");

  const run = await callTool("run_suite", { name: "mcp-selftest-suite" });
  if (!run.ok || run.failed !== 0) throw new Error(`run_suite failed: ${JSON.stringify(run)}`);
  console.log(`run_suite ok: ${run.passed}/${run.passed + run.failed} steps`);

  const rows = await callTool("db_query", { file: "mcp-selftest-suite.db", sql: "SELECT status FROM payments WHERE txn_id = 4242" });
  if (!Array.isArray(rows) || rows[0]?.status !== "cancelled") throw new Error("db_query failed: " + JSON.stringify(rows));
  console.log("db_query ok:", JSON.stringify(rows));

  await callTool("delete_suite", { name: "mcp-selftest-suite" });
  console.log("delete_suite ok");

  if (!noKb) {
    const hits = await callTool("kb_search", { query: "authorization completes payment downstream", limit: 3 });
    if (!Array.isArray(hits) || hits.length === 0 || !hits[0]?.path?.startsWith("knowledge/")) {
      throw new Error("kb_search failed: " + JSON.stringify(hits));
    }
    console.log(`kb_search ok: top hit ${hits[0].path} :: ${hits[0].section} (score ${hits[0].score})`);

    const guide = await callTool("kb_read", { path: hits[0].path, section: "Messages" });
    if (typeof guide !== "string" || !guide.includes("Messages")) throw new Error("kb_read failed");
    console.log("kb_read ok");

    // get_message_schema should carry KB notes
    const withNotes = await callTool("get_message_schema", { process: "auth-gateway", message: "Authorize" });
    if (typeof withNotes.notes !== "string") throw new Error("get_message_schema missing KB notes");
    console.log("get_message_schema KB notes ok");
  } else {
    console.log("MCP_NO_KB=1: kb tools correctly absent");
  }

  console.log("\nMCP SELF-TEST PASSED");
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error("\nMCP SELF-TEST FAILED:", e.message);
  server.kill();
  process.exit(1);
});
