import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { FORGETTING_SCHEMA_VERSION, hasForgettingSchema, migrate } from "../src/migrate.ts";
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

/** Row ids currently visible through the patched search path's view. */
function recallableIds(dbPath: string): string[] {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (conn.prepare("SELECT record_id FROM l1_recallable").all() as unknown as Array<{ record_id: string }>)
      .map((r) => r.record_id)
      .sort();
  } finally {
    conn.close();
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
      "invalid_at",
      "last_access_time",
      "state",
      "superseded_by",
    ]);
    assert.equal(hasForgettingSchema(db.path), true);

    const cols = columns(db.path);
    for (const name of [
      "state",
      "access_count",
      "last_access_time",
      "forget_reason",
      "forgotten_time",
      "invalid_at",
      "superseded_by",
    ]) {
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
    assert.equal(first.addedColumns.length, 7);
    assert.deepEqual(second.addedColumns, []);
    assert.equal(second.existingColumns.length, 7);
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
    assert.deepEqual(recallableIds(db.path), ["live"]);
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

test("a v1 database that already has the lifecycle columns is recognised as v1", () => {
  const db = createTempDb();
  try {
    // Build the v1 generation by hand: exactly the columns 0101 added, none of the
    // invalidation ones. This is the shape a database migrated by canvas R is in,
    // and the version inference has to tell it apart from a fresh v2 migration.
    const conn = new DatabaseSync(db.path);
    conn.exec("ALTER TABLE l1_records ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
    conn.exec("ALTER TABLE l1_records ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
    conn.exec("ALTER TABLE l1_records ADD COLUMN last_access_time TEXT DEFAULT NULL");
    conn.exec("ALTER TABLE l1_records ADD COLUMN forget_reason TEXT DEFAULT NULL");
    conn.exec("ALTER TABLE l1_records ADD COLUMN forgotten_time TEXT DEFAULT NULL");
    conn.close();

    const result = migrate(db.path);
    assert.equal(result.fromVersion, 1, "a database without the invalidation columns is v1");
    assert.equal(result.toVersion, 2);
    assert.deepEqual(result.addedColumns.sort(), ["invalid_at", "superseded_by"]);
    assert.equal(result.existingColumns.length, 5, "the five v1 columns were already there");
  } finally {
    db.cleanup();
  }
});

test("migrating a fresh v1 database records the crossing from 1 to 2", () => {
  const db = createTempDb();
  try {
    const result = migrate(db.path);
    assert.equal(result.fromVersion, 1);
    assert.equal(result.toVersion, 2);
    assert.equal(FORGETTING_SCHEMA_VERSION, 2);

    const again = migrate(db.path);
    assert.equal(again.fromVersion, 2, "the second run sees a v2 database");
    assert.deepEqual(again.addedColumns, []);
  } finally {
    db.cleanup();
  }
});

test("the index on invalid_at exists, so the view filter can use it", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    const conn = new DatabaseSync(db.path, { readOnly: true });
    const names = (conn.prepare("PRAGMA index_list(l1_records)").all() as unknown as Array<{ name: string }>).map(
      (i) => i.name,
    );
    conn.close();
    assert.ok(names.includes("idx_l1_invalid_at"), `expected idx_l1_invalid_at in ${names.join(", ")}`);
  } finally {
    db.cleanup();
  }
});

test("the recall view hides an invalidated record that is still active", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    insertRecords(db.path, [
      makeRecord({ record_id: "current", state: "active" }),
      makeRecord({ record_id: "superseded", state: "active", invalid_at: "2026-10-01T00:00:00.000Z", superseded_by: "current" }),
      makeRecord({ record_id: "cancelled", state: "active", invalid_at: "2026-10-02T00:00:00.000Z" }),
      makeRecord({ record_id: "gone", state: "archived" }),
    ]);
    // The state filter alone would let all three active rows through. Invalidation
    // is a separate claim, and this is the assertion that says so.
    assert.deepEqual(recallableIds(db.path), ["current"]);
  } finally {
    db.cleanup();
  }
});

test("clearing invalid_at puts a record back on the recall path", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    insertRecords(db.path, [
      makeRecord({ record_id: "current", state: "active" }),
      makeRecord({ record_id: "superseded", state: "active", invalid_at: "2026-10-01T00:00:00.000Z", superseded_by: "current" }),
    ]);
    assert.deepEqual(recallableIds(db.path), ["current"]);

    const conn = new DatabaseSync(db.path);
    conn.exec("UPDATE l1_records SET invalid_at = NULL, superseded_by = NULL WHERE record_id = 'superseded'");
    conn.close();

    // Undoing an invalidation is a one-column update, which is the whole reason
    // invalid_at is not folded into state.
    assert.deepEqual(recallableIds(db.path), ["current", "superseded"]);
  } finally {
    db.cleanup();
  }
});

test("loadRecords survives a v1 database, reporting nothing invalidated", () => {
  const db = createTempDb();
  try {
    // v1 shape again, with a row planted before migrating: the reader must not
    // assume invalid_at exists just because the lifecycle columns do.
    const conn = new DatabaseSync(db.path);
    conn.exec("ALTER TABLE l1_records ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
    conn.exec("ALTER TABLE l1_records ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
    conn.exec("ALTER TABLE l1_records ADD COLUMN last_access_time TEXT DEFAULT NULL");
    conn.close();
    insertRecords(db.path, [makeRecord({ record_id: "v1row", state: "active" })]);

    const [record] = loadRecords(db.path);
    assert.equal(record.record_id, "v1row");
    assert.equal(record.invalid_at, null);
    assert.equal(record.superseded_by, null);
  } finally {
    db.cleanup();
  }
});

test("loadRecords carries the invalidation columns through a v2 database", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    insertRecords(db.path, [
      makeRecord({ record_id: "newer", state: "active" }),
      makeRecord({ record_id: "older", state: "active", invalid_at: "2026-10-01T00:00:00.000Z", superseded_by: "newer" }),
    ]);
    const byId = Object.fromEntries(loadRecords(db.path).map((r) => [r.record_id, r]));
    assert.equal(byId.newer.invalid_at, null);
    assert.equal(byId.newer.superseded_by, null);
    assert.equal(byId.older.invalid_at, "2026-10-01T00:00:00.000Z");
    assert.equal(byId.older.superseded_by, "newer");
  } finally {
    db.cleanup();
  }
});
