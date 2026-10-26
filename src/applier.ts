/**
 * Plan application.
 *
 * Takes a plan from the planner and writes it to sqlite inside one transaction:
 * state transitions on `l1_records`, plus audit rows and a run summary. Nothing
 * is deleted; archival is a state flag, so an operator can flip a run back with a
 * single UPDATE if the policy turns out wrong.
 *
 * Three rules enforced in code rather than documentation:
 *   1. A hard-pinned record is never written, even if a plan claims otherwise. The
 *      planner already exempts them; this is the second line of defence.
 *   2. An extended pin is writable. It means "decay slowly", not "never move", so
 *      blocking it here would silently break the policy the planner implements.
 *   3. `dryRun` computes everything, writes nothing, and returns the same counts.
 *      Every adoption should start with a dry run against a copy.
 */

import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ForgettingPlanReport } from "./planner.ts";
import { hasForgettingSchema, migrate } from "./migrate.ts";

export interface ApplyOptions {
  dryRun?: boolean;
  /** Free-text note stored on the run row, e.g. "first adoption on snapshot". */
  notes?: string;
  /** Executor identity for the audit trail. */
  actor?: string;
}

export interface ApplyResult {
  runId: string;
  dryRun: boolean;
  archived: number;
  retired: number;
  skippedPinned: number;
  auditRows: number;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function applyPlan(dbPath: string, plan: ForgettingPlanReport, opts: ApplyOptions = {}): ApplyResult {
  const dryRun = opts.dryRun ?? false;
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${shortHash(plan.generatedAt + plan.total)}`;

  const targets = plan.decisions.filter((d) => d.decision === "archive" || d.decision === "retire");
  const isHardPinned = (d: (typeof targets)[number]): boolean => d.record.pin_kind === "hard";
  const skippedPinned = targets.filter(isHardPinned).length;
  const writable = targets.filter((d) => !isHardPinned(d));
  const archived = writable.filter((d) => d.decision === "archive").length;
  const retired = writable.filter((d) => d.decision === "retire").length;

  if (dryRun) {
    return { runId, dryRun, archived, retired, skippedPinned, auditRows: writable.length };
  }

  // The applier is the only writer, so it owns the schema guarantee: running it on
  // a stock tdai database must work without a separate migration step.
  migrate(dbPath);

  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO forgetting_runs (run_id, started_at, finished_at, mode, actor, policy_json, total, pinned, archived, retired, kept, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
      ).run(
        runId,
        nowIso,
        nowIso,
        "apply",
        opts.actor ?? "unknown",
        JSON.stringify(plan.config),
        plan.total,
        plan.pinned,
        archived,
        retired,
        plan.kept,
        opts.notes ?? null,
      );

      const update = db.prepare(
        `UPDATE l1_records
            SET state = ?, forget_reason = ?, forgotten_time = ?
          WHERE record_id = ? AND state = 'active'`,
      );
      const audit = db.prepare(
        `INSERT INTO forgetting_audit
           (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      );

      for (const d of writable) {
        const toState = d.decision === "archive" ? "archived" : "retired";
        const result = update.run(toState, d.reason, nowIso, d.record.record_id);
        // rowcount 0 means the row was already non-active: still audit it, so the
        // log stays a complete record of what the plan decided, not just what
        // happened to be writable at the time.
        const changed = Number((result as { changes?: number }).changes ?? 0);
        audit.run(
          randomUUID(),
          runId,
          d.record.record_id,
          d.decision,
          toState,
          d.score,
          changed > 0 ? d.reason : `${d.reason} (row not active; state unchanged)`,
          nowIso,
          now.getTime(),
        );
      }

      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* rollback failure means the outer transaction is already gone */
      }
      throw err;
    }

    return { runId, dryRun, archived, retired, skippedPinned, auditRows: writable.length };
  } finally {
    db.close();
  }
}

/** Counters for the operator, computed from the audit trail rather than trusted from the plan. */
export interface AuditSummary {
  states: Record<string, number>;
  runs: Array<{ run_id: string; started_at: string; archived: number; retired: number; status: string }>;
}

export function auditSummary(dbPath: string): AuditSummary {
  const migrated = hasForgettingSchema(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const states: Record<string, number> = {};
    const stateSql = migrated
      ? "SELECT state, COUNT(*) AS c FROM l1_records GROUP BY state"
      : "SELECT 'active' AS state, COUNT(*) AS c FROM l1_records";
    const stateRows = db.prepare(stateSql).all() as unknown as Array<{ state: string; c: number }>;
    for (const row of stateRows) states[row.state] = row.c;

    let runs: AuditSummary["runs"] = [];
    if (migrated) {
      try {
        runs = db
          .prepare(
            "SELECT run_id, started_at, archived, retired, status FROM forgetting_runs ORDER BY started_at DESC LIMIT 20",
          )
          .all() as unknown as AuditSummary["runs"];
      } catch {
        // The view exists but a pre-0.1 run table does not. Empty list is honest.
        runs = [];
      }
    }
    return { states, runs };
  } finally {
    db.close();
  }
}
