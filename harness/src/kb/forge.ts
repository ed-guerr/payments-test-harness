/**
 * kb/forge.ts — generates the intern guides into knowledge/.
 *
 * Pipeline (deterministic mode, no API key):
 *   1. Context assembly: file listing + line counts, extracted C/TS function
 *      and class signatures, message tables from the registry, TODO/FIXME markers, and
 *      a content hash of the source directory.
 *   2. Rendering: the fixed §6.2 section schema, combining the mechanical
 *      extraction with the curated facts in kb/meta.ts.
 *   3. Write: guide + knowledge/.manifest.json + knowledge/INDEX.md.
 *
 * LLM-enhanced mode (KB_API_KEY set, --llm): the assembled context and facts
 * go to an OpenAI-compatible chat endpoint under a strict
 * "cite file:line, never invent" prompt; the response replaces the prose
 * sections. Consumption never needs a key (the guides are committed).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { META, DirMeta } from "./meta";
import { packageRoot } from "../backend/paths";
import type { Registry } from "../protocol/types";
import registryJson from "../protocol/registry.json";

const KB_FORGE_VERSION = "0.2";
/** Attribution line in every generated guide header. */
const KB_AUTHOR = "Qwen3.8-27B (local, via pi coding agent)";
const REPO_ROOT = (): string => path.join(packageRoot(), "..");
const KB_DIR = (): string => path.join(REPO_ROOT(), "knowledge");
const registry = registryJson as unknown as Registry;

/* ------------------------------------------------------------------ */
/* Context assembly                                                    */
/* ------------------------------------------------------------------ */

interface FileRow {
  file: string;
  lines: number;
}

function listFiles(dir: string): FileRow[] {
  const out: FileRow[] = [];
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "build" && entry.name !== "dist") {
          walk(path.join(d, entry.name), `${rel}/${entry.name}`);
        }
        continue;
      }
      const ext = path.extname(entry.name);
      if (![".c", ".h", ".ts", ".tsx", ".css", ".html", ".json", ".sql", ".js"].includes(ext)) continue;
      const text = fs.readFileSync(path.join(d, entry.name), "utf8");
      out.push({ file: rel ? `${rel}/${entry.name}` : entry.name, lines: text.split("\n").length });
    }
  };
  walk(dir, "");
  return out;
}

interface FnRow {
  name: string;
  params: string;
  file: string;
  line: number;
}

/** Extract top-level C function definitions (Allman style: `{` on the next line). */
function extractCFunctions(dir: string): FnRow[] {
  const out: FnRow[] = [];
  const RESERVED = new Set(["if", "for", "while", "switch", "return", "sizeof"]);
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(path.join(d, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.name.endsWith(".c")) continue;
      const lines = fs.readFileSync(path.join(d, entry.name), "utf8").split("\n");
      const re = /^([A-Za-z_][A-Za-z0-9_ \t\*]*?)\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const m = re.exec(line);
        const fname = m?.[2];
        const fparams = m?.[3] ?? "";
        if (!m || !fname || RESERVED.has(fname)) continue;
        // find next non-blank line; Allman functions open with "{"
        let j = i + 1;
        while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
        if (j < lines.length && (lines[j] ?? "").trim().startsWith("{")) {
          out.push({ name: fname, params: fparams.replace(/\s+/g, " ").trim(), file: rel ? `${rel}/${entry.name}` : entry.name, line: i + 1 });
        }
      }
    }
  };
  walk(dir, "");
  return out;
}

/** Extract top-level TS/TSX function and class declarations (top-level = column 0). */
function extractTsFunctions(dir: string): FnRow[] {
  const out: FnRow[] = [];
  const FN_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
  const CLASS_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
  const SKIP = new Set(["node_modules", "build", "dist"]);
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP.has(entry.name)) walk(path.join(d, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const lines = fs.readFileSync(path.join(d, entry.name), "utf8").split("\n");
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const fn = FN_RE.exec(line);
        const cls = fn ? null : CLASS_RE.exec(line);
        if (fn) out.push({ name: fn[1] ?? "", params: (fn[2] ?? "").replace(/\s+/g, " ").trim(), file, line: i + 1 });
        else if (cls) out.push({ name: cls[1] ?? "", params: "", file, line: i + 1 });
      }
    }
  };
  walk(dir, "");
  return out;
}

/** Top-level function/class definitions: C (Allman) + TS/TSX (column 0). */
function extractFunctions(dir: string): FnRow[] {
  return [...extractCFunctions(dir), ...extractTsFunctions(dir)];
}

function extractTodos(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(p);
      else if (entry.isFile()) {
        const text = fs.readFileSync(p, "utf8");
        text.split("\n").forEach((line, i) => {
          if (/\b(TODO|FIXME)\b/.test(line)) out.push(`${path.relative(REPO_ROOT(), p)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(dir);
  return out;
}

/** Content hash of a source directory (stable: sorted file list + contents). */
export function hashDir(dir: string): string {
  const h = crypto.createHash("sha256");
  const files = listFiles(dir).sort((a, b) => a.file.localeCompare(b.file));
  for (const f of files) {
    h.update(f.file);
    h.update(fs.readFileSync(path.join(dir, f.file)));
  }
  return h.digest("hex").slice(0, 12);
}

export interface DirContext {
  meta: DirMeta;
  files: FileRow[];
  functions: FnRow[];
  messages: { name: string; id: number; direction: "in" | "out"; size: number }[];
  todos: string[];
  sourceHash: string;
}

/** Map a meta dir like backend/src/pay_orders to its registry process name. */
const PROCESS_FOR_DIR: Record<string, string> = {
  "backend/src/pay_orders": "pay-orders",
  "backend/src/ledger": "ledger",
  "backend/src/auth_gateway": "auth-gateway",
};

export function assembleContext(meta: DirMeta): DirContext {
  const dir = path.join(REPO_ROOT(), meta.dir);
  const proc = PROCESS_FOR_DIR[meta.dir];
  const messages = proc
    ? (registry.procs[proc]?.messages ?? []).map((m) => ({ name: m.name, id: m.id, direction: m.direction, size: m.size }))
    : [];
  return {
    meta,
    files: listFiles(dir),
    functions: extractFunctions(dir),
    messages,
    todos: extractTodos(dir),
    sourceHash: hashDir(dir),
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function mdTable(headers: string[], rows: (string | number)[][]): string {
  const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const r of rows) lines.push(`| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`);
  return lines.join("\n");
}

export function renderGuide(ctx: DirContext, generatedAt: string): string {
  const m = ctx.meta;
  const parts: string[] = [];
  parts.push(`# ${m.dir} — Intern Guide`);
  parts.push(`> written by ${KB_AUTHOR} · generated ${generatedAt} · kb-forge ${KB_FORGE_VERSION} · source sha256:${ctx.sourceHash}`);
  parts.push(`## Purpose`);
  parts.push(m.purpose);
  parts.push(`## Files`);
  parts.push(mdTable(["file", "~lines"], ctx.files.map((f) => [f.file, f.lines])));
  parts.push(`## Domain vocabulary`);
  parts.push(mdTable(["business term", "maps to"], m.vocabulary.map(([t, to]) => [`\`${t}\``, to])));
  if (ctx.messages.length > 0) {
    parts.push(`## Messages`);
    const rows = ctx.messages.map((msg) => {
      const note = m.messageNotes[msg.name] ?? { precondition: "—", sideEffect: "—" };
      return [`\`${msg.name}\` (${msg.id})`, msg.direction, note.precondition, note.sideEffect];
    });
    parts.push(mdTable(["message", "dir", "precondition", "side effect"], rows));
  }
  parts.push(`## Key functions`);
  if (ctx.functions.length === 0) {
    parts.push("_no top-level function or class declarations extracted for this directory_");
  } else {
    const rows = ctx.functions.map((f) => [f.params ? `\`${f.name}(${f.params})\`` : `\`${f.name}\``, `${f.file}:${f.line}`]);
    parts.push(mdTable(["function", "defined at"], rows));
  }
  parts.push(`## Common modification points`);
  for (const p of m.modificationPoints) parts.push(`- ${p}`);
  parts.push(`## Risks`);
  parts.push(mdTable(["area", "risk", "mitigation"], m.risks));
  parts.push(`## Inter-process interactions`);
  for (const i of m.interactions) parts.push(`- ${i}`);
  if (ctx.todos.length > 0) {
    parts.push(`## Open items (TODO/FIXME)`);
    for (const t of ctx.todos) parts.push(`- ${t}`);
  }
  return parts.join("\n\n") + "\n";
}

function renderRootIndex(prefix: string, entries: DirMeta[]): string {
  const parts: string[] = [`# ${prefix} — guide index`, ""];
  for (const e of entries) {
    parts.push(`- **[${e.guide.replace(prefix + "/", "")}](./${e.guide.replace(prefix + "/", "")})** — ${e.purpose.split(".")[0]}.`);
  }
  return parts.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* LLM-enhanced mode (optional)                                        */
/* ------------------------------------------------------------------ */

export async function llmEnhance(ctx: DirContext, baseGuide: string): Promise<string> {
  const key = process.env.KB_API_KEY;
  if (!key) throw new Error("KB_API_KEY is not set (deterministic mode only)");
  const provider = process.env.KB_PROVIDER ?? "openai";
  const model = process.env.KB_MODEL ?? "gpt-4o-mini";
  const baseUrl = (process.env.KB_BASE_URL ?? `https://api.${provider}.com/v1`).replace(/\/$/, "");
  const prompt = [
    "You are kb-forge, a codebase documentation agent. Rewrite the INTERN GUIDE below.",
    "Rules: keep EXACTLY these '## ' sections and their order; cite file:line for every claim;",
    "never invent — every message row must exist in the provided registry context; every risk",
    "must reference a real file; keep tables valid markdown. Return only the markdown.",
    "",
    `Context (files: ${ctx.files.map((f) => f.file).join(", ")})`,
    "",
    baseGuide,
  ].join("\n");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
  });
  if (!res.ok) throw new Error(`kb-forge LLM call failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("kb-forge LLM returned no content");
  return content.trimEnd() + "\n";
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

export interface ManifestEntry {
  path: string;
  sourceDir: string;
  sourceHash: string;
  generatedAt: string;
}

export interface ForgeResult {
  guides: { path: string; bytes: number }[];
  manifest: ManifestEntry[];
}

export async function forgeOne(meta: DirMeta, llm = false): Promise<{ path: string; bytes: number }> {
  const generatedAt = new Date().toISOString();
  const kb = KB_DIR();
  fs.mkdirSync(kb, { recursive: true });
  const ctx = assembleContext(meta);
  let guide = renderGuide(ctx, generatedAt);
  if (llm) guide = await llmEnhance(ctx, guide);
  const file = path.join(kb, meta.guide);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, guide);
  // keep the manifest entry in sync
  const manifestFile = path.join(kb, ".manifest.json");
  let manifest = { kbForgeVersion: KB_FORGE_VERSION, entries: [] as ManifestEntry[] };
  if (fs.existsSync(manifestFile)) manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.entries = manifest.entries.filter((e) => e.path !== `knowledge/${meta.guide}`);
  manifest.entries.push({ path: `knowledge/${meta.guide}`, sourceDir: meta.dir, sourceHash: ctx.sourceHash, generatedAt });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return { path: `knowledge/${meta.guide}`, bytes: guide.length };
}

export async function forgeAll(opts: { llm?: boolean } = {}): Promise<ForgeResult> {
  const kb = KB_DIR();
  fs.mkdirSync(kb, { recursive: true });
  const written: { path: string; bytes: number }[] = [];

  for (const meta of META) {
    const out = await forgeOne(meta, opts.llm);
    written.push(out);
  }

  // Root indexes per top-level area (backend/README.md, harness/README.md)
  const prefixes = [...new Set(META.map((m) => m.guide.split("/")[0] ?? ""))];
  for (const p of prefixes) {
    const entries = META.filter((m) => m.guide.startsWith(`${p}/`));
    const readme = renderRootIndex(p, entries);
    fs.writeFileSync(path.join(kb, p, "README.md"), readme);
    written.push({ path: `knowledge/${p}/README.md`, bytes: readme.length });
  }

  // INDEX.md
  const lines = ["# Knowledge base — index", "", "One intern guide per source directory (generated by kb-forge; regenerate, don't hand-edit).", ""];
  for (const e of META) {
    lines.push(`- [knowledge/${e.guide}](./${e.guide}) — ${e.purpose.split(".")[0]}.`);
  }
  fs.writeFileSync(path.join(kb, "INDEX.md"), lines.join("\n") + "\n");

  // Read back the manifest that forgeOne kept in sync.
  const manifestJson = JSON.parse(fs.readFileSync(path.join(kb, ".manifest.json"), "utf8")) as { entries: ManifestEntry[] };
  return { guides: written, manifest: manifestJson.entries };
}

/** Rehash sources and compare against the manifest; return stale guide paths. */
export function checkStale(): { guide: string; sourceDir: string; expected: string; actual: string }[] {
  const manifestFile = path.join(KB_DIR(), ".manifest.json");
  if (!fs.existsSync(manifestFile)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { entries: ManifestEntry[] };
  const stale: { guide: string; sourceDir: string; expected: string; actual: string }[] = [];
  for (const e of manifest.entries) {
    const actual = hashDir(path.join(REPO_ROOT(), e.sourceDir));
    if (actual !== e.sourceHash) stale.push({ guide: e.path, sourceDir: e.sourceDir, expected: e.sourceHash, actual });
  }
  return stale;
}
