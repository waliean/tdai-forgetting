/**
 * Schema migration.
 *
 * Adds the five things tdai's L1 table is missing for any value-based policy: a
 * lifecycle state, an access counter, an access timestamp, and two fields that
 * explain why a record left the active set. Everything is additive with defaults,
 * so an unmigrated reader (upstream code) keeps working unchanged after the
 * migration runs.
 *
 * Deliberately no physical delete anywhere. "Forgetting" here means "stops being
 * recalled", which is reversible and auditable. Purging bytes is a separate,
 * manual decision — the research notes have the reasoning (docs/research, the
 * Letta/MemGPT entry).
 */

import { DatabaseSync } from "node:sqlite";

export const FORGETTING_SCHEMA_VERSION = 1;

/**
 * Idempotent column additions. SQLite has no ADD COLUMN IF NOT EXISTS, so the
 * runner checks PRAGMA table_info first; this list is the source of truth for
 * what the migration guarantees.
 */
export const COLUMN_ADDITIONS: Array<{ name: string; ddl: string }> = [
  { name: "state", ddl: "ALTER TABLE l1_records ADD COLUMN state TEXT NOT NULL DEFAULT 'active'" },
  { name: "access_count", ddl: "ALTER TABLE l1_records ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0" },
  { name: "last_access_time", ddl: "ALTER TABLE l1_records ADD COLUMN last_access_time TEXT DEFAULT NULL" },
  { name: "forget_reason", ddl: "ALTER TABLE l1_records ADD COLUMN forget_reason TEXT DEFAULT NULL" },
  { name: "forgotten_time", ddl: "ALTER TABLE l1_records ADD COLUMN forgotten_time TEXT DEFAULT NULL" },
];

export const INDEX_DDL: string[] = [
  "CREATE INDEX IF NOT EXISTS idx_l1_state ON l1_records(state)",
  "CREATE INDEX IF NOT EXISTS idx_l1_last_access ON l1_records(last_access_time)",
  "CREATE INDEX IF NOT EXISTS idx_l1_access_count ON l1_records(access_count)",
];

/**
 * Audit table. One row per state transition, never updated, never deleted.
 * `score` is the retention score at decision time, so a reviewer can reproduce
 * why a record was chosen without re-running the policy against a corpus that has
 * since changed.
 */
export const AUDIT_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS forgetting_audit (
     audit_id       TEXT PRIMARY KEY,
     run_id         TEXT NOT NULL,
     record_id      TEXT NOT NULL,
     action         TEXT NOT NULL,
     from_state     TEXT NOT NULL,
     to_state       TEXT NOT NULL,
     score          REAL NOT NULL,
     reason         TEXT NOT NULL,
     decided_at     TEXT NOT NULL,
     decided_at_ms  INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_forgetting_audit_run ON forgetting_audit(run_id)",
  "CREATE INDEX IF NOT EXISTS idx_forgetting_audit_record ON forgetting_audit(record_id)",
];

/** One row per plan execution, so a run can be summarised or reviewed as a unit. */
export const RUN_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS forgetting_runs (
     run_id        TEXT PRIMARY KEY,
     started_at    TEXT NOT NULL,
     finished_at   TEXT,
     mode          TEXT NOT NULL,
     actor         TEXT NOT NULL DEFAULT 'unknown',
     policy_json   TEXT NOT NULL,
     total         INTEGER NOT NULL DEFAULT 0,
     pinned        INTEGER NOT NULL DEFAULT 0,
     archived      INTEGER NOT NULL DEFAULT 0,
     retired       INTEGER NOT NULL DEFAULT 0,
     kept          INTEGER NOT NULL DEFAULT 0,
     status        TEXT NOT NULL DEFAULT 'running',
     notes         TEXT
   )`,
];

/**
 * Retrieval view. The patched search path selects from here so archived and
 * retired rows disappear from recall without changing the table shape. One filter
 * in one place beats `state = 'active'` scattered across five query sites.
 */
export const RECALL_VIEW_DDL: string[] = [
  "DROP VIEW IF EXISTS l1_recallable",
  `CREATE VIEW l1_recallable AS
     SELECT * FROM l1_records WHERE state = 'active'`,
];

export interface MigrationResult {
  addedColumns: string[];
  existingColumns: string[];
  createdTables: string[];
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Bring a database up to the forgetting schema. Safe to run on every start and on
 * a database that is already migrated.
 */
export function migrate(dbPath: string): MigrationResult {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const existing = tableColumns(db, "l1_records");
    if (existing.size === 0) {
      throw new Error(`l1_records not found in ${dbPath}: is this a tdai memory database?`);
    }

    const added: string[] = [];
    const already: string[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const column of COLUMN_ADDITIONS) {
        if (existing.has(column.name)) {
          already.push(column.name);
          continue;
        }
        db.exec(column.ddl);
        added.push(column.name);
      }
      for (const ddl of [...INDEX_DDL, ...AUDIT_DDL, ...RUN_DDL, ...RECALL_VIEW_DDL]) {
        db.exec(ddl);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      throw err;
    }

    return {
      addedColumns: added,
      existingColumns: already,
      createdTables: ["forgetting_audit", "forgetting_runs", "l1_recallable"],
    };
  } finally {
    db.close();
  }
}

/** Column check used by readers that must not assume the migration has run. */
export function hasForgettingSchema(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = tableColumns(db, "l1_records");
    return cols.has("state") && cols.has("access_count") && cols.has("last_access_time");
  } finally {
    db.close();
  }
}
