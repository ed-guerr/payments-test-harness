/**
 * backend/cluster.ts — start/stop the three backend processes against a
 * given database. Shared by the headless CLI and the Electron main process.
 */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Db } from "../db/db";
import * as codec from "../protocol/codec";
import { Conn } from "../protocol/conn";
import { sleep } from "../runner/runner";

export class BackendCluster {
  private procs: Record<string, ChildProcess> = {};
  conns: Record<string, Conn> = {};
  db: Db;
  running = false;

  private constructor(db: Db) {
    this.db = db;
  }

  /** Start a fresh cluster: new database (schema + seed) + three processes. */
  static async start(binDir: string, dbFile: string, onLog: (proc: string, line: string) => void = () => undefined): Promise<BackendCluster> {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
    const db = Db.open(dbFile);
    const cluster = new BackendCluster(db);
    try {
      for (const proc of codec.listProcs()) {
        const bin = path.join(binDir, proc);
        if (!fs.existsSync(bin)) throw new Error(`missing backend binary ${bin} — run \`make\` in backend/`);
        const child = spawn(bin, ["--db", dbFile], { stdio: ["ignore", "pipe", "pipe"] });
        child.stderr?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n")) if (line) onLog(proc, line);
        });
        child.stdout?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n")) if (line) onLog(proc, line);
        });
        cluster.procs[proc] = child;
      }
      for (const proc of codec.listProcs()) {
        const port = Number(codec.getProc(proc).listen.split(":")[1]);
        cluster.conns[proc] = await cluster.connectWithRetry(proc, port);
      }
      cluster.running = true;
      return cluster;
    } catch (e) {
      await cluster.stop();
      throw e;
    }
  }

  /** Chaos step: kill one backend process mid-run. False if not running. */
  kill(proc: string, signal: NodeJS.Signals = "SIGKILL"): boolean {
    const child = this.procs[proc];
    if (!child) return false;
    return child.kill(signal);
  }

  async stop(): Promise<void> {
    for (const c of Object.values(this.conns)) c.close();
    this.conns = {};
    for (const p of Object.values(this.procs)) p.kill("SIGKILL");
    this.procs = {};
    this.running = false;
    this.db.close();
  }

  private async connectWithRetry(proc: string, port: number): Promise<Conn> {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const c = await Conn.connect(port);
        c.on("error", () => undefined); // protocol failures surface via recv()
        return c;
      } catch {
        if (Date.now() > deadline) throw new Error(`${proc} on port ${port} not reachable within 5s`);
        await sleep(100);
      }
    }
  }
}
