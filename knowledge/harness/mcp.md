# harness/src/mcp — Intern Guide

> generated 2026-10-12T22:22:44.520Z · kb-forge 0.1 · source sha256:93c04d5dd5d5

## Purpose

The Model Context Protocol server (stdio). This is the agent-facing API: protocol introspection from the registry, suite CRUD (validated before write), suite execution against fresh backend clusters, and read-only db access. KB tools (kb_search/kb_read) join in P5; MCP_NO_KB=1 disables them for the A/B demo.

## Files

| file | ~lines |
|---|---|
| kbTools.ts | 75 |
| server.ts | 278 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `tool` | MCP tool = named function with zod input schema |
| `stdio transport` | newline-delimited JSON-RPC over stdin/stdout |
| `MCP_NO_KB` | env flag: start the server without the knowledge-base tools (A/B demo) |

## Key functions

_no top-level C function definitions in this directory_

## Common modification points

- New tool = server.registerTool(name, {description, inputSchema}, handler) — keep descriptions rich; they are the agent's documentation.

## Risks

| area | risk | mitigation |
|---|---|---|
| server.ts | suite names are file names | suiteFile() enforces a safe id charset |
| db_query | read-only by construction (opened readonly + SELECT-only guard) | defense in depth: the process also never gets a write handle |

## Inter-process interactions

- Reuses the runner and codec directly; no Electron involved — runs under plain Node (tsx).
