/**
 * renderer/store.ts — zustand store. One global store: suite metadata,
 * live step results (keyed by suite → step id), suite summaries, and a
 * rolling backend log. Runner events from the main process land here via
 * handleEvent(); the UI components are pure projections of this state.
 */
import { create } from "zustand";
import type { RunnerEvent, SuiteMeta, SuiteResult, StepResult } from "./env";

interface HarnessState {
  loaded: boolean;
  suites: SuiteMeta[];
  runningSuite: string | null;
  stepResults: Record<string, Record<string, StepResult>>;
  suiteResults: Record<string, SuiteResult>;
  log: string[];

  init(): Promise<void>;
  runSuite(name: string): Promise<void>;
  handleEvent(e: RunnerEvent): void;
}

const MAX_LOG = 400;

export const useHarness = create<HarnessState>((set, get) => ({
  loaded: false,
  suites: [],
  runningSuite: null,
  stepResults: {},
  suiteResults: {},
  log: [],

  init: async () => {
    const suites = await window.harness.listSuites();
    set({ suites, loaded: true });
  },

  runSuite: async (name) => {
    set({ runningSuite: name, log: [] });
    try {
      await window.harness.runSuite(name);
    } finally {
      set({ runningSuite: null });
    }
  },

  handleEvent: (e) => {
    switch (e.type) {
      case "backend-log":
        set((s) => ({ log: [...s.log.slice(-(MAX_LOG - 1)), `[${e.proc}] ${e.line}`] }));
        break;
      case "step-result": {
        const step = e as unknown as StepResult;
        set((s) => ({
          stepResults: {
            ...s.stepResults,
            [step.suite]: { ...(s.stepResults[step.suite] ?? {}), [step.stepId]: step },
          },
        }));
        break;
      }
      case "suite-result": {
        const r = e as unknown as SuiteResult;
        set((s) => ({ suiteResults: { ...s.suiteResults, [r.suite]: r } }));
        break;
      }
      case "suites-changed": {
        // Pushed by the main process's suite-dir watcher: new/edited/deleted
        // suite files appear here without a reload. Per-suite results are
        // kept (keyed by name); new suites simply read as "not run".
        const e2 = e as unknown as { suites: SuiteMeta[] };
        set({ suites: e2.suites });
        break;
      }
      case "suite-start":
      case "done":
        break;
    }
  },
}));
