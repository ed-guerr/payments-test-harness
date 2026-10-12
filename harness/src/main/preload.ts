/**
 * main/preload.ts — the only bridge between the sandboxed renderer and the
 * main process. Exposes a minimal, promise-based API on window.harness.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface SuiteMeta {
  name: string;
  description: string;
  stepCount: number;
}

export interface StepResult {
  suite: string;
  stepId: string;
  ok: boolean;
  detail: string;
  received?: unknown;
}

export interface SuiteResult {
  suite: string;
  ok: boolean;
  passed: number;
  failed: number;
  durationMs: number;
}

export interface RunnerEvent {
  type: "suite-start" | "step-result" | "suite-result" | "done" | "backend-log";
  [key: string]: unknown;
}

export interface DbRow {
  [col: string]: string | number | bigint | null;
}

contextBridge.exposeInMainWorld("harness", {
  listSuites: (): Promise<SuiteMeta[]> => ipcRenderer.invoke("suite:list"),
  readSuite: (name: string): Promise<unknown> => ipcRenderer.invoke("suite:read", name),
  runSuite: (name: string): Promise<SuiteResult> => ipcRenderer.invoke("suite:run", name),
  dataFiles: (): Promise<string[]> => ipcRenderer.invoke("data:files"),
  dataQuery: (file: string, sql: string): Promise<{ rows: DbRow[] }> => ipcRenderer.invoke("data:query", file, sql),
  onRunnerEvent: (cb: (e: RunnerEvent) => void): (() => void) => {
    const listener = (_: unknown, e: RunnerEvent): void => cb(e);
    ipcRenderer.on("runner:event", listener);
    return () => ipcRenderer.removeListener("runner:event", listener);
  },
});
