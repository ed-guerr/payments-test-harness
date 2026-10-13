/**
 * bench.ts — single-client sequential benchmark of the wire protocol + backend.
 *
 * Starts a fresh backend cluster, sends N sequential TransferFunds
 * (one in flight at a time), and reports throughput + ack-latency
 * percentiles. Each op is a full round trip: framed request out, C
 * handler executes (SQLite read/validate/commit), framed ack back.
 * Transfers ping-pong between the two seeded accounts so balances stay
 * bounded regardless of N.
 *
 * Usage: npm run bench [-- <ops>]   (default 500 measured ops, 50 warmup)
 */

import path from "node:path";
import { BackendCluster } from "./backend/cluster";
import { backendBuildDir, DATA_DIR } from "./backend/paths";
import { findMessage, pack, unpack } from "./protocol/codec";

const MEASURED = Number(process.argv[2] ?? 500);
const WARMUP = 50;
const TXN_BASE = 9000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function fmtMs(v: number): string {
  return v < 1 ? `${(v * 1000).toFixed(0)} μs` : `${v.toFixed(2)} ms`;
}

async function main() {
  const cluster = await BackendCluster.start(backendBuildDir(), path.join(DATA_DIR(), "bench.db"));
  try {
    const conn = cluster.conns["ledger"];
    if (!conn) throw new Error("no connection to ledger");
    const m = findMessage("ledger", "TransferFunds");
    const latencies: number[] = [];
    let firstError: string | null = null;

    const run = async (txnId: number): Promise<number> => {
      const aToB = (WARMUP + (txnId - TXN_BASE)) % 2 === 0;
      const payload = pack("ledger", "TransferFunds", {
        txn_id: txnId,
        from_acct: aToB ? "ACCT-001" : "ACCT-002",
        to_acct: aToB ? "ACCT-002" : "ACCT-001",
        amount_cents: 10000,
      });
      const t0 = performance.now();
      conn.send(m.id, payload);
      const frame = await conn.recv(5000);
      const dt = performance.now() - t0;
      const ack = unpack("ledger", "TransferAck", frame.payload);
      if (frame.msgId === 255 || ack.status !== 0) {
        firstError = `txn ${txnId}: msgId=${frame.msgId} status=${ack.status}`;
      }
      return dt;
    };

    for (let i = 0; i < WARMUP; i++) await run(TXN_BASE + i);
    const t0 = performance.now();
    for (let i = 0; i < MEASURED; i++) {
      const dt = await run(TXN_BASE + WARMUP + i);
      latencies.push(dt);
      if (firstError) break;
    }
    const totalMs = performance.now() - t0;

    if (firstError) {
      console.error(`bench failed: ${firstError}`);
      process.exitCode = 1;
      return;
    }

    latencies.sort((a, b) => a - b);
    const ops = latencies.length;
    const throughput = (ops / (totalMs / 1000)).toFixed(0);
    const row = {
      ops,
      throughputPerSec: Number(throughput),
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99),
      maxMs: latencies[latencies.length - 1] ?? 0,
    };
    // Markdown row for the README benchmark table (one row per run).
    console.log(
      `| ${row.ops} | ${row.throughputPerSec} | ${fmtMs(row.p50Ms)} | ${fmtMs(row.p95Ms)} | ${fmtMs(row.p99Ms)} | ${fmtMs(row.maxMs)} |`,
    );
    console.error(`bench json: ${JSON.stringify(row)}`);
  } finally {
    await cluster.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
