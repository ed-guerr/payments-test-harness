import { Link } from "react-router-dom";
import { useHarness } from "../store";

export function SuiteListPage(): JSX.Element {
  const { loaded, suites, suiteResults, runningSuite, runSuite } = useHarness();

  if (!loaded) return <p className="text-muted text-sm">loading suites…</p>;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold">Test Suites</h2>
        <button
          onClick={() => suites.forEach((s) => void runSuite(s.name))}
          disabled={runningSuite !== null}
          className="text-xs px-3 py-1.5 rounded bg-edge hover:bg-gray-700 disabled:opacity-40"
        >
          Run all
        </button>
      </div>
      <div className="space-y-2">
        {suites.map((s) => {
          const r = suiteResults[s.name];
          const running = runningSuite === s.name;
          return (
            <div
              key={s.name}
              className="flex items-center gap-4 border border-edge rounded bg-panel px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <Link
                  to={`/suite/${s.name}`}
                  className="text-sm font-mono text-accent hover:underline"
                >
                  {s.name}
                </Link>
                <p className="text-xs text-muted truncate">{s.description}</p>
              </div>
              <span className="text-xs text-muted">{s.stepCount} steps</span>
              <span className="text-xs w-40 text-right">
                {r ? (
                  r.ok ? (
                    <span className="text-pass">✓ {r.passed} passed</span>
                  ) : (
                    <span className="text-fail">
                      ✗ {r.failed} failed / {r.passed} passed
                    </span>
                  )
                ) : (
                  <span className="text-muted">not run</span>
                )}
              </span>
              <button
                onClick={() => void runSuite(s.name)}
                disabled={runningSuite !== null}
                className="text-xs px-3 py-1.5 rounded bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40"
              >
                {running ? "running…" : "Run"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
