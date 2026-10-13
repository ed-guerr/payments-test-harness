import { useEffect, useState } from "react";
import { useHarness } from "../store";
import type { DbRow } from "../env";

const DEFAULT_SQL = "SELECT * FROM accounts";

/**
 * Database — read-only SQL viewer over the per-suite databases written by
 * the last run (harness/data/<suite>.db). Opened read-only in the main
 * process per query.
 */
export function DbPage(): JSX.Element {
  void useHarness(); // re-renders when runs finish (fresh .db files)
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState("");
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [rows, setRows] = useState<DbRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.harness.dataFiles().then((f) => {
      setFiles(f);
      setFile((cur) => cur || f[0] || "");
    });
  }, []);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { rows } = await window.harness.dataQuery(file, sql);
      setRows(rows);
    } catch (e) {
      setError((e as Error).message);
      setRows(null);
    } finally {
      setBusy(false);
    }
  };

  const cols = rows && rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Database</h2>
      <p className="text-xs text-muted mb-4">
        Read-only queries against the per-suite databases from the last run (each suite gets its own
        file).
      </p>

      <div className="flex gap-3 items-center mb-3">
        <select
          value={file}
          onChange={(e) => setFile(e.target.value)}
          className="text-xs bg-panel border border-edge rounded px-2 py-1.5 font-mono"
        >
          {files.length === 0 && <option value="">no databases yet — run a suite first</option>}
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <input
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          className="flex-1 text-xs bg-panel border border-edge rounded px-3 py-1.5 font-mono"
          placeholder="SELECT …"
        />
        <button
          onClick={() => void run()}
          disabled={busy || !file}
          className="text-xs px-3 py-1.5 rounded bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40"
        >
          {busy ? "…" : "Run"}
        </button>
      </div>

      {error && <p className="text-xs text-fail mb-3">{error}</p>}

      {rows && (
        <div className="border border-edge rounded overflow-auto max-h-[520px]">
          <table className="w-full text-xs">
            <thead className="bg-panel text-muted sticky top-0">
              <tr>
                {cols.map((c) => (
                  <th key={c} className="text-left px-3 py-2 font-mono whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-edge/50">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-1.5 font-mono text-dim whitespace-nowrap">
                      {r[c] === null ? <span className="text-muted">NULL</span> : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-3 py-2 text-muted">0 rows</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
