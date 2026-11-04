# harness/src/runner — Intern Guide

> written by Qwen3.8-27B (local, via pi coding agent) · generated 2026-11-04T02:23:11.246Z · kb-forge 0.2 · source sha256:7cdcf66a9eae

## Purpose

The suite execution engine. Interprets suite JSON (send / dbAssert / delayMs steps) against a live backend cluster, streams step results as events, and persists run results. Used by the headless CLI, the Electron main process, and the MCP server — with no Electron imports.

## Files

| file | ~lines |
|---|---|
| cli.ts | 97 |
| matchAck.test.ts | 24 |
| report.test.ts | 48 |
| report.ts | 537 |
| runner.ts | 345 |

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
| `parseArgs(argv: string[])` | cli.ts:23 |
| `printEvent(e: RunnerEvent, json: boolean)` | cli.ts:34 |
| `main` | cli.ts:54 |
| `fmt(v: unknown)` | report.ts:42 |
| `actionFor(step: Step)` | report.ts:47 |
| `assertionsFor(step: Step, r: StepResult & StepTiming)` | report.ts:62 |
| `kv(rows: [string, string][], label?: string)` | report.ts:102 |
| `stepDefinition(step: Step)` | report.ts:115 |
| `stepResult(r: StepResult & StepTiming)` | report.ts:155 |
| `stepRows(step: Step, r: StepResult & StepTiming)` | report.ts:167 |
| `timelineRows(suite: Suite, steps: (StepResult & StepTiming)` | report.ts:208 |
| `renderHtmlReport(input: ReportInput)` | report.ts:309 |
| `Runner` | runner.ts:108 |
| `sleep(ms: number)` | runner.ts:342 |

## Common modification points

- New step kind = new case in runStep() + schema in suites.ts + renderer row in SuitePage.

## Risks

| area | risk | mitigation |
|---|---|---|
| runner.ts | matchAck subset semantics: extra ack fields are ignored (matchAck, runner.ts:211) | intentional (keeps suites stable); pin new fields explicitly when they matter |
| cli.ts | one fresh backend + db per suite run | suites are independent by design; shared-state tests need a new step kind |

## Inter-process interactions

- Consumes protocol/codec + protocol/conn; emits events to the CLI (console), Electron main (IPC), and MCP (collected into run results).
