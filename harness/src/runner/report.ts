/**
 * runner/report.ts — self-contained HTML run reports.
 *
 * Each completed run writes <reportsDir>/<suite>_<ts>.html (default
 * <repo>/artifacts/test-reports): the suite's steps with pass/fail status, the
 * pass/fail assertions highlighted (per-field expected vs actual), a
 * per-step timing waterfall, and the app's full interaction model —
 * expandable step rows (full definition + result), a collapsible timeline,
 * and a light/dark toggle. The file is standalone (no external assets);
 * styling mirrors the app: same tokens as src/renderer/index.css, dark by
 * default, paper beige via the same `harness-theme` localStorage key the
 * app uses (so a user's app choice carries over to the report).
 */
import fs from "node:fs";
import path from "node:path";
import type { DbRow } from "../db/db";
import type { Step, StepResult, StepTiming, Suite, SuiteResult } from "./runner";

export interface ReportInput {
  suite: Suite;
  result: SuiteResult;
  steps: (StepResult & StepTiming)[];
  /** ISO timestamp of the run. */
  at: string;
}

interface AssertRow {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
}

const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** JSON-ish rendering for field values ("—" for missing). */
function fmt(v: unknown): string {
  if (v === undefined) return "—";
  return JSON.stringify(v);
}

function actionFor(step: Step): { main: string; sub?: string } {
  if ("send" in step) {
    const fields = Object.entries(step.send.fields)
      .map(([k, v]) => `${k} ${fmt(v)}`)
      .join("  ");
    return { main: `${step.send.msg} → ${step.send.to}`, sub: fields };
  }
  if ("dbAssert" in step) return { main: step.dbAssert.sql };
  if ("delayMs" in step) return { main: `wait ${step.delayMs} ms` };
  if ("killProcess" in step)
    return { main: `${step.killProcess.signal ?? "SIGKILL"} ${step.killProcess.proc}` };
  return { main: "unknown step" };
}

/** Per-field pass/fail for the assertions a step declared. */
function assertionsFor(step: Step, r: StepResult & StepTiming): AssertRow[] {
  if ("send" in step) {
    const recv = r.received as { fields?: Record<string, unknown> } | undefined;
    if (step.expectError) {
      return [
        {
          label: "failure",
          expected: "error",
          actual: r.detail.replace(/^failed as expected: /, ""),
          ok: r.ok,
        },
      ];
    }
    if (step.expectAck) {
      const rows: AssertRow[] = [];
      for (const [field, want] of Object.entries(step.expectAck)) {
        const got = recv?.fields ? recv.fields[field] : undefined;
        rows.push({ label: field, expected: fmt(want), actual: fmt(got), ok: got === want });
      }
      return rows;
    }
    return [];
  }
  if ("dbAssert" in step) {
    const recv = r.received as { row?: DbRow | null } | undefined;
    const rows: AssertRow[] = [];
    for (const [col, want] of Object.entries(step.dbAssert.expect)) {
      const got = recv?.row ? (recv.row[col] as unknown) : undefined;
      rows.push({ label: col, expected: fmt(want), actual: fmt(got), ok: got === want });
    }
    return rows;
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Expanded-row content: full step definition + result (app parity)    */
/* ------------------------------------------------------------------ */

/** Justified key/value table with gridlines (the app's KVGrid). */
function kv(rows: [string, string][], label?: string): string {
  if (rows.length === 0) return "";
  const body = rows
    .map(
      ([k, v]) =>
        `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`,
    )
    .join("");
  const head = label ? `<div class="label">${esc(label)}</div>` : "";
  return `<div class="kv">${head}${body}</div>`;
}

/** Full step definition (mirrors the app's StepDefinition). */
function stepDefinition(step: Step): string {
  if ("send" in step) {
    let out =
      `<div class="def-line"><span class="muted">send </span>` +
      `<span class="val">${esc(step.send.msg)}</span>` +
      `<span class="muted"> → </span><span class="val">${esc(step.send.to)}</span></div>`;
    out += kv(Object.entries(step.send.fields).map(([k, v]) => [k, JSON.stringify(v)]), "fields");
    if (step.expectAck)
      out += kv(
        Object.entries(step.expectAck).map(([k, v]) => [k, JSON.stringify(v)]),
        "expectAck",
      );
    if (step.expectError !== undefined) out += kv([["expectError", JSON.stringify(step.expectError)]]);
    if (step.timeoutMs !== undefined) out += kv([["timeoutMs", JSON.stringify(step.timeoutMs)]]);
    return out;
  }
  if ("dbAssert" in step) {
    let out =
      `<div class="def-line"><span class="muted">sql </span>` +
      `<span class="val">${esc(step.dbAssert.sql)}</span></div>`;
    if (step.dbAssert.params && step.dbAssert.params.length > 0)
      out += kv([["params", JSON.stringify(step.dbAssert.params)]]);
    out += kv(
      Object.entries(step.dbAssert.expect).map(([k, v]) => [k, JSON.stringify(v)]),
      "expect",
    );
    return out;
  }
  if ("killProcess" in step) {
    return (
      `<div class="def-line"><span class="muted">kill </span>` +
      `<span class="val">${esc(step.killProcess.proc)}</span>` +
      `<span class="muted"> (${esc(step.killProcess.signal ?? "SIGKILL")})</span></div>` +
      kv([["note", "chaos step — the process does not come back"]])
    );
  }
  return kv([["delayMs", JSON.stringify(step.delayMs)]]);
}

/** Result panel: detail line + the raw received payload (app parity). */
function stepResult(r: StepResult & StepTiming): string {
  let out = `<div class="res-line ${r.ok ? "ok" : "bad"}">${esc(r.detail)}</div>`;
  if (r.received !== undefined) {
    out += `<pre class="received">${esc(JSON.stringify(r.received, null, 2))}</pre>`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Table + timeline rows                                               */
/* ------------------------------------------------------------------ */

function stepRows(step: Step, r: StepResult & StepTiming): string {
  const { main, sub } = actionFor(step);
  const rows = assertionsFor(step, r);
  const status = r.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
  const action = sub
    ? `<div class="main">${esc(main)}</div><div class="sub">${esc(sub)}</div>`
    : `<div class="main">${esc(main)}</div>`;
  let asserts: string;
  if (rows.length > 0) {
    const trs = rows
      .map(
        (a) =>
          `<tr><td class="f">${esc(a.label)}</td><td class="v">${esc(a.expected)}</td>` +
          `<td class="v">${esc(a.actual)}</td>` +
          `<td class="${a.ok ? "ok" : "bad"}">${a.ok ? "✓" : "✗"}</td></tr>`,
      )
      .join("");
    const detail = r.ok ? "" : `<div class="detail fail">${esc(r.detail)}</div>`;
    asserts = `<table class="assr">${trs}</table>${detail}`;
  } else {
    asserts = `<div class="detail">${esc(r.detail)}</div>`;
  }
  const openRow =
    `<tr class="step-row${r.ok ? "" : " bad"}" data-step="${esc(r.stepId)}" tabindex="0" ` +
    `aria-expanded="false">` +
    `<td class="chev-cell"><span class="chev">▸</span></td>` +
    `<td class="status">${status}</td>` +
    `<td class="stepid">${esc(r.stepId)}</td>` +
    `<td class="action">${action}</td>` +
    `<td class="asserts">${asserts}</td>` +
    `<td class="num">${r.durationMs} ms</td>` +
    `</tr>`;
  const detailRow =
    `<tr class="step-detail hidden" data-step="${esc(r.stepId)}">` +
    `<td colspan="6"><div class="step-details">` +
    `<div><div class="sec-label">step</div>${stepDefinition(step)}</div>` +
    `<div><div class="sec-label">result</div>${stepResult(r)}</div>` +
    `</div></td></tr>`;
  return openRow + "\n" + detailRow;
}

function timelineRows(suite: Suite, steps: (StepResult & StepTiming)[], total: number): string {
  return steps
    .map((r, i) => {
      const step = suite.steps[i];
      const isDelay = step !== undefined && "delayMs" in step;
      const left = ((r.startedAtMs / total) * 100).toFixed(3);
      const width = Math.max((r.durationMs / total) * 100, 0.6).toFixed(3);
      const cls = !r.ok ? "failbar" : isDelay ? "delay" : "act";
      const bar = `<div class="tl-bar ${cls}" style="left:${left}%;width:${width}%"></div>`;
      return (
        `<div class="tl-row" data-step="${esc(r.stepId)}" ` +
        `title="${esc(r.stepId)}: ${r.durationMs} ms, starts at ${r.startedAtMs} ms">` +
        `<span class="id">${esc(r.stepId)}</span>` +
        `<div class="tl-track">${bar}</div>` +
        `<span class="ms">${r.durationMs} ms</span>` +
        `</div>`
      );
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

const SUN_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" aria-hidden><circle cx="12" cy="12" r="4"/>' +
  '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const MOON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden>' +
  '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

/**
 * Inline interaction script (no dependencies, no bundler): theme toggle
 * (same `harness-theme` key the app persists), expandable step rows with
 * keyboard support, and the collapsible timeline whose rows toggle the
 * matching step.
 */
const INTERACT_JS = `
(function () {
  var root = document.documentElement;

  // -- theme toggle (same behavior + storage key as the app header) --
  var btn = document.getElementById("theme-toggle");
  function syncBtn() {
    var light = root.getAttribute("data-theme") === "light";
    btn.innerHTML = (light ? MOON : SUN) + "<span>" + (light ? "dark" : "light") + "</span>";
  }
  btn.addEventListener("click", function () {
    var light = root.getAttribute("data-theme") === "light";
    root.setAttribute("data-theme", light ? "dark" : "light");
    try { localStorage.setItem("harness-theme", light ? "dark" : "light"); } catch (e) {}
    syncBtn();
  });
  syncBtn();

  // -- expandable step rows (click + Enter/Space, aria-expanded) --
  function toggleStep(id) {
    var row = document.querySelector('tr.step-row[data-step="' + id + '"]');
    var det = document.querySelector('tr.step-detail[data-step="' + id + '"]');
    if (!row || !det) return;
    var open = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", open ? "false" : "true");
    det.classList.toggle("hidden", open);
    row.querySelector(".chev").textContent = open ? "\\u25b8" : "\\u25be";
  }
  var rows = document.querySelectorAll("tr.step-row");
  for (var i = 0; i < rows.length; i++) {
    (function (row) {
      var id = row.getAttribute("data-step");
      row.addEventListener("click", function () { toggleStep(id); });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleStep(id); }
      });
    })(rows[i]);
  }
  var tlRows = document.querySelectorAll(".tl-row");
  for (var j = 0; j < tlRows.length; j++) {
    (function (r) {
      r.addEventListener("click", function () { toggleStep(r.getAttribute("data-step")); });
    })(tlRows[j]);
  }

  // -- collapsible timeline --
  var head = document.getElementById("tl-head");
  var body = document.getElementById("tl-body");
  function toggleTl() {
    var open = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", open ? "false" : "true");
    body.classList.toggle("hidden", open);
    head.querySelector(".chev").textContent = open ? "\\u25b8" : "\\u25be";
  }
  head.addEventListener("click", toggleTl);
  head.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTl(); }
  });
})();
`;

export function renderHtmlReport(input: ReportInput): string {
  const { suite, result, steps, at } = input;
  const total = steps.length;
  const timedTotal = Math.max(1, ...steps.map((r) => r.startedAtMs + r.durationMs));
  const rows = steps
    .map((r, i) => {
      const step = suite.steps[i];
      if (!step) return "";
      return stepRows(step, r);
    })
    .join("\n");
  const badge = result.ok
    ? '<div class="badge pass">PASS</div>'
    : '<div class="badge fail">FAIL</div>';
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(suite.name)} — run report</title>
<script>
// Restore the chosen theme before first paint (no palette flash).
// Same key as the app, so the user's app choice carries over.
try {
  if (localStorage.getItem("harness-theme") === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (e) { /* ignore — dark default applies */ }
</script>
<style>
:root {
  /* dark grey, not true black — softer than the app's theme */
  --ink: #161616; --panel: #1e1e1e; --edge: #3a3a3a; --fg: #e8e8e8;
  --dim: #b5b5b5; --faint: #8f8f8f; --accent: #58a6ff;
  --pass: #3fb950; --fail: #f85149;
}
[data-theme="light"] {
  --ink: #ece5d2; --panel: #f5f0e3; --edge: #d3c8ab; --fg: #26221a;
  --dim: #5d5647; --faint: #8b8168; --accent: #1a5fb4;
  --pass: #2e7d32; --fail: #c0392b;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ink); color: var(--fg);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hidden { display: none !important; }
.topbar {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--edge);
}
.brand { font-weight: 700; letter-spacing: 0.08em; }
.brand .sep { color: var(--faint); font-weight: 400; }
.topbar .right { display: flex; align-items: center; gap: 12px; }
.toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font: inherit; font-size: 12px; font-weight: 500;
  color: var(--dim); background: var(--edge);
  border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer;
}
.toggle:hover { background: color-mix(in srgb, var(--faint) 40%, var(--edge)); }
.toggle svg { display: block; }
.badge { border: 1px solid; padding: 2px 12px; font-weight: 700; letter-spacing: 0.08em; }
.badge.pass { color: var(--pass); border-color: var(--pass); }
.badge.fail { color: var(--fail); border-color: var(--fail); background: rgba(248, 81, 73, 0.12); }
main { padding: 20px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.desc { color: var(--dim); margin: 0 0 6px; }
.meta { color: var(--faint); font-size: 12px; margin-bottom: 16px; }
.summary {
  display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--panel); border: 1px solid var(--edge); margin-bottom: 16px;
}
.cell { padding: 8px 12px; border-right: 1px solid var(--edge); }
.cell:last-child { border-right: none; }
.k { color: var(--faint); font-size: 11px; letter-spacing: 0.06em; }
.v { font-size: 16px; font-weight: 700; margin-top: 2px; }
.v.pass { color: var(--pass); }
.v.fail { color: var(--fail); }
/* -- timeline (app StepTimeline parity) -- */
.timeline { border: 1px solid var(--edge); background: var(--panel); margin-bottom: 16px; }
.tl-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--dim);
  border-bottom: 1px solid var(--edge); cursor: pointer; user-select: none;
}
.tl-head:hover { background: color-mix(in srgb, var(--edge) 30%, transparent); }
.tl-head:focus-visible { outline: none; background: color-mix(in srgb, var(--edge) 40%, transparent); }
.tl-head .total { font-weight: 400; color: var(--faint); }
.tl-body { padding: 12px; display: flex; flex-direction: column; gap: 3px; }
.tl-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.tl-row .id {
  width: 176px; flex-shrink: 0; font-size: 10px; color: var(--dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tl-row:hover .id { color: var(--fg); }
.tl-track { position: relative; flex: 1; height: 12px; background: var(--ink); border-radius: 2px; }
.tl-bar { position: absolute; top: 0; height: 100%; border-radius: 2px; }
.tl-bar.act { background: color-mix(in srgb, var(--accent) 70%, transparent); }
.tl-bar.delay { background: var(--edge); }
.tl-bar.failbar { background: var(--fail); }
.tl-row .ms { width: 56px; flex-shrink: 0; text-align: right; font-size: 10px; color: var(--faint); white-space: nowrap; }
/* -- steps table (app SuitePage parity) -- */
table.steps { border-collapse: collapse; width: 100%; background: var(--panel); }
.steps th, .steps td {
  border: 1px solid var(--edge); padding: 6px 10px; text-align: left; vertical-align: top;
}
.steps thead th { color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; }
.steps tbody tr.step-row { cursor: pointer; }
.steps tbody tr.step-row:hover td { background: color-mix(in srgb, var(--edge) 30%, transparent); }
.steps tbody tr.step-row:focus-visible { outline: none; }
.steps tbody tr.step-row:focus-visible td { background: color-mix(in srgb, var(--edge) 40%, transparent); }
.steps tbody tr.step-row[aria-expanded="true"] td { background: var(--panel); }
.steps tbody tr.step-row.bad td { background: rgba(248, 81, 73, 0.07); }
.steps tbody tr.step-row.bad:hover td { background: rgba(248, 81, 73, 0.13); }
td.chev-cell { width: 24px; padding-left: 8px; }
.chev { color: var(--faint); font-size: 10px; user-select: none; }
td.status { width: 44px; text-align: center; font-weight: 700; }
td.status .ok, .assr .ok { color: var(--pass); }
td.status .bad, .assr .bad { color: var(--fail); font-weight: 700; }
td.stepid { color: var(--accent); white-space: nowrap; }
.action .main { color: var(--dim); word-break: break-all; }
.action .sub { color: var(--faint); font-size: 11px; word-break: break-all; margin-top: 2px; }
table.assr { border-collapse: collapse; min-width: 260px; }
.assr td { border: 1px solid var(--edge); padding: 2px 8px; font-size: 12px; }
.assr .f { color: var(--dim); }
.assr .v { color: var(--faint); }
.assr td:last-child { text-align: center; }
.detail { color: var(--dim); word-break: break-all; }
.detail.fail { color: var(--fail); }
td.num { text-align: right; color: var(--faint); white-space: nowrap; }
/* -- expanded step detail (app StepDetails parity) -- */
tr.step-detail td { background: var(--ink); padding: 12px 16px; }
.step-details { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.sec-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--dim); margin-bottom: 6px;
}
.def-line { font-size: 12px; margin-bottom: 8px; word-break: break-all; }
.def-line .muted { color: var(--dim); }
.def-line .val { color: var(--fg); }
.res-line { font-size: 12px; word-break: break-all; }
.res-line.ok { color: var(--pass); }
.res-line.bad { color: var(--fail); }
pre.received {
  margin-top: 8px; background: var(--panel); border: 1px solid var(--edge);
  border-radius: 4px; padding: 8px; overflow: auto; max-height: 192px;
  font-size: 11px; color: var(--dim);
}
.kv { border: 1px solid var(--edge); border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
.kv .label {
  padding: 4px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--dim); background: var(--panel); border-bottom: 1px solid var(--edge);
}
.kv .row { display: grid; grid-template-columns: max-content 1fr; font-size: 11px; }
.kv .k { padding: 4px 8px; color: var(--faint); text-align: right; user-select: none; border-right: 1px solid var(--edge); }
.kv .v { padding: 4px 8px; word-break: break-all; }
.kv .row + .row .k, .kv .row + .row .v { border-top: 1px solid var(--edge); }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">PAYMENTS TEST HARNESS <span class="sep">·</span> RUN REPORT</div>
  <div class="right">
    ${badge}
    <button id="theme-toggle" class="toggle" type="button" title="Toggle color theme">${SUN_SVG}<span>light</span></button>
  </div>
</header>
<main>
  <h1>${esc(suite.name)}</h1>
  ${suite.description ? `<p class="desc">${esc(suite.description)}</p>` : ""}
  <div class="meta">ran ${esc(at)}</div>
  <div class="summary">
    <div class="cell"><div class="k">steps</div><div class="v">${total}</div></div>
    <div class="cell"><div class="k">passed</div><div class="v pass">${result.passed}</div></div>
    <div class="cell"><div class="k">failed</div><div class="v ${result.failed ? "fail" : ""}">${result.failed}</div></div>
    <div class="cell"><div class="k">duration</div><div class="v">${result.durationMs} ms</div></div>
  </div>
  <div class="timeline">
    <div class="tl-head" id="tl-head" role="button" tabindex="0" aria-expanded="true">
      <span><span class="chev">▾</span> timeline</span>
      <span class="total">${timedTotal} ms total</span>
    </div>
    <div class="tl-body" id="tl-body">
${timelineRows(suite, steps, timedTotal)}
    </div>
  </div>
  <table class="steps">
    <thead>
      <tr>
        <th></th>
        <th>status</th>
        <th>step</th>
        <th>action</th>
        <th>assertions</th>
        <th style="text-align:right">time</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</main>
<script>
const SUN = ${JSON.stringify(SUN_SVG)};
const MOON = ${JSON.stringify(MOON_SVG)};
${INTERACT_JS}
</script>
</body>
</html>
`;
}

/**
 * Write the report to <destDir>/<suite>_<ts>.html. Returns the file path.
 * The caller wraps in try/catch if a failure must not matter (the runner
 * does — reports are best-effort).
 */
export function writeHtmlReport(
  input: ReportInput,
  destDir: string,
  ts: string,
): string {
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, `${input.suite.name}_${ts}.html`);
  fs.writeFileSync(file, renderHtmlReport(input));
  return file;
}
