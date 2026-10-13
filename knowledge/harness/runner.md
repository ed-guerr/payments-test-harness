# harness/src/runner — Intern Guide

> written by Qwen3 (local, via pi coding agent) · generated 2026-10-13T04:55:30.715Z · kb-forge 0.2 · source sha256:8e57e2ef6bde

## Purpose

The suite execution engine. Interprets suite JSON (send / dbAssert / delayMs steps) against a live backend cluster, streams step results as events, and persists run results. Used by the headless CLI, the Electron main process, and the MCP server — with no Electron imports.

## Files

| file | ~lines |
|---|---|
| cli.ts | 85 |
| runner.ts | 237 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `send step` | send:{to,msg,fields} — encodes via the registry-driven codec |
| `expectAck` | partial match on the response fields (subset semantics) |
| `dbAssert` | single-row SELECT + partial expect on columns |
| `runner event` | step-start / step-result / suite-result, consumed by CLI+GUI+MCP |

## Key functions

| function | defined at |
|---|---|
| `parseArgs(argv: string[])` | cli.ts:22 |
| `printEvent(e: RunnerEvent, json: boolean)` | cli.ts:33 |
| `main` | cli.ts:53 |
| `Runner` | runner.ts:84 |
| `sleep(ms: number)` | runner.ts:234 |

## Common modification points

- New step kind = new case in runStep() + schema in suites.ts + renderer row in SuitePage.

## Risks

| area | risk | mitigation |
|---|---|---|
| runner.ts | matchAck subset semantics: extra ack fields are ignored (matchAck, runner.ts:211) | intentional (keeps suites stable); pin new fields explicitly when they matter |
| cli.ts | one fresh backend + db per suite run | suites are independent by design; shared-state tests need a new step kind |

## Inter-process interactions

- Consumes protocol/codec + protocol/conn; emits events to the CLI (console), Electron main (IPC), and MCP (collected into run results).
