import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Step, Suite } from "../../runner/runner";
import { useHarness } from "../store";
import type { StepResult } from "../env";

export function SuitePage(): JSX.Element {
  const { name = "" } = useParams();
  const [suite, setSuite] = useState<Suite | null>(null);
  const { stepResults, suiteResults, runningSuite, runSuite, log } = useHarness();

  useEffect(() => {
    void window.harness.readSuite(name).then((s) => setSuite(s as Suite));
  }, [name]);

  if (!suite) return <p className="text-muted text-sm">loading suite…</p>;

  const results = stepResults[suite.name] ?? {};
  const summary = suiteResults[suite.name];
  const running = runningSuite === suite.name;

  return (
    <div className="grid grid-cols-[1fr_420px] gap-6">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Link to="/" className="text-xs text-muted hover:text-gray-200">
            ← suites
          </Link>
        </div>
        <h2 className="text-lg font-mono text-accent">{suite.name}</h2>
        <p className="text-xs text-muted mb-4">{suite.description}</p>

        <div className="border border-edge rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-panel text-muted">
              <tr>
                <th className="text-left px-3 py-2 w-16">status</th>
                <th className="text-left px-3 py-2 w-40">step</th>
                <th className="text-left px-3 py-2">action</th>
                <th className="text-left px-3 py-2">detail</th>
              </tr>
            </thead>
            <tbody>
              {suite.steps.map((step) => {
                const r: StepResult | undefined = results[step.id];
                return (
                  <tr key={step.id} className="border-t border-edge">
                    <td className="px-3 py-2">
                      <StepBadge r={r} running={running && !r} />
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-300">{step.id}</td>
                    <td className="px-3 py-2 font-mono text-gray-400">{describeStep(step)}</td>
                    <td className="px-3 py-2 text-muted break-all">
                      {r?.detail ?? "—"}
                      {r?.received !== undefined && (
                        <pre className="mt-1 bg-ink border border-edge rounded p-2 overflow-auto max-h-40">
                          {JSON.stringify(r.received, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <button
            onClick={() => void runSuite(suite.name)}
            disabled={runningSuite !== null}
            className="text-xs px-4 py-2 rounded bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {running ? "running…" : "Run suite"}
          </button>
          {summary && (
            <span className={`text-xs ${summary.ok ? "text-pass" : "text-fail"}`}>
              {summary.ok ? "✓" : "✗"} {summary.passed} passed, {summary.failed} failed (
              {summary.durationMs} ms)
            </span>
          )}
        </div>
      </div>

      <div className="border border-edge rounded bg-panel">
        <div className="px-3 py-2 text-xs font-semibold text-muted border-b border-edge">
          Backend log
        </div>
        <pre className="p-3 text-[11px] font-mono text-gray-400 h-[560px] overflow-auto">
          {log.length === 0 ? "—" : log.join("\n")}
        </pre>
      </div>
    </div>
  );
}

function StepBadge({ r, running }: { r?: StepResult; running: boolean }): JSX.Element {
  if (!r) {
    return <span className={`text-xs font-mono ${running ? "text-accent animate-pulse" : "text-muted"}`}>
      {running ? "…" : "○"}
    </span>;
  }
  return (
    <span className={`text-xs font-mono ${r.ok ? "text-pass" : "text-fail"}`}>{r.ok ? "✓" : "✗"}</span>
  );
}

function describeStep(step: Step): string {
  if ("send" in step) return `${step.send.msg} → ${step.send.to}`;
  if ("dbAssert" in step) return `dbAssert: ${step.dbAssert.sql}`;
  if ("delayMs" in step) return `wait ${step.delayMs} ms`;
  return "";
}
