/**
 * Invalidation: marking a record as superseded, without evicting it.
 *
 * The distinction this module exists to protect:
 *
 *   state      - where the record sits in the active set. Set by the planner, by
 *                eviction policy, by quota. "Nobody is using this any more."
 *   invalid_at - whether the record's claim still holds. Set by a human, later by a
 *                gated LLM. "Something newer contradicted this."
 *
 * They are independent on purpose. A record can be invalid and still active: it is
 * in the database, it is not forgotten, and it must not be recalled. Folding the
 * second into the first would lose what the record was before the contradiction, and
 * would turn "undo the invalidation" into a state transition — which is exactly the
 * operation you want to be cheap when someone marks the wrong record.
 *
 * Decay was tried first and does not do this job. It reorders; it does not exclude.
 * The supersede experiment shows the difference directly: decay lifts the newest
 * restatement to rank 1 but the stale copy is still in the window.
 *
 * Nothing here deletes. An invalidation is one UPDATE plus one audit row, and
 * clearing `invalid_at` restores recall with no other state to repair.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.ts";

/** The action written to forgetting_audit for a human invalidation. */
export const INVALIDATE_ACTION = "invalidate";

/** Why a supersede request was rejected. Each maps to a CLI exit code. */
export type SupersedeRejection = "empty-reason" | "old-not-found" | "new-not-found" | "old-already-invalid";

export interface SupersedeOptions {
  /** record_id being contradicted. */
  oldId: string;
  /** record_id that replaces it. Optional: a cancelled project has no successor. */
  newId?: string;
  /** Operator's reason. Required, non-empty: this is the only human-readable record. */
  reason: string;
  /** false computes and reports; true writes. Default is false, always. */
  apply?: boolean;
  /** Executor identity for the audit trail. */
  actor?: string;
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface SupersedePlan {
  oldId: string;
  newId: string | null;
  reason: string;
  /** Snapshot of the record as it stands, for the dry-run report. */
  record: {
    record_id: string;
    type: string;
    state: string;
    invalid_at: string | null;
    superseded_by: string | null;
    excerpt: string;
  } | null;
  /** The audit row that will be (or was) written. */
  audit: {
    action: string;
    from_state: string;
    to_state: string;
    reason: string;
    decided_at: string;
  } | null;
}

export interface SupersedeResult {
  applied: boolean;
  rejection: SupersedeRejection | null;
  plan: SupersedePlan | null;
  /** Audit rows written. 0 on a dry run or a rejection. */
  auditRows: number;
  runId: string | null;
}

/**
 * Reject a request before any I/O, so the CLI can fail fast on a bad invocation
 * without opening — let alone writing — the database.
 *
 * An empty reason is rejected rather than defaulted. The audit trail is the only
 * place a later reader can find out *why* a record was invalidated, and a generated
 * placeholder ("superseded") would look like a reason while carrying no information.
 */
export function rejectReason(opts: SupersedeOptions): SupersedeRejection | null {
  if (!opts.reason || opts.reason.trim().length === 0) return "empty-reason";
  return null;
}

function excerptOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? flat.slice(0, 60) + "…" : flat;
}

interface OldRow {
  record_id: string;
  content: string;
  type: string;
  state: string;
  invalid_at: string | null;
  superseded_by: string | null;
}

/**
 * Read the record being superseded. Opens read-only: a dry run must be incapable of
 * writing even if a later step is buggy, and this is the only read the command needs.
 */
function readOld(dbPath: string, oldId: string): OldRow | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(l1_records)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("invalid_at")) {
      throw new Error(`${dbPath} has no invalid_at column: run the migration (src/migrate.ts) first`);
    }
    const row = db
      .prepare("SELECT record_id, content, type, state, invalid_at, superseded_by FROM l1_records WHERE record_id = ?")
      .get(oldId) as OldRow | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function exists(dbPath: string, recordId: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT 1 FROM l1_records WHERE record_id = ?").get(recordId) !== undefined;
  } finally {
    db.close();
  }
}

/**
 * Plan an invalidation without writing. Returns the record snapshot and the audit row
 * that `applySupersede` would commit, so a dry run and a real run report the same
 * thing and cannot drift apart.
 */
export function planSupersede(dbPath: string, opts: SupersedeOptions): SupersedeResult {
  const rejected = rejectReason(opts);
  if (rejected) return { applied: false, rejection: rejected, plan: null, auditRows: 0, runId: null };

  const old = readOld(dbPath, opts.oldId);
  if (!old) return { applied: false, rejection: "old-not-found", plan: null, auditRows: 0, runId: null };

  if (opts.newId !== undefined && !exists(dbPath, opts.newId)) {
    return { applied: false, rejection: "new-not-found", plan: null, auditRows: 0, runId: null };
  }

  if (old.invalid_at !== null) {
    return { applied: false, rejection: "old-already-invalid", plan: null, auditRows: 0, runId: null };
  }

  const now = (opts.now ?? (() => new Date()))();
  const reason = opts.reason.trim();
  return {
    applied: false,
    rejection: null,
    auditRows: 0,
    runId: null,
    plan: {
      oldId: opts.oldId,
      newId: opts.newId ?? null,
      reason,
      record: {
        record_id: old.record_id,
        type: old.type,
        state: old.state,
        invalid_at: old.invalid_at,
        superseded_by: old.superseded_by,
        excerpt: excerptOf(old.content),
      },
      audit: {
        action: INVALIDATE_ACTION,
        from_state: old.state,
        to_state: "invalidated",
        reason,
        decided_at: now.toISOString(),
      },
    },
  };
}

/**
 * Write the invalidation: one UPDATE plus one audit row, in one transaction.
 *
 * Both or neither. An invalidation that updated the record but lost its audit row
 * would be invisible to the only mechanism for finding a mistake, which is the
 * opposite of what this feature needs.
 *
 * `state` is deliberately NOT touched. It stays whatever the record already was.
 */
export function applySupersede(dbPath: string, opts: SupersedeOptions): SupersedeResult {
  const planned = planSupersede(dbPath, opts);
  if (planned.rejection || !planned.plan) return planned;

  // Writing means the schema has to be there; the applier owns this guarantee for
  // plans, and this is the same contract for a single record.
  migrate(dbPath);

  const now = (opts.now ?? (() => new Date()))();
  const nowIso = planned.plan.audit!.decided_at;
  const runId = `supersede-${nowIso.replace(/[:.]/g, "-")}`;

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare("UPDATE l1_records SET invalid_at = ?, superseded_by = ? WHERE record_id = ? AND invalid_at IS NULL")
        .run(nowIso, planned.plan.newId, opts.oldId);
      const changed = Number((result as { changes?: number }).changes ?? 0);
      if (changed === 0) {
        // Someone invalidated it between the plan and the write. Roll back rather than
        // write an audit row claiming an action that did not happen.
        db.exec("ROLLBACK");
        return { applied: false, rejection: "old-already-invalid", plan: null, auditRows: 0, runId: null };
      }

      db.prepare(
        `INSERT INTO forgetting_audit
           (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
         VALUES (?, ?, ?, ?, ?, 'invalidated', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        runId,
        opts.oldId,
        INVALIDATE_ACTION,
        planned.plan.audit!.from_state,
        0,
        planned.plan.reason,
        nowIso,
        now.getTime(),
      );

      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      throw err;
    }

    return { applied: true, rejection: null, plan: planned.plan, auditRows: 1, runId };
  } finally {
    db.close();
  }
}

/** Every currently invalidated record, so a mis-mark can be found without the audit log. */
export interface InvalidatedRecord {
  record_id: string;
  type: string;
  state: string;
  invalid_at: string;
  superseded_by: string | null;
  excerpt: string;
}

export function listInvalidated(dbPath: string): InvalidatedRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(l1_records)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("invalid_at")) return [];
    const rows = db
      .prepare(
        `SELECT record_id, content, type, state, invalid_at, superseded_by
           FROM l1_records WHERE invalid_at IS NOT NULL ORDER BY invalid_at DESC`,
      )
      .all() as unknown as Array<OldRow>;
    return rows.map((r) => ({
      record_id: r.record_id,
      type: r.type,
      state: r.state,
      invalid_at: r.invalid_at!,
      superseded_by: r.superseded_by,
      excerpt: excerptOf(r.content),
    }));
  } finally {
    db.close();
  }
}

/** Clear an invalidation. One column, which is the whole point of the design. */
export function restoreRecord(dbPath: string, recordId: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    const result = db
      .prepare("UPDATE l1_records SET invalid_at = NULL, superseded_by = NULL WHERE record_id = ? AND invalid_at IS NOT NULL")
      .run(recordId);
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  } finally {
    db.close();
  }
}
