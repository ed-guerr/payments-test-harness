# harness/src/main — Intern Guide

> written by Qwen3.8-27B (local, via pi coding agent) · generated 2026-11-12T02:30:08.576Z · kb-forge 0.2 · source sha256:dcce2a3b3ed4

## Purpose

Electron main process. Creates the sandboxed BrowserWindow (contextIsolation on, nodeIntegration off, sandbox on), hosts every IPC handler (suites, runner, read-only db access), watches harness/suites/ and pushes list updates to the renderer, and includes a headless self-test mode (HARNESS_SELF_TEST=1) that drives the real renderer through the real preload bridge.

## Files

| file | ~lines |
|---|---|
| main.ts | 224 |
| preload.ts | 53 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `preload bridge` | window.harness exposed via contextBridge in preload.ts |
| `IPC channels` | suite:list / suite:read / suite:run / data:files / data:query / runner:event (main.ts:48ff) |
| `self-test` | HARNESS_SELF_TEST=1 npm start — e2e verification without a human |

## Key functions

| function | defined at |
|---|---|
| `spawnCleanupHelper` | main.ts:51 |
| `createWindow` | main.ts:91 |
| `sendUi(e: UiEvent)` | main.ts:107 |
| `registerIpc` | main.ts:111 |
| `selfTest` | main.ts:158 |
| `startSuitesWatcher` | main.ts:192 |

## Common modification points

- New IPC capability = handler in main.ts + bridge method in preload.ts + renderer usage (never require() in the renderer).

## Risks

| area | risk | mitigation |
|---|---|---|
| main.ts | renderer must stay sandboxed | all fs/child_process/sqlite in main only |
| paths | dist/ layout differs from src/ (tsconfig outDir) | paths.ts walks up to package.json instead of hard-coding relative depth |

## Inter-process interactions

- Spawns backend processes via backend/cluster.ts; streams runner events to the renderer over runner:event.

- startSuitesWatcher() (main.ts): fs.watch on harness/suites/ + 200 ms debounce pushes a suites-changed event (recomputed listSuites()) on the runner:event channel, so suites created outside the app (MCP server, editor) appear without a reload; a throw from a half-written file is skipped and re-emitted on the next change.
