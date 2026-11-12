/**
 * main/main.ts — Electron main process.
 *
 * Owns the backend cluster lifecycle and exposes a small IPC surface to the
 * renderer: suite listing/running, runner event stream, and read-only SQL
 * against the per-suite databases. The renderer is sandboxed
 * (contextIsolation, no nodeIntegration) — everything goes through preload.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendCluster } from "../backend/cluster";
import { backendBuildDir, DATA_DIR, RUNS_DIR, SUITES_DIR } from "../backend/paths";
import { listSuites, loadSuite, SuiteMeta } from "../backend/suites";
import { Db, DbRow } from "../db/db";
import { Runner } from "../runner/runner";
import type { RunnerEvent, SuiteResult } from "../runner/runner";

// User-facing paths anchor to the package root via paths.ts (package.json
// lookup), so they work identically under tsx and the compiled dist layout.

/** Events pushed to the renderer on the runner:event channel. */
type UiEvent =
  | RunnerEvent
  | { type: "backend-log"; proc: string; line: string }
  | { type: "suites-changed"; suites: SuiteMeta[] };

/**
 * Spawn a helper (stdio ignored) that SIGKILLs any surviving electron
 * descendants once this (browser) process has exited.
 *
 * Why: npm runs lifecycle scripts with piped stdio and only considers the
 * script finished when those pipes hit EOF. Our Chromium subtree (zygotes,
 * renderer, GPU, network utility) all inherit the pipe write ends — the
 * whole chain is stdio-inherit. In most environments the subtree exits
 * within a second of the browser, but on some CI runners it lingers
 * (the runner's D-Bus session is misconfigured — see the
 * "Failed to connect to the bus" lines in CI logs). One living descendant
 * keeps the pipes open and hangs the e2e step until timeout.
 *
 * The helper must act only AFTER the browser is dead: SIGKILLing the
 * GPU/zygote while the browser is still alive races with Chromium's
 * "GPU process isn't usable. Goodbye." FATAL and crashes the process
 * before exit can run (observed in CI). Being stdio-ignored, the helper
 * itself never holds the pipes and never delays npm.
 *
 * On the rare runner where the browser's *own* shutdown wedges (process
 * still alive ~10s after exit is requested — observed in CI on a
 * misconfigured D-Bus runner image), the helper's final pkill kills the
 * wedged browser too; the CI step then trusts the verdict file written
 * by the self-test instead of the (SIGKILL-derived) exit code.
 *
 * The helper appends a timeline to /tmp/pth-cleanup-helper.log (when the
 * browser died relative to helper start, what it had to kill) — the e2e
 * step dumps it for diagnosis.
 *
 * POSIX only (sh/pgrep): a no-op where they are unavailable, so the
 * process.exit() below still runs and behavior is unchanged.
 */
function spawnCleanupHelper(): void {
  const script = [
    "BROWSER=$1; BIN=$2; LOG=/tmp/pth-cleanup-helper.log",
    'echo "helper: start=$(date +%s) browser=$BROWSER helper_pid=$$" >> "$LOG" 2>/dev/null',
    // BFS-collect the descendant tree while the browser is still alive.
    'TREE=""; Q=$BROWSER',
    'while [ -n "$Q" ]; do',
    '  NEXT=""; for p in $Q; do',
    '    C=$(pgrep -P "$p" 2>/dev/null)',
    '    [ -n "$C" ] && NEXT="$NEXT $C"',
    "  done",
    '  TREE="$TREE $NEXT"; Q="$NEXT"',
    "done",
    'echo "helper: tree=[$TREE]" >> "$LOG" 2>/dev/null',
    // Wait for the browser to die (up to ~10s — a healthy exit takes
    // milliseconds), so killing its children can never race the
    // browser's own crash handling.
    "i=0",
    'while kill -0 "$BROWSER" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done',
    'if kill -0 "$BROWSER" 2>/dev/null; then BS=STILL-ALIVE; else BS=gone; fi',
    'echo "helper: browser=$BS after ${i} checks (t=$(date +%s))" >> "$LOG" 2>/dev/null',
    // Kill any survivors from the collected tree (minus this helper).
    "for p in $TREE; do",
    '  [ "$p" != "$$" ] && kill -9 "$p" 2>/dev/null',
    "done",
    // Belt and braces: also match by binary path, catching any child the
    // browser re-launched during shutdown (e.g. the network service) —
    // and, if the browser's shutdown wedged, the browser itself.
    `echo "helper: pkill-matches=[$(pgrep -f "$BIN" 2>/dev/null | tr '\\n' ' ')]" >> "$LOG" 2>/dev/null`,
    'pkill -9 -f "$BIN" 2>/dev/null',
    "exit 0",
  ].join("\n");
  try {
    // Note: with `sh -c script A B`, A is $0 and B is $1 — the
    // "cleanup-helper" argument is the $0 placeholder.
    const helper = spawn("sh", ["-c", script, "cleanup-helper", String(process.pid), process.execPath], { stdio: "ignore" });
    helper.unref();
    helper.on("error", () => {
      /* sh unavailable (e.g. Windows): process.exit() below still runs */
    });
  } catch {
    /* spawn failed: process.exit() below still runs */
  }
}

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0e14",
    title: "Payments Test Harness",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
}

function sendUi(e: UiEvent): void {
  win?.webContents.send("runner:event", e);
}

function registerIpc(): void {
  ipcMain.handle("suite:list", () => listSuites());

  ipcMain.handle("suite:read", (_e, name: string) => loadSuite(path.join(SUITES_DIR(), `${name}.json`)));

  ipcMain.handle("suite:run", async (_e, name: string): Promise<SuiteResult> => {
    const suite = loadSuite(path.join(SUITES_DIR(), `${name}.json`));
    const cluster = await BackendCluster.start(backendBuildDir(), path.join(DATA_DIR(), `${name}.db`), (proc, line) =>
      sendUi({ type: "backend-log", proc, line }),
    );
    const runner = new Runner(cluster.conns, cluster.db, (e) => sendUi(e), {
      runsDir: RUNS_DIR(),
      killProcess: (p, s) => cluster.kill(p, s),
    });
    try {
      return await runner.runSuite(suite);
    } finally {
      await cluster.stop();
    }
  });

  ipcMain.handle("data:files", () => {
    const dir = DATA_DIR();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
  });

  ipcMain.handle("data:query", (_e, file: string, sql: string): { rows: DbRow[] } => {
    // Read-only, opened fresh per query, so it works after the cluster is
    // torn down. Only SELECT statements are meaningful; SQLite's readonly
    // flag enforces it. File names come from data:files (no traversal).
    if (!/^\S+\.db$/.test(file)) throw new Error(`bad db file name: ${file}`);
    const db = Db.readOnly(path.join(DATA_DIR(), file));
    try {
      return { rows: db.all(sql) };
    } finally {
      db.close();
    }
  });
}

/**
 * Self-test (HARNESS_SELF_TEST=1): load the real window, then drive the
 * renderer through the actual preload bridge (executeJavaScript on the
 * webContents) — end-to-end IPC verification without a human clicking.
 * Exits 0 on success, 1 on failure. Used by CI and during development.
 */
async function selfTest(): Promise<number> {
  if (win && win.webContents.isLoading()) {
    await new Promise<void>((r) => win?.webContents.on("did-finish-load", () => r()));
  } else {
    await new Promise((r) => setTimeout(r, 500)); // load is (nearly) synchronous; settle
  }
  const call = async (expr: string): Promise<unknown> => win?.webContents.executeJavaScript(expr);

  const suites = (await call("window.harness.listSuites().then(r => r)")) as { name: string }[] | undefined;
  if (!suites || suites.length === 0) {
    console.error("self-test: listSuites failed");
    return 1;
  }
  console.log(`self-test: ${suites.length} suites visible: ${suites.map((s) => s.name).join(", ")}`);

  const result = (await call(
    "window.harness.runSuite('payment-happy-path').then(r => r)",
  )) as { ok: boolean; passed: number; failed: number } | undefined;
  if (!result) {
    console.error("self-test: runSuite IPC failed");
    return 1;
  }
  console.log(`self-test: payment-happy-path ${result.ok ? "PASSED" : "FAILED"} (${result.passed} steps)`);
  return result.ok ? 0 : 1;
}

/**
 * Watch harness/suites/ and push the refreshed list to the renderer (with a
 * short debounce to coalesce write bursts). This makes suites created outside
 * the app — e.g. by the MCP server or an editor — appear without a reload.
 * Half-written files make listSuites() throw; that event is skipped and the
 * next change re-emits.
 */
let suitesTimer: NodeJS.Timeout | null = null;
function startSuitesWatcher(): void {
  if (!fs.existsSync(SUITES_DIR())) return;
  fs.watch(SUITES_DIR(), () => {
    if (suitesTimer) clearTimeout(suitesTimer);
    suitesTimer = setTimeout(() => {
      try {
        sendUi({ type: "suites-changed", suites: listSuites() });
      } catch {
        /* transient state; next change re-emits */
      }
    }, 200);
  });
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  startSuitesWatcher();
  if (process.env.HARNESS_SELF_TEST) {
    const code = await selfTest();
    // Record the verdict before any shutdown work: on some runner images
    // the app's shutdown wedges (misconfigured D-Bus session bus — see
    // the ERROR:dbus lines in CI), the process then dies via the cleanup
    // helper's SIGKILL with a non-zero exit, and the CI step gates on
    // this file instead of that exit code.
    const verdictFile =
      process.env.HARNESS_SELF_TEST_RESULT || path.join(os.tmpdir(), "harness-self-test-result");
    fs.writeFileSync(verdictFile, String(code));
    console.log(`self-test: suite done (code=${code}); exiting now (pid=${process.pid})`);
    // Deterministic unwind: see spawnCleanupHelper().
    spawnCleanupHelper();
    // process.exit (not app.exit): the self-test needs no graceful app
    // shutdown, and a hard exit skips Electron's shutdown path — the
    // suspected wedge point on misconfigured runner images.
    process.exit(code);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
