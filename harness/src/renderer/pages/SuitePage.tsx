import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FieldValue } from "../../protocol/types";
import type { Step, Suite } from "../../runner/runner";
import { useHarness } from "../store";
import type { StepResult } from "../env";

export function SuitePage(): JSX.Element {
  const { name = "" } = useParams();
  const [suite, setSuite] = useState<Suite | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { stepResults, suiteResults, runningSuite, runSuite, log } = useHarness();

  const toggleStep = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
          <Link to="/" className="text-xs text-muted hover:text-fg">
            ← suites
          </Link>
        </div>
        <h2 className="text-lg font-mono text-accent">{suite.name}</h2>
        <p className="text-xs text-muted mb-4">{suite.description}</p>

        <StepTimeline suite={suite} results={results} onToggle={toggleStep} />

        <div className="border border-edge rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-panel text-muted">
              <tr>
                <th className="w-6"></th>
                <th className="text-left px-3 py-2 w-16">status</th>
                <th className="text-left px-3 py-2 w-40">step</th>
                <th className="text-left px-3 py-2">action</th>
                <th className="text-left px-3 py-2">detail</th>
                <th className="text-right px-3 py-2 w-16">time</th>
              </tr>
            </thead>
            <tbody>
              {suite.steps.map((step) => {
                const r: StepResult | undefined = results[step.id];
                const isOpen = expanded.has(step.id);
                return (
                  <Fragment key={step.id}>
                    <tr
                      onClick={() => toggleStep(step.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleStep(step.id);
                        }
                      }}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      className={`border-t border-edge cursor-pointer focus:outline-none focus:bg-edge/40 ${
                        isOpen ? "bg-panel" : "hover:bg-edge/30"
                      }`}
                    >
                      <td className="pl-2 py-2 text-muted text-[10px] select-none">
                        {isOpen ? "▾" : "▸"}
                      </td>
                      <td className="px-3 py-2">
                        <StepBadge r={r} running={running && !r} />
                      </td>
                      <td className="px-3 py-2 font-mono text-dim">{step.id}</td>
                      <td className="px-3 py-2 font-mono text-dim">{describeStep(step)}</td>
                      <td className="px-3 py-2 text-muted break-all">{r?.detail ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-dim whitespace-nowrap">
                        {r?.durationMs !== undefined ? fmtMs(r.durationMs) : "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-edge bg-ink">
                        <td colSpan={6} className="px-4 py-3">
                          <StepDetails step={step} result={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
        <pre className="p-3 text-[11px] font-mono text-dim h-[560px] overflow-auto">
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

/**
 * Per-step waterfall: one bar per step, offset by start time and sized by
 * duration, scaled to the suite total. Delay steps render dim (intentional
 * wait); failures render red. Clicking a row toggles the matching table row.
 * Hidden until a run has produced step timing.
 */
function StepTimeline({
  suite,
  results,
  onToggle,
}: {
  suite: Suite;
  results: Record<string, StepResult>;
  onToggle: (id: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(true);
  const timed = suite.steps
    .map((step) => ({ step, r: results[step.id] }))
    .filter(
      (x): x is { step: Step; r: StepResult & { startedAtMs: number; durationMs: number } } =>
        x.r?.startedAtMs !== undefined && x.r?.durationMs !== undefined,
    );
  if (timed.length === 0) return null;
  const total = Math.max(1, ...timed.map(({ r }) => r.startedAtMs + r.durationMs));
  const toggle = (): void => setOpen((v) => !v);
  return (
    <div className="mt-3 border border-edge rounded bg-panel">
      <div
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="px-3 py-2 text-xs font-semibold text-muted border-b border-edge flex items-center justify-between cursor-pointer focus:outline-none focus:bg-edge/40 hover:bg-edge/30"
      >
        <span>
          <span className="inline-block w-4 select-none">{open ? "▾" : "▸"}</span> timeline
        </span>
        <span className="font-mono font-normal">{total} ms total</span>
      </div>
      {open && <div className="p-3 space-y-[3px]">
        {timed.map(({ step, r }) => {
          const color = !r.ok ? "bg-fail" : "delayMs" in step ? "bg-edge" : "bg-accent/70";
          const width = Math.max((r.durationMs / total) * 100, 0.6);
          return (
            <div
              key={step.id}
              onClick={() => onToggle(step.id)}
              title={`${step.id}: ${r.durationMs} ms, starts at ${r.startedAtMs} ms`}
              className="flex items-center gap-2 cursor-pointer group"
            >
              <span className="w-44 shrink-0 font-mono text-[10px] text-dim group-hover:text-fg truncate">
                {step.id}
              </span>
              <div className="relative flex-1 h-3 bg-ink rounded-sm">
                <div
                  className={`absolute top-0 h-full rounded-sm ${color}`}
                  style={{ left: `${(r.startedAtMs / total) * 100}%`, width: `${width}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-[10px] text-muted whitespace-nowrap">
                {fmtMs(r.durationMs)}
              </span>
            </div>
          );
        })}
      </div>}
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms < 1 ? "<1 ms" : `${Math.round(ms)} ms`;
}

function describeStep(step: Step): string {
  if ("send" in step) return `${step.send.msg} → ${step.send.to}`;
  if ("dbAssert" in step) return `dbAssert: ${step.dbAssert.sql}`;
  if ("delayMs" in step) return `wait ${step.delayMs} ms`;
  if ("killProcess" in step) return `kill ${step.killProcess.proc} (${step.killProcess.signal ?? "SIGKILL"})`;
  return "";
}

/** Expanded row: full step definition on the left, result on the right. */
function StepDetails({ step, result }: { step: Step; result?: StepResult }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">step</div>
        <StepDefinition step={step} />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">result</div>
        {!result && <span className="text-xs text-muted">not run</span>}
        {result && (
          <>
            <div className={`text-xs font-mono break-all ${result.ok ? "text-pass" : "text-fail"}`}>
              {result.detail}
            </div>
            {result.received !== undefined && (
              <pre className="mt-2 bg-panel border border-edge rounded p-2 overflow-auto max-h-48 text-[11px] font-mono text-dim">
                {JSON.stringify(result.received, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StepDefinition({ step }: { step: Step }): JSX.Element {
  if ("send" in step) {
    return (
      <div className="space-y-2 text-xs">
        <div>
          <span className="text-muted">send </span>
          <span className="font-mono text-fg">{step.send.msg}</span>
          <span className="text-muted"> → </span>
          <span className="font-mono text-fg">{step.send.to}</span>
        </div>
        <FieldList label="fields" fields={step.send.fields} />
        {step.expectAck && <FieldList label="expectAck" fields={step.expectAck} />}
        {step.expectError !== undefined && <KVRow k="expectError" v={String(step.expectError)} />}
        {step.timeoutMs !== undefined && <KVRow k="timeoutMs" v={step.timeoutMs} />}
      </div>
    );
  }
  if ("dbAssert" in step) {
    return (
      <div className="space-y-2 text-xs">
        <div className="break-all">
          <span className="text-muted">sql </span>
          <span className="font-mono text-fg">{step.dbAssert.sql}</span>
        </div>
        {step.dbAssert.params && step.dbAssert.params.length > 0 && (
          <KVRow k="params" v={step.dbAssert.params} />
        )}
        <FieldList label="expect" fields={step.dbAssert.expect} />
      </div>
    );
  }
  if ("killProcess" in step) {
    return (
      <div className="space-y-2 text-xs">
        <div>
          <span className="text-muted">kill </span>
          <span className="font-mono text-fg">{step.killProcess.proc}</span>
          <span className="text-muted"> ({step.killProcess.signal ?? "SIGKILL"})</span>
        </div>
        <KVRow k="note" v="chaos step — the process does not come back" />
      </div>
    );
  }
  return <KVRow k="delayMs" v={step.delayMs} />;
}

type DetailField = FieldValue | null;

type KVPair = [string, string];

/**
 * Justified key/value table: names right-aligned in a tight auto column,
 * values left-aligned, with gridlines between rows and between the two
 * columns so the pairs read as an aligned table. An optional `label`
 * renders as a header row.
 */
function KVGrid({ rows, label }: { rows: KVPair[]; label?: string }): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="border border-edge rounded overflow-hidden">
      {label && (
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted bg-panel border-b border-edge">
          {label}
        </div>
      )}
      <div className="grid grid-cols-[max-content_1fr] text-[11px] font-mono">
        {rows.map(([k, v], i) => {
          const notLast = i < rows.length - 1;
          return (
            <Fragment key={k}>
              <span
                className={`px-2 py-1 text-faint text-right select-none border-edge border-r ${
                  notLast ? "border-b" : ""
                }`}
              >
                {k}
              </span>
              <span
                className={`px-2 py-1 text-fg break-all border-edge ${
                  notLast ? "border-b" : ""
                }`}
              >
                {v}
              </span>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function FieldList({
  label,
  fields,
}: {
  label: string;
  fields: Record<string, DetailField>;
}): JSX.Element | null {
  const rows: KVPair[] = Object.entries(fields).map(([k, v]) => [k, JSON.stringify(v)]);
  if (rows.length === 0) return null;
  return <KVGrid rows={rows} label={label} />;
}

function KVRow({ k, v }: { k: string; v: string | number | (string | number | null)[] }): JSX.Element {
  return <KVGrid rows={[[k, JSON.stringify(v)]]} />;
}
