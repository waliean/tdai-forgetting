/**
 * Tests for scripts/rollback-forgetting.mjs.
 *
 * The script is spawned as a child process instead of imported: its contract is the
 * exit code and the printed counters, and a caller that cannot see stderr only has
 * those two. A test that calls an exported function would leave "does exit 5 actually
 * happen" unverified.
 *
 * Fixtures are throwaway databases from test/fixtures.ts plus migrate(), because the
 * fixture only creates l1_records and this script needs the forgetting schema. Scenarios
 * are built by writing the same shape applier.ts writes (see seedArchivedRun): a real
 * applyPlan run would work too, but its record selection depends on the scorer, and the
 * numbers asserted below are supposed to be hard-coded constants, not properties of
 * today's scoring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "../src/migrate.ts";
import { createTempDb, insertRecords, makeRecord, readStates } from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/rollback-forgetting.mjs", import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: Record<string, string | undefined> = {}): RunResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  delete childEnv.TDAI_DB;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: childEnv });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function num(stdout: string, key: string): number {
  // Several counters share a line ("targets_fingerprint_matched 52 skipped_changed_since 0"),
  // so match the key followed by a number anywhere rather than anchoring to the line end.
  const m = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " (\\d+)").exec(stdout);
  assert.ok(m, `output must contain "${key} <n>", got:\n${stdout}`);
  return Number(m[1]);
}

/** Insert `n` active records and run the migration that adds the forgetting schema. */
function seedDb(n: number) {
  const db = createTempDb();
  const records = Array.from({ length: n }, (_, i) =>
    makeRecord({
      record_id: `m_${String(i).padStart(4, "0")}`,
      updated_time: "2026-01-01T00:00:00.000Z",
      priority: 90,
    }),
  );
  insertRecords(db.path, records);
  migrate(db.path);
  return { ...db, ids: records.map((r) => r.record_id) };
}

/**
 * Write one apply run that archived `ids`, in exactly the shape applier.ts writes:
 * the row carries forget_reason = <audit.reason> and forgotten_time = <audit.decided_at>,
 * which is the fingerprint the rollback matches on.
 */
function seedArchivedRun(dbPath: string, ids: string[], runId: string, decidedAt: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO forgetting_runs (run_id, started_at, finished_at, mode, actor, policy_json, total, pinned, archived, retired, kept, status, notes)
       VALUES (?, ?, ?, 'apply', 'test', '{}', 0, 0, ?, 0, 0, 'completed', NULL)`,
    ).run(runId, decidedAt, decidedAt, ids.length);
    const upd = db.prepare(
      "UPDATE l1_records SET state='archived', forget_reason=?, forgotten_time=? WHERE record_id = ? AND state='active'",
    );
    const aud = db.prepare(
      `INSERT INTO forgetting_audit (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
       VALUES (?, ?, ?, 'archive', 'active', 'archived', ?, ?, ?, ?)`,
    );
    ids.forEach((id, i) => {
      const reason = `quota 600: bottom-ranked (${i + 1}/${ids.length})`;
      const changed = Number((upd.run(reason, decidedAt, id) as { changes?: number }).changes ?? 0);
      assert.equal(changed, 1, `seed expected to archive ${id}`);
      aud.run(randomUUID(), runId, id, 0.55, reason, decidedAt, Date.parse(decidedAt));
    });
  } finally {
    db.close();
  }
}

function counts(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const auditRows = (db.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as { c: number }).c;
    const rollbackRows = (
      db.prepare("SELECT COUNT(*) AS c FROM forgetting_audit WHERE action='rollback'").get() as { c: number }
    ).c;
    const runs = (db.prepare("SELECT COUNT(*) AS c FROM forgetting_runs").get() as { c: number }).c;
    return { auditRows, rollbackRows, runs };
  } finally {
    db.close();
  }
}

/** WAL is what makes the checkpoint invariant mean anything; the fixture defaults to a rollback journal. */
function enableWal(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
}

const T1 = "2026-10-26T15:20:39.423Z";

test("rollback restores every fingerprinted row and writes exactly one audit row per restore", () => {
  const db = seedDb(52);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const r = runScript(["run-apply-1", db.path]);
    assert.equal(r.status, 0, r.stderr);
    // Hard-coded: 52 archived rows, 52 restored, 52 rollback audit rows. Reading these
    // back out of the implementation would let a wrong implementation agree with itself.
    assert.equal(num(r.stdout, "targets_fingerprint_matched"), 52);
    assert.equal(num(r.stdout, "skipped_changed_since"), 0);
    assert.equal(num(r.stdout, "records_restored"), 52);
    assert.equal(num(r.stdout, "rollback_audit_rows"), 52);
    assert.match(r.stdout, /INDEX_CONSISTENT true INTEGRITY_OK true/);
    assert.equal(num(r.stdout, "active_indexed"), 52);
    assert.equal(num(r.stdout, "active_fullscan"), 52);
    assert.equal(num(r.stdout, "recallable_view"), 52);

    const states = readStates(db.path);
    assert.ok(Object.values(states).every((s) => s === "active"));
    assert.deepEqual(counts(db.path), { auditRows: 104, rollbackRows: 52, runs: 2 });
  } finally {
    db.cleanup();
  }
});

test("a no-op run rolls back to 0 restored and 0 rollback audit rows, not 52", () => {
  const db = seedDb(52);
  try {
    // The real thing: run 1 archives the rows; run 2 replays the same plan, so every
    // UPDATE changes 0 rows and applier.ts still writes 52 audit rows, marking each
    // reason with " (row not active; state unchanged)".
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const T2 = "2026-10-26T16:38:23.597Z";
    const db2 = new DatabaseSync(db.path);
    try {
      db2
        .prepare(
          `INSERT INTO forgetting_runs (run_id, started_at, finished_at, mode, actor, policy_json, total, pinned, archived, retired, kept, status, notes)
           VALUES ('run-apply-2', ?, ?, 'apply', 'test', '{}', 0, 0, 52, 0, 0, 'completed', NULL)`,
        )
        .run(T2, T2);
      const aud = db2.prepare(
        `INSERT INTO forgetting_audit (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
         SELECT lower(hex(randomblob(16))), 'run-apply-2', record_id, 'archive', 'active', 'archived', score,
                reason || ' (row not active; state unchanged)', ?, ?
           FROM forgetting_audit WHERE run_id='run-apply-1'`,
      );
      aud.run(T2, Date.parse(T2));
    } finally {
      db2.close();
    }

    const before = counts(db.path);
    assert.equal(before.auditRows, 104);

    const r = runScript(["run-apply-2", db.path]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(num(r.stdout, "targets_fingerprint_matched"), 0);
    assert.equal(num(r.stdout, "skipped_changed_since"), 52);
    assert.equal(num(r.stdout, "records_restored"), 0);
    // This is the FE-001 P1-2 defect: sourcing the rollback audit INSERT from the run's
    // audit rows instead of the fingerprint set writes 52 rows here, all pointing at
    // records that are still archived. Asserted as 0.
    assert.equal(num(r.stdout, "rollback_audit_rows"), 0);

    const after = counts(db.path);
    assert.equal(after.auditRows, before.auditRows, "no rollback audit rows may be added");
    assert.equal(after.rollbackRows, 0);
    assert.ok(Object.values(readStates(db.path)).every((s) => s === "archived"));
  } finally {
    db.cleanup();
  }
});

test("a partly restored scenario rolls back 47 of 52 and writes 47 rollback rows", () => {
  const db = seedDb(52);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    // Someone restored 5 rows by hand, keeping the two fields the applier wrote. The
    // fingerprint then fails for them (state is active), so they must be skipped and
    // must not have their forget_reason cleared.
    const manual = db.ids.slice(0, 5);
    const db2 = new DatabaseSync(db.path);
    try {
      const upd = db2.prepare("UPDATE l1_records SET state='active' WHERE record_id = ?");
      for (const id of manual) upd.run(id);
      const kept = db2.prepare("SELECT COUNT(*) AS c FROM l1_records WHERE state='active' AND forget_reason IS NOT NULL").get() as { c: number };
      assert.equal(kept.c, 5);
    } finally {
      db2.close();
    }

    const r = runScript(["run-apply-1", db.path]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(num(r.stdout, "targets_fingerprint_matched"), 47);
    assert.equal(num(r.stdout, "skipped_changed_since"), 5);
    assert.equal(num(r.stdout, "records_restored"), 47);
    assert.equal(num(r.stdout, "rollback_audit_rows"), 47);

    const db3 = new DatabaseSync(db.path, { readOnly: true });
    try {
      const stale = db3
        .prepare(
          `SELECT COUNT(*) AS c FROM forgetting_audit a JOIN l1_records r ON r.record_id = a.record_id
            WHERE a.action='rollback' AND r.state <> 'active'`,
        )
        .get() as { c: number };
      assert.equal(stale.c, 0, "no rollback audit row may point at a record that is still archived");
      const traces = db3
        .prepare("SELECT COUNT(*) AS c FROM l1_records WHERE state='active' AND forget_reason IS NOT NULL")
        .get() as { c: number };
      assert.equal(traces.c, 5, "the operator's 5 forget_reason values must survive the rollback");
    } finally {
      db3.close();
    }
  } finally {
    db.cleanup();
  }
});

test("a row whose fingerprint no longer matches is skipped, not restored", () => {
  const db = seedDb(3);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const tampered = db.ids[1];
    const db2 = new DatabaseSync(db.path);
    try {
      db2.prepare("UPDATE l1_records SET forget_reason='kept by an operator' WHERE record_id = ?").run(tampered);
    } finally {
      db2.close();
    }

    const r = runScript(["run-apply-1", db.path]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(num(r.stdout, "targets_fingerprint_matched"), 2);
    assert.equal(num(r.stdout, "skipped_changed_since"), 1);
    assert.equal(num(r.stdout, "records_restored"), 2);
    assert.equal(num(r.stdout, "rollback_audit_rows"), 2);
    assert.equal(readStates(db.path)[tampered], "archived", "the tampered row must stay archived");
    assert.equal(readStates(db.path)[db.ids[0]], "active");
  } finally {
    db.cleanup();
  }
});

test("--dry-run writes nothing: same audit row count and same state distribution", () => {
  const db = seedDb(52);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const before = counts(db.path);
    const beforeStates = readStates(db.path);

    const r = runScript(["run-apply-1", db.path, "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(num(r.stdout, "targets_fingerprint_matched"), 52);
    assert.equal(num(r.stdout, "skipped_changed_since"), 0);
    assert.match(r.stdout, /would_restore_ids \[/);
    assert.match(r.stdout, /dry_run_no_changes true/);
    assert.match(r.stdout, /mode dry-run/, "must announce that no write transaction was opened");

    assert.deepEqual(counts(db.path), before);
    assert.deepEqual(readStates(db.path), beforeStates);
  } finally {
    db.cleanup();
  }
});

test("a run whose mode is not apply is refused with exit 3 and no writes", () => {
  const db = seedDb(2);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const db2 = new DatabaseSync(db.path);
    try {
      db2
        .prepare(
          `INSERT INTO forgetting_runs (run_id, started_at, finished_at, mode, actor, policy_json, total, pinned, archived, retired, kept, status, notes)
           VALUES ('rb-run-apply-1', ?, ?, 'rollback', 'test', '{}', 2, 0, 0, 0, 0, 'completed', NULL)`,
        )
        .run(T1, T1);
    } finally {
      db2.close();
    }
    const before = counts(db.path);
    const beforeStates = readStates(db.path);

    const r = runScript(["rb-run-apply-1", db.path]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /only apply runs are rolled back/);
    assert.deepEqual(counts(db.path), before);
    assert.deepEqual(readStates(db.path), beforeStates);
  } finally {
    db.cleanup();
  }
});

test("an unknown run id exits 2 and touches nothing", () => {
  const db = seedDb(2);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const before = counts(db.path);

    const r = runScript(["run-does-not-exist", db.path]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no such run/);
    assert.deepEqual(counts(db.path), before);
  } finally {
    db.cleanup();
  }
});

test("no db argument and no $TDAI_DB prints usage and exits 1", () => {
  const r = runScript(["run-apply-1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: node scripts\/rollback-forgetting\.mjs/);
});

test("the db can come from $TDAI_DB instead of the command line", () => {
  const db = seedDb(4);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const r = runScript(["run-apply-1"], { TDAI_DB: db.path });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(num(r.stdout, "records_restored"), 4);
    assert.equal(num(r.stdout, "rollback_audit_rows"), 4);
  } finally {
    db.cleanup();
  }
});

test("a restored-vs-matched mismatch exits 5 and rolls the transaction back", () => {
  const db = seedDb(3);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    // Pre-existing rollback audit row for one target: the NOT EXISTS de-duplication drops
    // it, so 3 rows are restored but only 2 rollback rows can be written. That is the
    // "counts disagree" condition the exit code exists for.
    const db2 = new DatabaseSync(db.path);
    try {
      db2
        .prepare(
          `INSERT INTO forgetting_audit (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
           VALUES (?, 'rb-run-apply-1', ?, 'rollback', 'archived', 'active', 0.5, 'pre-existing', ?, ?)`,
        )
        .run(randomUUID(), db.ids[2], T1, Date.parse(T1));
    } finally {
      db2.close();
    }
    const before = counts(db.path);
    const beforeStates = readStates(db.path);

    const r = runScript(["run-apply-1", db.path]);
    assert.equal(r.status, 5);
    assert.match(r.stderr, /rollback audit rows for 3 restored records|restored 3 but matched 3/);
    // Rolled back: nothing was restored and the pre-existing row is the only rollback row.
    assert.deepEqual(readStates(db.path), beforeStates);
    assert.deepEqual(counts(db.path), before);
  } finally {
    db.cleanup();
  }
});

test("a checkpoint blocked by another connection exits 4, not 0", () => {
  // FE-005 P1, the reviewer's own fixture: the database is in WAL mode and a second
  // connection holds a read transaction across the run -- the container, or any other
  // process still sitting on the file. wal_checkpoint(TRUNCATE) then returns
  // busy:1 and leaves committed frames in -wal. Before the fix that was printed and
  // ignored, so the script announced success while a copy that takes only vectors.db
  // was short of data. Exit 4 = invariant failure, and it must not be mistaken for a
  // clean run.
  const db = seedDb(3);
  let blocker: DatabaseSync | undefined;
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    enableWal(db.path);

    blocker = new DatabaseSync(db.path, { readOnly: true });
    blocker.exec("BEGIN");
    blocker.prepare("SELECT COUNT(*) AS c FROM l1_records").get();

    const r = runScript(["run-apply-1", db.path]);
    blocker.exec("COMMIT");
    blocker.close();
    blocker = undefined;

    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stdout, /CHECKPOINT_OK false/);
    assert.match(r.stdout, /"busy":1/);
    assert.match(r.stderr, /checkpointOk=false/);
    // The rows are restored and committed (WAL lets the writer through); what failed is
    // the judgement that the main file now holds everything. Both facts are asserted so
    // the exit code cannot drift into "nothing happened" without a test failing.
    assert.equal(num(r.stdout, "records_restored"), 3);
    assert.equal(num(r.stdout, "rollback_audit_rows"), 3);
    assert.ok(Object.values(readStates(db.path)).every((s) => s === "active"));
    // The write is really on disk: reopening and dropping the blocker's view is not
    // needed, the readStates() above already opened a fresh connection.
  } finally {
    if (blocker) {
      try { blocker.exec("COMMIT"); } catch { /* already closed */ }
      blocker.close();
    }
    db.cleanup();
  }
});

test("an invariant tail that cannot read the view exits 4 with the writes already committed", () => {
  // FE-005 P2: tables complete, retrieval view missing. The run COMMITs its restores and
  // rollback audit rows, then the tail throws on "no such table: l1_recallable". That
  // used to reach the top level, so Node exited 1 -- which the guide defines as "usage
  // error, nothing done", the exact opposite of what the database shows. Semantic 4,
  // and the message has to say out loud that the writes landed.
  const db = seedDb(3);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    const db2 = new DatabaseSync(db.path);
    try {
      db2.exec("DROP VIEW l1_recallable");
    } finally {
      db2.close();
    }

    const r = runScript(["run-apply-1", db.path]);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stderr, /invariant checks could not finish after COMMIT/);
    assert.match(r.stderr, /3 records restored and 3 rollback audit rows are already committed/);
    assert.match(r.stderr, /no such table: l1_recallable/);
    assert.equal(num(r.stdout, "records_restored"), 3);
    assert.equal(num(r.stdout, "rollback_audit_rows"), 3);

    // And the writes really are on disk: state active, 3 rollback audit rows, rollback run.
    assert.ok(Object.values(readStates(db.path)).every((s) => s === "active"));
    assert.deepEqual(counts(db.path), { auditRows: 6, rollbackRows: 3, runs: 2 });
  } finally {
    db.cleanup();
  }
});

test("a db path that does not exist exits 1 and is not created", () => {
  // FE-005 P3: DatabaseSync creates by default, so a typo used to leave a 0-byte
  // vectors.db next to the real one before failing. An ops script must not pick a new
  // database on the production machine.
  const db = seedDb(2);
  try {
    const typo = join(db.dir, "typo.db");
    assert.equal(existsSync(typo), false);

    const r = runScript(["run-apply-1", typo]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no such database/);
    assert.equal(existsSync(typo), false, "the script must not create the database it was pointed at");
  } finally {
    db.cleanup();
  }
});

test("a broken invariant exits 4", () => {
  const db = seedDb(3);
  try {
    seedArchivedRun(db.path, db.ids, "run-apply-1", T1);
    // Point the retrieval view at nothing: after the restore the indexed count is 3 while
    // the view returns 0, which is the disagreement the invariant tail exists to catch.
    const db2 = new DatabaseSync(db.path);
    try {
      db2.exec("DROP VIEW l1_recallable");
      db2.exec("CREATE VIEW l1_recallable AS SELECT * FROM l1_records WHERE 0");
    } finally {
      db2.close();
    }

    const r = runScript(["run-apply-1", db.path]);
    assert.equal(r.status, 4);
    assert.match(r.stdout, /INDEX_CONSISTENT false/);
    assert.match(r.stdout, /active_indexed 3 active_fullscan 3 recallable_view 0/);
  } finally {
    db.cleanup();
  }
});
