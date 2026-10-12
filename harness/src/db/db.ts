/**
 * db/db.ts — SQLite access for the harness.
 *
 * The harness talks to the same database file the backend processes use
 * (the runner initializes it from backend/db/schema.sql and starts the
 * binaries with --db pointing at it), so dbAssert steps read real backend
 * state. better-sqlite3 is synchronous and single-connection, which fits
 * the runner's request/response rhythm.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface DbRow {
  [col: string]: string | number | null;
}

export class Db {
  private db: Database.Database;

  private constructor(db: Database.Database, public readonly file: string) {
    this.db = db;
  }

  /** Open (creating if needed) and initialize with the backend schema + seed data. */
  static open(file: string): Db {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    const schemaFile = path.join(__dirname, "..", "..", "..", "backend", "db", "schema.sql");
    db.exec(fs.readFileSync(schemaFile, "utf8"));
    return new Db(db, file);
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

/**
 * Assert that a single-row query result matches `expect` on the listed
 * columns (partial match, like wire acks). Returns a list of human-readable
 * mismatches (empty = pass).
 */
export function checkRow(
  db: Db,
  sql: string,
  params: (string | number | null)[],
  expect: Record<string, string | number | null>,
): string[] {
  const row = db.get(sql, params);
  if (!row) return [`no row for: ${sql}`];
  const problems: string[] = [];
  for (const [col, want] of Object.entries(expect)) {
    const got = row[col];
    if (got !== want) problems.push(`${col}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return problems;
}
