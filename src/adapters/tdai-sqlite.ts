/**
 * Read adapter for tdai's L1 store.
 *
 * tdai keeps L1 atomic memories in sqlite (`vectors.db`, table `l1_records`).
 * This adapter reads them without loading sqlite-vec and without writing: it
 * opens the file read-only and selects the columns the engine needs. Everything
 * optional degrades gracefully, so the same code works against a stock tdai
 * database (no forgetting columns yet) and a migrated one.
 */

import { DatabaseSync } from "node:sqlite";
import type { MemoryRecord, MemoryState } from "../types.ts";

export interface LoadOptions {
  /** Filter to a single (team, agent, user) triple. tdai isolates memories this way. */
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  /** Cap for exploratory runs; 0 or absent means no limit. */
  limit?: number;
}

interface ColumnInfo {
  name: string;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Forgetfulness columns are added by `src/migrate.ts`. Detect rather than assume:
 * a missing column means "Noah has not migrated this database yet", which the
 * caller must report instead of silently degrading to a different policy.
 */
export function hasForgettingColumns(db: DatabaseSync): boolean {
  const cols = tableColumns(db, "l1_records");
  return cols.has("state") && cols.has("access_count") && cols.has("last_access_time");
}

export function loadRecords(dbPath: string, opts: LoadOptions = {}): MemoryRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = tableColumns(db, "l1_records");
    const migrated = cols.has("state") && cols.has("access_count") && cols.has("last_access_time");

    const select = [
      "record_id",
      "content",
      "type",
      "priority",
      "scene_name",
      "team_id",
      "user_id",
      "agent_id",
      "created_time",
      "updated_time",
      "metadata_json",
      migrated ? "state" : "'active' AS state",
      migrated ? "access_count" : "0 AS access_count",
      migrated ? "last_access_time" : "NULL AS last_access_time",
    ].join(", ");

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.team_id) {
      where.push("team_id = ?");
      params.push(opts.team_id);
    }
    if (opts.agent_id) {
      where.push("agent_id = ?");
      params.push(opts.agent_id);
    }
    if (opts.user_id) {
      where.push("user_id = ?");
      params.push(opts.user_id);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : "";

    const rows = db
      .prepare(`SELECT ${select} FROM l1_records ${whereSql} ORDER BY created_time ASC ${limitSql}`)
      .all(...params) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      record_id: String(row.record_id),
      content: String(row.content ?? ""),
      type: String(row.type ?? ""),
      priority: Number(row.priority ?? 50),
      scene_name: String(row.scene_name ?? ""),
      team_id: String(row.team_id ?? ""),
      user_id: String(row.user_id ?? ""),
      agent_id: String(row.agent_id ?? ""),
      created_time: String(row.created_time ?? ""),
      updated_time: String(row.updated_time ?? ""),
      last_access_time: row.last_access_time ? String(row.last_access_time) : null,
      access_count: Number(row.access_count ?? 0),
      state: String(row.state ?? "active") as MemoryState,
      metadata_json: String(row.metadata_json ?? "{}"),
    }));
  } finally {
    db.close();
  }
}

/** Corpus shape for reports. Cheap, and it is the first thing a reviewer asks. */
export interface CorpusStats {
  total: number;
  byType: Record<string, number>;
  byState: Record<string, number>;
  byMonth: Record<string, number>;
  pinnedByPriority: number;
  permanenceWorded: number;
  oldest: string;
  newest: string;
}

export function corpusStats(records: MemoryRecord[]): CorpusStats {
  const byType: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  let oldest = "";
  let newest = "";
  let pinnedByPriority = 0;

  for (const r of records) {
    byType[r.type || "(empty)"] = (byType[r.type || "(empty)"] ?? 0) + 1;
    const state = r.state ?? "active";
    byState[state] = (byState[state] ?? 0) + 1;
    const month = r.created_time.slice(0, 7) || "(unknown)";
    byMonth[month] = (byMonth[month] ?? 0) + 1;
    if (r.priority === -1) pinnedByPriority++;
    if (!oldest || (r.created_time && r.created_time < oldest)) oldest = r.created_time;
    if (!newest || r.created_time > newest) newest = r.created_time;
  }

  return {
    total: records.length,
    byType,
    byState,
    byMonth,
    pinnedByPriority,
    permanenceWorded: 0,
    oldest,
    newest,
  };
}
