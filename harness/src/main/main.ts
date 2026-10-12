/**
 * main/main.ts — Electron main process.
 *
 * Owns the backend cluster lifecycle and exposes a small IPC surface to the
 * renderer: suite listing/running, runner event stream, and read-only SQL
 * against the per-suite databases. The renderer is sandboxed
 * (contextIsolation, no nodeIntegration) — everything goes through preload.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { BackendCluster } from "../backend/cluster";
import { backendBuildDir, DATA_DIR, RUNS_DIR, SUITES_DIR } from "../backend/paths";
import { listSuites, loadSuite } from "../backend/suites";
import { Db, DbRow } from "../db/db";
import { Runner } from "../runner/runner";
import type { RunnerEvent, SuiteResult } from "../runner/runner";

// User-facing paths anchor to the package root via paths.ts (package.json
// lookup), so they work identically under tsx and the compiled dist layout.

/** Events pushed to the renderer on the runner:event channel. */
type UiEvent = RunnerEvent | { type: "backend-log"; proc: string; line: string };

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
    const runner = new Runner(cluster.conns, cluster.db, (e) => sendUi(e), { runsDir: RUNS_DIR() });
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

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  if (process.env.HARNESS_SELF_TEST) {
    const code = await selfTest();
    app.exit(code);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
