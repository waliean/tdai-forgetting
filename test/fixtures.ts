/**
 * Test fixtures.
 *
 * Builds a throwaway sqlite file shaped like tdai's L1 store, so applier and
 * migration tests exercise real SQL instead of a mock that can drift from the
 * schema upstream actually ships.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemoryRecord } from "../src/types.ts";

/** Verbatim shape of tdai's l1_records, minus the columns the migration adds. */
export const TDAI_L1_DDL = `
CREATE TABLE l1_records (
  record_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT DEFAULT '',
  priority INTEGER DEFAULT 50,
  scene_name TEXT DEFAULT '',
  session_key TEXT DEFAULT '',
  session_id TEXT DEFAULT 'default',
  team_id TEXT DEFAULT 'default',
  task_id TEXT DEFAULT '',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  version INTEGER NOT NULL DEFAULT 0,
  timestamp_str TEXT DEFAULT '',
  timestamp_start TEXT DEFAULT '',
  timestamp_end TEXT DEFAULT '',
  created_time TEXT DEFAULT '',
  updated_time TEXT DEFAULT '',
  metadata_json TEXT DEFAULT '{}'
)`;

export interface TempDb {
  path: string;
  dir: string;
  cleanup: () => void;
}

export function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "tdai-forgetting-"));
  const path = join(dir, "vectors.db");
  const db = new DatabaseSync(path);
  db.exec(TDAI_L1_DDL);
  db.close();
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function insertRecords(dbPath: string, records: MemoryRecord[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    const cols = (db.prepare("PRAGMA table_info(l1_records)").all() as unknown as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const hasForgetting = cols.includes("state") && cols.includes("access_count") && cols.includes("last_access_time");
    const sql = hasForgetting
      ? `INSERT INTO l1_records (record_id, content, type, priority, scene_name, team_id, user_id, agent_id, created_time, updated_time, metadata_json, state, access_count, last_access_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO l1_records (record_id, content, type, priority, scene_name, team_id, user_id, agent_id, created_time, updated_time, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const stmt = db.prepare(sql);
    for (const r of records) {
      const base = [
        r.record_id,
        r.content,
        r.type,
        r.priority,
        r.scene_name,
        r.team_id,
        r.user_id,
        r.agent_id,
        r.created_time,
        r.updated_time,
        r.metadata_json ?? "{}",
      ];
      if (hasForgetting) {
        stmt.run(...base, r.state ?? "active", r.access_count ?? 0, r.last_access_time ?? null);
      } else {
        stmt.run(...base);
      }
    }
  } finally {
    db.close();
  }
}

export function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: `m_${randomUUID().slice(0, 8)}`,
    content: "一条普通记忆记录，内容足够长以便参与冗余聚类的最小长度判断。",
    type: "episodic",
    priority: 90,
    scene_name: "scene",
    team_id: "t",
    user_id: "u",
    agent_id: "a",
    created_time: "2026-09-01T00:00:00.000Z",
    updated_time: "2026-09-01T00:00:00.000Z",
    access_count: 0,
    last_access_time: null,
    metadata_json: "{}",
    ...overrides,
  };
}

/** State per record, treating a missing state column as "everything is active". */
export function readStates(dbPath: string): Record<string, string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = (db.prepare("PRAGMA table_info(l1_records)").all() as unknown as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const sql = cols.includes("state")
      ? "SELECT record_id, state FROM l1_records"
      : "SELECT record_id, 'active' AS state FROM l1_records";
    const rows = db.prepare(sql).all() as unknown as Array<{ record_id: string; state: string }>;
    return Object.fromEntries(rows.map((r) => [r.record_id, r.state]));
  } finally {
    db.close();
  }
}
