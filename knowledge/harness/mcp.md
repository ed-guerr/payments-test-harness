# harness/src/mcp — Intern Guide

> written by Qwen3 (local, via pi coding agent) · generated 2026-10-13T04:59:47.265Z · kb-forge 0.2 · source sha256:c5379bf60849

## Purpose

The Model Context Protocol server (stdio). This is the agent-facing API: protocol introspection from the registry, suite CRUD (validated before write), suite execution against fresh backend clusters, and read-only db access. KB tools (kb_search/kb_read) join in P5; MCP_NO_KB=1 disables them for the A/B demo.

## Files

| file | ~lines |
|---|---|
| kbTools.ts | 75 |
| server.ts | 282 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `tool` | MCP tool = named function with zod input schema |
| `stdio transport` | newline-delimited JSON-RPC over stdin/stdout |
| `MCP_NO_KB` | env flag: start the server without the knowledge-base tools (A/B demo, server.ts:262) |

## Key functions

| function | defined at |
|---|---|
| `kbEnabled` | kbTools.ts:14 |
| `text(payload: unknown)` | kbTools.ts:18 |
| `registerKbTools(server: McpServer)` | kbTools.ts:22 |
| `messageKbNotes(processName: string, messageName: string)` | kbTools.ts:57 |
| `kbHintsFor(messageOrField: string)` | kbTools.ts:71 |
| `text(payload: unknown)` | server.ts:38 |
| `suiteFile(name: string)` | server.ts:46 |
| `runSuiteByName(name: string)` | server.ts:183 |
| `main` | server.ts:273 |

## Common modification points

- New tool = server.registerTool(name, {description, inputSchema}, handler) — keep descriptions rich; they are the agent's documentation.

## Risks

| area | risk | mitigation |
|---|---|---|
| server.ts | suite names are file names | suiteFile() enforces a safe id charset |
| db_query | read-only by construction (opened readonly + SELECT-only guard) | defense in depth: the process also never gets a write handle |

## Inter-process interactions

- Reuses the runner and codec directly; no Electron involved — runs under plain Node (tsx).
