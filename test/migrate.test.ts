import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { hasForgettingSchema, migrate } from "../src/migrate.ts";
import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

function columns(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("PRAGMA table_info(l1_records)").all() as unknown as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

test("migration adds every forgetting column with safe defaults", () => {
  const db = createTempDb();
  try {
    assert.equal(hasForgettingSchema(db.path), false);
    const result = migrate(db.path);
    assert.deepEqual(result.addedColumns.sort(), [
      "access_count",
      "forget_reason",
      "forgotten_time",
      "last_access_time",
      "state",
    ]);
    assert.equal(hasForgettingSchema(db.path), true);

    const cols = columns(db.path);
    for (const name of ["state", "access_count", "last_access_time", "forget_reason", "forgotten_time"]) {
      assert.ok(cols.includes(name), `missing ${name}`);
    }
  } finally {
    db.cleanup();
  }
});

test("existing rows become active with zero access, not null", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [makeRecord({ record_id: "old" })]);
    migrate(db.path);
    const [record] = loadRecords(db.path);
    assert.equal(record.state, "active");
    assert.equal(record.access_count, 0);
    assert.equal(record.last_access_time, null);
  } finally {
    db.cleanup();
  }
});

test("migration is idempotent", () => {
  const db = createTempDb();
  try {
    const first = migrate(db.path);
    const second = migrate(db.path);
    assert.equal(first.addedColumns.length, 5);
    assert.deepEqual(second.addedColumns, []);
    assert.equal(second.existingColumns.length, 5);
  } finally {
    db.cleanup();
  }
});

test("the recall view hides anything not active", () => {
  const db = createTempDb();
  try {
    // Migrate first: the fixture only carries the state column once it exists,
    // which is also the real adoption order (migrate, then write states).
    migrate(db.path);
    insertRecords(db.path, [
      makeRecord({ record_id: "live", state: "active" }),
      makeRecord({ record_id: "gone", state: "archived" }),
    ]);
    const conn = new DatabaseSync(db.path, { readOnly: true });
    const ids = (conn.prepare("SELECT record_id FROM l1_recallable").all() as unknown as Array<{ record_id: string }>).map(
      (r) => r.record_id,
    );
    conn.close();
    assert.deepEqual(ids.sort(), ["live"]);
  } finally {
    db.cleanup();
  }
});

test("migration refuses a database that is not a tdai store", () => {
  const db = createTempDb();
  try {
    const conn = new DatabaseSync(db.path);
    conn.exec("DROP TABLE l1_records");
    conn.close();
    assert.throws(() => migrate(db.path), /l1_records not found/);
  } finally {
    db.cleanup();
  }
});

test("an unmigrated database still reads, with neutral defaults", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [makeRecord({ record_id: "a" })]);
    const [record] = loadRecords(db.path);
    assert.equal(record.state, "active");
    assert.equal(record.access_count, 0);
  } finally {
    db.cleanup();
  }
});
