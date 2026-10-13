/**
 * db/db.ts — SQLite access for the harness.
 *
 * Uses Node's built-in node:sqlite (DatabaseSync): no native module, so the
 * same code runs identically under system Node (headless CLI) and Electron's
 * Node (GUI) — no ABI rebuilds, no postinstall.
 *
 * The harness talks to the same database file the backend processes use (the
 * runner initializes it from backend/db/schema.sql and starts the binaries
 * with --db pointing at it), so dbAssert steps read real backend state.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { schemaFile } from "../backend/paths";

export interface DbRow {
  [col: string]: string | number | bigint | null;
}

export class Db {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync, public readonly file: string) {
    this.db = db;
  }

  /** Open (creating if needed) and initialize with the backend schema + seed data. */
  static open(file: string): Db {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(fs.readFileSync(schemaFile(), "utf8"));
    return new Db(db, file);
  }

  /** Open an existing database read-only (no schema execution). */
  static readOnly(file: string): Db {
    return new Db(new DatabaseSync(file, { readOnly: true }), file);
  }

  run(sql: string, params: (string | number | null)[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  get<T extends DbRow>(sql: string, params: (string | number | null)[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends DbRow>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.db.close();
  }
}

export interface CheckRowResult {
  /** Human-readable mismatches (empty = pass). */
  problems: string[];
  /** The row the query returned (null when no row matched). */
  row: DbRow | null;
}

/**
 * Assert that a single-row query result matches `expect` on the listed
 * columns (partial match, like wire acks). Returns the mismatches plus the
 * row itself (so callers can show expected vs actual).
 */
export function checkRow(
  db: Db,
  sql: string,
  params: (string | number | null)[],
  expect: Record<string, string | number | null>,
): CheckRowResult {
  const row = db.get(sql, params) ?? null;
  if (!row) return { problems: [`no row for: ${sql}`], row };
  const problems: string[] = [];
  for (const [col, want] of Object.entries(expect)) {
    const got = row[col];
    if (got !== want) problems.push(`${col}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return { problems, row };
}
