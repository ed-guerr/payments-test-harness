# harness/src/renderer — Intern Guide

> generated 2026-10-13T01:38:34.537Z · kb-forge 0.2 · source sha256:dfb3d70f44a4

## Purpose

React UI (sandboxed, no Node). Three tabs: Suites (list + live run with per-step results and the backend log), Protocol Registry (the introspected wire protocol), Database (read-only SQL against per-suite databases). State lives in a zustand store fed by the preload bridge.

## Files

| file | ~lines |
|---|---|
| App.tsx | 59 |
| env.d.ts | 23 |
| index.css | 19 |
| index.html | 13 |
| main.tsx | 17 |
| /pages/DbPage.tsx | 117 |
| /pages/RegistryPage.tsx | 74 |
| /pages/SuiteListPage.tsx | 67 |
| /pages/SuitePage.tsx | 114 |
| store.ts | 73 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `store` | store.ts — zustand: stepResults, suiteResults, backend log |
| `bridge` | window.harness.* (see preload.ts) |

## Key functions

| function | defined at |
|---|---|
| `DbPage` | pages/DbPage.tsx:12 |
| `RegistryPage` | pages/RegistryPage.tsx:13 |
| `SuiteListPage` | pages/SuiteListPage.tsx:4 |
| `SuitePage` | pages/SuitePage.tsx:7 |
| `StepBadge({ r, running }: { r?: StepResult; running: boolean })` | pages/SuitePage.tsx:97 |
| `describeStep(step: Step)` | pages/SuitePage.tsx:108 |

## Common modification points

- New tab = page component + route in App.tsx + store slice if it has state.

## Risks

| area | risk | mitigation |
|---|---|---|
| all | no direct node/fs access allowed (sandboxed) | request data via the preload bridge |

## Inter-process interactions

- Only talks to the main process via window.harness; receives runner:event pushes.
