import { useState } from "react";
import registryJson from "../../protocol/registry.json";
import type { Registry } from "../../protocol/types";

const registry = registryJson as unknown as Registry;

/**
 * Protocol Registry — renders the introspection-generated registry.json:
 * the compiled function-pointer message tables, per process, with exact
 * wire offsets and sizes. This is the "single source of truth" view: the
 * codec, the UI forms, and the MCP schemas all derive from this data.
 */
export function RegistryPage(): JSX.Element {
  const procs = Object.keys(registry.procs);
  const [selected, setSelected] = useState(procs[0] ?? "");

  const proc = registry.procs[selected];

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Protocol Registry</h2>
      <p className="text-xs text-muted mb-4">
        Generated from the C binaries' <code className="text-accent">--introspect</code> output (
        {registry.generatedAt}). One table per process — the same tables the dispatchers iterate
        at runtime.
      </p>

      <div className="flex gap-2 mb-4">
        {procs.map((p) => (
          <button
            key={p}
            onClick={() => setSelected(p)}
            className={`text-xs px-3 py-1.5 rounded font-mono ${
              p === selected ? "bg-accent/20 text-accent" : "bg-edge text-muted hover:text-gray-200"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      {proc && (
        <div className="space-y-4">
          {proc.messages.map((m) => (
            <div key={m.id} className="border border-edge rounded bg-panel">
              <div className="px-4 py-2 flex items-center gap-3 border-b border-edge">
                <span className="text-xs font-mono text-muted">{m.id}</span>
                <span className="text-sm font-mono text-accent">{m.name}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted">{m.direction}</span>
                <span className="text-[10px] text-muted ml-auto">
                  {m.size} bytes
                  {m.response > 0 && <> · ack → {m.response}</>}
                </span>
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {m.fields.map((f) => (
                    <tr key={f.name} className="border-t border-edge/50">
                      <td className="px-4 py-1.5 font-mono text-gray-300">{f.name}</td>
                      <td className="px-2 py-1.5 font-mono text-muted">{f.type}</td>
                      <td className="px-2 py-1.5 font-mono text-muted">offset {f.offset}</td>
                      <td className="px-2 py-1.5 font-mono text-muted text-right">{f.size} B</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
