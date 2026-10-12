/**
 * kb/index.ts — deterministic retrieval over the intern guides.
 *
 * No vector DB: the corpus is ~15 small, section-schema'd markdown files, so
 * term scoring is explainable, unit-testable, and never flaky — which matters
 * when the output is agent-authored artifacts (plan §6.4).
 *
 * Scoring:
 *   - tokenize query (lowercase, split on non-alphanumeric, drop stopwords)
 *   - split each guide into sections at "## " headings
 *   - 3x per distinct query term in the heading
 *   - 2x per term in table rows (Messages / Domain vocabulary / Risks)
 *   - 1x per term in body text
 */
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../backend/paths";

const KB_DIR = (): string => path.join(packageRoot(), "..", "knowledge");

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "that", "this",
  "with", "how", "does", "what", "when", "who", "it", "be", "as", "at", "by", "from", "not",
  "can", "should", "would", "could", "into", "out", "up", "down", "verify", "check", "test",
]);

export interface KbSection {
  path: string;
  section: string;
  score: number;
  excerpt: string;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface Section {
  title: string;
  lines: string[];
}

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: "(intro)", lines: [] };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      if (current.lines.length > 0 || current.title !== "(intro)") sections.push(current);
      current = { title: line.slice(3).trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.title !== "(intro)") sections.push(current);
  return sections;
}

const TABLE_HEAVY = /messages|vocabulary|risks|files|functions|interactions/i;

export function scoreSection(title: string, lines: string[], terms: string[]): number {
  if (terms.length === 0) return 0;
  let score = 0;
  const heading = title.toLowerCase();
  const bodyLines: string[] = [];
  const tableLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("|")) tableLines.push(line);
    else bodyLines.push(line);
  }
  const tableWeight = TABLE_HEAVY.test(title) ? 2 : 1;
  const seen = new Set<string>();
  for (const term of terms) {
    if (heading.includes(term) && !seen.has("h:" + term)) {
      score += 3;
      seen.add("h:" + term);
    }
  }
  const tableText = tableLines.join("\n").toLowerCase();
  const bodyText = bodyLines.join("\n").toLowerCase();
  for (const term of terms) {
    if (tableText.includes(term)) score += tableWeight;
    if (bodyText.includes(term)) score += 1;
  }
  return score;
}

function guidePaths(): string[] {
  const kb = KB_DIR();
  if (!fs.existsSync(kb)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(path.join(d, entry.name), child);
      else if (entry.name.endsWith(".md")) out.push(child);
    }
  };
  walk(kb, "");
  return out;
}

export function kbSearch(query: string, limit = 5): KbSection[] {
  const terms = tokenize(query);
  const hits: KbSection[] = [];
  for (const rel of guidePaths()) {
    const file = path.join(KB_DIR(), rel);
    const md = fs.readFileSync(file, "utf8");
    for (const s of splitSections(md)) {
      const score = scoreSection(s.title, s.lines, terms);
      if (score === 0) continue;
      const excerpt = s.lines.slice(0, 40).join("\n").trimEnd();
      hits.push({ path: `knowledge/${rel}`, section: s.title, score, excerpt });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Read a guide (or a single section by title). Paths are confined to knowledge/. */
export function kbRead(relPath: string, section?: string): string {
  const kb = KB_DIR();
  const resolved = path.resolve(kb, relPath.replace(/^knowledge\//, ""));
  if (!resolved.startsWith(kb + path.sep) && resolved !== kb) throw new Error(`path escapes knowledge/: ${relPath}`);
  if (!fs.existsSync(resolved) || !resolved.endsWith(".md")) throw new Error(`no such guide: ${relPath}`);
  const md = fs.readFileSync(resolved, "utf8");
  if (!section) return md;
  const s = splitSections(md).find((x) => x.title.toLowerCase() === section.toLowerCase());
  if (!s) throw new Error(`no section "${section}" in ${relPath}`);
  return `## ${s.title}\n\n${s.lines.join("\n").trimEnd()}`;
}
