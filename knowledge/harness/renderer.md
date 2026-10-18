# harness/src/renderer — Intern Guide

> written by Qwen3.8-27B (local, via pi coding agent) · generated 2026-10-17T00:22:13.830Z · kb-forge 0.2 · source sha256:142d531784ab

## Purpose

React UI (sandboxed, no Node). Three tabs: Suites (list + live run with per-step results and the backend log), Protocol Registry (the introspected wire protocol), Database (read-only SQL against per-suite databases). State lives in a zustand store fed by the preload bridge; the suite list auto-refreshes via the suites-changed push.

## Files

| file | ~lines |
|---|---|
| App.tsx | 124 |
| env.d.ts | 23 |
| index.css | 51 |
| index.html | 24 |
| main.tsx | 17 |
| /pages/DbPage.tsx | 117 |
| /pages/RegistryPage.tsx | 74 |
| /pages/SuiteListPage.tsx | 67 |
| /pages/SuitePage.tsx | 367 |
| store.ts | 81 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `store` | store.ts — zustand: suites, stepResults, suiteResults, backend log |
| `bridge` | window.harness.* (see preload.ts) |
| `suites-changed` | store.ts handleEvent: the main process's suite-dir watcher pushes a refreshed suite list; per-suite results are kept (keyed by name) |

## Key functions

| function | defined at |
|---|---|
| `SunIcon` | App.tsx:16 |
| `MoonIcon` | App.tsx:34 |
| `initialTheme` | App.tsx:54 |
| `DbPage` | pages/DbPage.tsx:12 |
| `RegistryPage` | pages/RegistryPage.tsx:13 |
| `SuiteListPage` | pages/SuiteListPage.tsx:4 |
| `SuitePage` | pages/SuitePage.tsx:8 |
| `StepBadge({ r, running }: { r?: StepResult; running: boolean })` | pages/SuitePage.tsx:133 |
| `fmtMs(ms: number)` | pages/SuitePage.tsx:220 |
| `describeStep(step: Step)` | pages/SuitePage.tsx:224 |
| `StepDetails({ step, result }: { step: Step; result?: StepResult })` | pages/SuitePage.tsx:233 |
| `StepDefinition({ step }: { step: Step })` | pages/SuitePage.tsx:260 |
| `KVGrid({ rows, label }: { rows: KVPair[]; label?: string })` | pages/SuitePage.tsx:316 |
| `KVRow({ k, v }: { k: string; v: string \| number \| (string \| number \| null)` | pages/SuitePage.tsx:364 |

## Common modification points

- New tab = page component + route in App.tsx + store slice if it has state.

## Risks

| area | risk | mitigation |
|---|---|---|
| all | no direct node/fs access allowed (sandboxed) | request data via the preload bridge |

## Inter-process interactions

- Only talks to the main process via window.harness; receives runner:event pushes.
