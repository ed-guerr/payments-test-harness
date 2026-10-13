/**
 * db/db.test.ts — the driver-level half of the security model: even if a
 * DML statement ever reaches the database, the read-only connection the
 * runner's dbAssert path uses must refuse it. These tests pin the behavior
 * docs/security.md relies on (roadmap R4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "./db";

test("read-only connection refuses DDL and never mutates the seed data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dbtest-"));
  const file = path.join(dir, "t.db");
  try {
    const rw = Db.open(file); // creates + seeds
    rw.close();
    const ro = Db.readOnly(file);
    // 1) direct DDL on the read-only handle: refused by the driver
    assert.throws(() => ro.run("DROP TABLE accounts"), /readonly|read-only/i);
    // 2) DML: refused as well
    assert.throws(() => ro.run("UPDATE accounts SET balance_cents = 0"), /readonly|read-only/i);
    // 3) the seed is intact
    const n = ro.get("SELECT COUNT(*) AS c FROM accounts") as { c: number } | undefined;
    assert.equal(n?.c, 3, "all three seeded accounts still present");
    ro.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
