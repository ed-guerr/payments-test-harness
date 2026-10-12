import type {
  DbRow,
  RunnerEvent,
  SuiteMeta,
  SuiteResult,
  StepResult,
} from "../main/preload";

declare global {
  interface Window {
    harness: {
      listSuites(): Promise<SuiteMeta[]>;
      readSuite(name: string): Promise<import("../runner/runner").Suite>;
      runSuite(name: string): Promise<SuiteResult>;
      dataFiles(): Promise<string[]>;
      dataQuery(file: string, sql: string): Promise<{ rows: DbRow[] }>;
      onRunnerEvent(cb: (e: RunnerEvent) => void): () => void;
    };
  }
}

export type { DbRow, RunnerEvent, SuiteMeta, SuiteResult, StepResult };
