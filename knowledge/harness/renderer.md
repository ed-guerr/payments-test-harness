# harness/src/renderer — Intern Guide

> generated 2026-10-12T22:22:44.520Z · kb-forge 0.1 · source sha256:dfb3d70f44a4

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

_no top-level C function definitions in this directory_

## Common modification points

- New tab = page component + route in App.tsx + store slice if it has state.

## Risks

| area | risk | mitigation |
|---|---|---|
| all | no direct node/fs access allowed (sandboxed) | request data via the preload bridge |

## Inter-process interactions

- Only talks to the main process via window.harness; receives runner:event pushes.
