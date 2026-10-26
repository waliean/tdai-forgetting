/**
 * Recall evidence.
 *
 * Decay needs something to push against. Without a record of which memories were
 * actually returned, every memory looks equally untouched and the only measurable
 * signal is age — which is exactly the flaw in tdai's current cleaner (it keys on
 * `updated_time`, and dedup merges refresh that forever).
 *
 * Two write paths, chosen for where they run:
 *
 *   appendRecall    one JSON line per search, fire-and-forget. For the in-process
 *                   patch: the core already holds a WAL connection to the database,
 *                   so a second writer on the search path buys contention for
 *                   nothing. An append is cheap, ordered by the filesystem, and
 *                   survives a crash mid-search.
 *
 *   foldAccessLog   reads those lines, aggregates per record, and updates the
 *                   counters in one transaction. Runs off the hot path (cron or the
 *                   CLI), which is also when contention is acceptable.
 *
 *   reinforce       direct bump for the stronger signal "the agent cited this".
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface RecallHit {
  record_id: string;
  /** 1-based position in the returned list. */
  rank: number;
}

export interface RecallLogOptions {
  /** Only the first N hits count as an access. Counting every candidate measures "appeared in a list", not "was useful". */
  maxRankCounted: number;
}

export const DEFAULT_RECALL_LOG: RecallLogOptions = {
  maxRankCounted: 10,
};

/**
 * Append one line per search. Never throws: a lost access record is much cheaper
 * than a failed search, and the caller cannot do anything useful with the error.
 */
export function appendRecall(
  logPath: string,
  hits: RecallHit[],
  now: Date = new Date(),
  opts: RecallLogOptions = DEFAULT_RECALL_LOG,
): boolean {
  const counted = hits.filter((h) => h.rank <= opts.maxRankCounted);
  if (counted.length === 0) return false;
  const line =
    JSON.stringify({
      at: now.toISOString(),
      hits: counted.map((h) => h.record_id),
    }) + "\n";
  try {
    appendFileSync(logPath, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface FoldResult {
  linesRead: number;
  recordsTouched: number;
  /** Rows actually updated; zero here with linesRead > 0 means the ids no longer exist. */
  rowsUpdated: number;
  archivePath?: string;
}

/**
 * Fold the log into `l1_records.access_count` / `last_access_time`.
 *
 * The log is renamed rather than truncated after a successful fold: if the process
 * dies between the rename and the commit, the un-folded data is still on disk under
 * the archive name and can be replayed by hand. Truncation would lose it silently.
 */
export function foldAccessLog(dbPath: string, logPath: string): FoldResult {
  if (!existsSync(logPath) || statSync(logPath).size === 0) {
    return { linesRead: 0, recordsTouched: 0, rowsUpdated: 0 };
  }

  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const totals = new Map<string, { count: number; lastAt: string }>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { at?: string; hits?: string[] };
      if (!parsed.at || !Array.isArray(parsed.hits)) continue;
      for (const id of parsed.hits) {
        const existing = totals.get(id);
        if (existing) {
          existing.count += 1;
          if (parsed.at > existing.lastAt) existing.lastAt = parsed.at;
        } else {
          totals.set(id, { count: 1, lastAt: parsed.at });
        }
      }
    } catch {
      // A torn final line is expected if the process died mid-append. Skip it.
    }
  }

  if (totals.size === 0) {
    return { linesRead: lines.length, recordsTouched: 0, rowsUpdated: 0 };
  }

  const db = new DatabaseSync(dbPath);
  let rowsUpdated = 0;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const stmt = db.prepare(
      `UPDATE l1_records
          SET access_count = COALESCE(access_count, 0) + ?,
              last_access_time = CASE
                WHEN last_access_time IS NULL OR last_access_time < ? THEN ?
                ELSE last_access_time
              END
        WHERE record_id = ?`,
    );
    for (const [id, total] of totals) {
      const info = stmt.run(total.count, total.lastAt, total.lastAt, id);
      rowsUpdated += Number((info as { changes?: number }).changes ?? 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone */
    }
    throw err;
  } finally {
    db.close();
  }

  const archivePath = `${logPath}.folded-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(logPath, archivePath);
  } catch {
    // The counters are already committed. Leaving the log in place means the next
    // fold double-counts, so say so loudly instead of pretending it worked.
    return { linesRead: lines.length, recordsTouched: totals.size, rowsUpdated, archivePath: undefined };
  }

  return { linesRead: lines.length, recordsTouched: totals.size, rowsUpdated, archivePath };
}

/** Direct bump for records a caller already decided are useful. */
export function reinforce(dbPath: string, recordIds: string[], now: Date = new Date()): number {
  if (recordIds.length === 0) return 0;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const stmt = db.prepare(
      `UPDATE l1_records
          SET access_count = COALESCE(access_count, 0) + 1,
              last_access_time = ?
        WHERE record_id = ?`,
    );
    let written = 0;
    for (const id of recordIds) {
      const info = stmt.run(now.toISOString(), id);
      written += Number((info as { changes?: number }).changes ?? 0);
    }
    return written;
  } finally {
    db.close();
  }
}
