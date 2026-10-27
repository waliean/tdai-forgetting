/**
 * Roll one forgetting run back, exactly and only for the rows that run changed.
 *
 * Usage: node scripts/rollback-forgetting.mjs <run_id> <dbPath> [--dry-run]
 *
 * dbPath falls back to $TDAI_DB and has no built-in default on purpose: an ops
 * script that guesses a relative path writes into whatever database happens to sit
 * at that path on the machine it is run on. Earlier drafts defaulted to the drill
 * copy, which is exactly that failure mode.
 *
 * --dry-run prints the fingerprint match count, the skip count and the record ids it
 * would restore, on a read-only connection, then exits 0. It exists for the one
 * moment when restoring zero rows is the correct answer (see below): find out why
 * before writing.
 *
 * Exit codes: 0 ok, 1 usage, 2 no such run, 3 run is not mode='apply',
 * 4 invariant failure, 5 count check failed (restored != fingerprint matched, or
 * rollback audit rows != records restored). Exit codes rather than throws because a
 * caller cannot see stderr, and process.exitCode rather than process.exit() because
 * an immediate exit can truncate the very output the code is meant to accompany.
 *
 * "Invariant failure" (4) covers three judgements, all three decided rather than
 * printed: the checkpoint finished (busy 0), the indexed count / full-scan count /
 * view agree, and integrity_check says ok. It also covers a tail that could not be
 * read at all (a missing view or table): that throw happens after COMMIT, so 1
 * ("usage, nothing done") would tell the caller the opposite of the truth.
 *
 * Why not the obvious SQL (record_id IN (SELECT ... WHERE run_id = ? AND to_state
 * <> 'active') AND state <> 'active')? Because applier.ts audits every plan target,
 * including rows it could not change (it appends " (row not active; state unchanged)"
 * to the reason). Replaying a plan therefore leaves audit rows that claim an archive
 * that never happened, and the obvious SQL trusts them. Measured on the 2026-10-26
 * snapshot: a no-op replay of the same plan, rolled back, revived all 52 records.
 * Same again after a later run re-archived them.
 *
 * The fix is a fingerprint. When the applier changes a row it writes
 * forget_reason = <audit.reason> and forgotten_time = <audit.decided_at> in the same
 * transaction, so (state, forget_reason, forgotten_time) == (to_state, reason,
 * decided_at) means "nobody has touched this row since this run archived it".
 * Anything else -- a no-op audit row, a record a later run moved, a record an
 * operator fixed by hand -- fails the match and is left alone. Skipping is the
 * conservative direction: a missed restore can be redone, a wrong one erases the
 * fingerprint and with it the only evidence of which run archived the row.
 *
 * The whole thing runs in one transaction on one connection. The selection lives in
 * a TEMP table, so nothing is left behind in the database file for the old reader to
 * trip over.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_RUN = 2;
const EXIT_NOT_APPLY = 3;
const EXIT_INVARIANT = 4;
const EXIT_COUNT_MISMATCH = 5;

/**
 * @returns {number} process exit code; the caller assigns it to process.exitCode.
 */
function main(argv) {
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");
  const positional = argv.filter((a) => !a.startsWith("-"));

  const runId = positional[0];
  const dbPath = positional[1] ?? process.env.TDAI_DB;
  if (!runId || !dbPath) {
    console.error("usage: node scripts/rollback-forgetting.mjs <run_id> <dbPath> [--dry-run]");
    console.error("       dbPath may come from $TDAI_DB instead of the command line");
    return EXIT_USAGE;
  }

  // A missing path is a usage error, not a licence to create an empty database: the
  // write mode of DatabaseSync creates by default, so a typo would leave a 0-byte
  // vectors.db next to the real one and then fail. Checked before opening, so the
  // file is never created. --dry-run opens read-only and cannot create one either.
  if (!existsSync(dbPath)) {
    console.error("no such database: " + dbPath);
    console.error("       (not created; check the path or $TDAI_DB)");
    return EXIT_USAGE;
  }

  // Dry run opens the file read-only, so "writes nothing" is enforced by sqlite rather
  // than by us remembering not to write. TEMP tables are allowed on a read-only
  // connection, which is what makes the fingerprint selection reusable here.
  const db = new DatabaseSync(dbPath, dryRun ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 10000");
  let open = true;
  const close = () => {
    if (open) { db.close(); open = false; }
  };

  try {
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const all = (sql, ...p) => db.prepare(sql).all(...p);

    const run = one("SELECT run_id, mode, status, archived, retired, total FROM forgetting_runs WHERE run_id = ?", runId);
    if (!run) {
      console.error("no such run: " + runId);
      return EXIT_NO_RUN;
    }
    if (run.mode !== "apply") {
      console.error("run " + runId + " has mode=" + run.mode + "; only apply runs are rolled back");
      return EXIT_NOT_APPLY;
    }
    console.log("run", JSON.stringify(run));
    console.log("archived_now", one("SELECT COUNT(*) AS c FROM l1_records WHERE state='archived'").c, "active_now", one("SELECT COUNT(*) AS c FROM l1_records WHERE state='active'").c);
    console.log("mode", dryRun ? "dry-run (no write transaction opened)" : "apply");

    if (!dryRun) db.exec("BEGIN IMMEDIATE");
    /** Set once COMMIT succeeds: from then on the writes are on disk and no exit code may claim otherwise. */
    let committed = null;
    try {
      // Only rows this run archived AND nobody has touched since.
      db.prepare(
        `CREATE TEMP TABLE a5_rb AS
           SELECT a.record_id AS record_id, a.run_id AS source_run, a.to_state AS from_state,
                  a.score AS score, a.reason AS reason, a.decided_at AS decided_at
             FROM forgetting_audit a
             JOIN l1_records r ON r.record_id = a.record_id
            WHERE a.run_id = ?
              AND a.action <> 'rollback'
              AND a.to_state <> 'active'
              AND r.state = a.to_state
              AND r.forget_reason = a.reason
              AND r.forgotten_time = a.decided_at`,
      ).run(runId);
      const targets = one("SELECT COUNT(*) AS c FROM a5_rb").c;
      const skipped = one(
        `SELECT COUNT(*) AS c FROM forgetting_audit a
          WHERE a.run_id = ? AND a.action <> 'rollback' AND a.to_state <> 'active'
            AND a.record_id NOT IN (SELECT record_id FROM a5_rb)`, runId).c;
      console.log("targets_fingerprint_matched", targets, "skipped_changed_since", skipped);

      if (dryRun) {
        console.log("would_restore_ids", JSON.stringify(all("SELECT record_id FROM a5_rb ORDER BY record_id").map((r) => r.record_id)));
        console.log("dry_run_no_changes true");
        return EXIT_OK;
      }

      const upd = db.prepare(
        "UPDATE l1_records SET state='active', forget_reason=NULL, forgotten_time=NULL WHERE record_id IN (SELECT record_id FROM a5_rb) AND state <> 'active'",
      ).run();
      console.log("records_restored", upd.changes);
      if (Number(upd.changes) !== targets) {
        // The fingerprint set and the UPDATE must agree: a row that matched but did not
        // change means the selection and the write disagree about what "archived" is.
        console.error("restored " + upd.changes + " but matched " + targets);
        db.exec("ROLLBACK");
        return EXIT_COUNT_MISMATCH;
      }

      const rbRunId = "rb-" + runId;
      db.prepare(
        `INSERT INTO forgetting_runs (run_id, started_at, finished_at, mode, actor, policy_json, total, pinned, archived, retired, kept, status, notes)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'rollback', 'scripts/rollback-forgetting.mjs', ?, ?, 0, 0, 0, 0, 'completed',
                 'rollback: restore recall for one apply run') ON CONFLICT(run_id) DO NOTHING`,
      ).run(rbRunId, JSON.stringify({ rollback_of: runId, restored: targets }), targets);
      const aud = db.prepare(
        `INSERT INTO forgetting_audit (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
         SELECT lower(hex(randomblob(16))), ?, record_id, 'rollback', from_state, 'active', score,
                'rollback of ' || source_run || ': ' || reason,
                strftime('%Y-%m-%dT%H:%M:%fZ','now'), CAST(strftime('%s','now') AS INTEGER) * 1000
           FROM a5_rb rb
          WHERE NOT EXISTS (SELECT 1 FROM forgetting_audit c WHERE c.run_id = ? AND c.record_id = rb.record_id AND c.action = 'rollback')`,
      ).run(rbRunId, rbRunId);
      console.log("rollback_audit_rows", aud.changes);
      // One rollback audit row per restored row, never more. Sourcing this INSERT from the
      // run's audit rows instead of the fingerprint set writes 52 in both the no-op and the
      // partly-restored case, i.e. rows recording a state change that did not happen.
      // Asserted here because "looks plausible" is how that shipped.
      if (Number(aud.changes) !== Number(upd.changes)) {
        console.error("wrote " + aud.changes + " rollback audit rows for " + upd.changes + " restored records");
        db.exec("ROLLBACK");
        return EXIT_COUNT_MISMATCH;
      }

      db.exec("COMMIT");
      console.log("rollback_run_id", rbRunId);
      committed = { restored: Number(upd.changes), auditRows: Number(aud.changes) };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
      throw err;
    } finally {
      try { db.exec("DROP TABLE IF EXISTS temp.a5_rb"); } catch { /* connection may be closing */ }
    }

    // Invariants: three, all judged. quick_check alone is not enough -- the 2026-10-26
    // container smoke saw quick_check ok while integrity_check reported "row 696 missing
    // from index idx_l1_state" -- and a checkpoint that only gets printed is not an
    // invariant at all. TRUNCATE returns {busy, log, checkpointed}: busy != 0 means a
    // reader still pins frames (the container, or any other process on the file), so
    // committed transactions stay in -wal and a copy that takes only the main file is
    // silently short. Exactly the failure the snapshot section warns about, which is
    // why "the checkpoint succeeded" has to decide the exit code, not decorate it.
    //
    // Wrapped because COMMIT has already happened: a missing view or table here means
    // "the writes landed, the checks could not run", which is 4, never 1 ("usage, did
    // nothing"). The message says so in as many words, because that is the state most
    // easily misread by whoever reads the exit code and not the database.
    try {
      console.log("states_indexed", JSON.stringify(all("SELECT state, COUNT(*) AS c FROM l1_records GROUP BY state ORDER BY state")));
      console.log("states_fullscan", JSON.stringify(all("SELECT state, COUNT(*) AS c FROM l1_records NOT INDEXED GROUP BY state ORDER BY state")));
      const idx = one("SELECT COUNT(*) AS c FROM l1_records WHERE state='active'").c;
      const full = one("SELECT COUNT(*) AS c FROM l1_records NOT INDEXED WHERE state='active'").c;
      const view = one("SELECT COUNT(*) AS c FROM l1_recallable").c;
      console.log("active_indexed", idx, "active_fullscan", full, "recallable_view", view);
      // The connection-wide busy_timeout (10 s above) exists so the write transaction can
      // wait out a conflicting writer. For the checkpoint it would turn "another process
      // still holds the file" into a ten-second pause before the same verdict, so it is
      // shortened here: a second of grace for a transient reader, then report the truth.
      db.exec("PRAGMA busy_timeout = 1000");
      const checkpoint = one("PRAGMA wal_checkpoint(TRUNCATE)");
      console.log("checkpoint", JSON.stringify(checkpoint));
      // log / checkpointed are -1 on a non-WAL database (nothing to truncate, nothing
      // pinned), so only busy is compared there; on WAL, a busy checkpoint can also
      // report checkpointed < log, which is the same failure seen from the other side.
      const checkpointLog = Number(checkpoint.log);
      const checkpointed = Number(checkpoint.checkpointed);
      const checkpointOk =
        Number(checkpoint.busy) === 0 && (checkpointLog < 0 || checkpointed >= checkpointLog);
      const integrity = String(one("PRAGMA integrity_check").integrity_check);
      console.log("integrity", integrity);
      const consistent = idx === full && view === full;
      console.log("INDEX_CONSISTENT", consistent, "INTEGRITY_OK", integrity === "ok", "CHECKPOINT_OK", checkpointOk);
      const ok = consistent && integrity === "ok" && checkpointOk;
      if (!ok) {
        console.error(
          "invariants failed after COMMIT: " + (committed ? committed.restored + " records restored and " + committed.auditRows + " rollback audit rows are already committed" : "the tail could not be judged") +
            "; checkpointOk=" + checkpointOk + " indexConsistent=" + consistent + " integrity=" + integrity,
        );
      }
      return ok ? EXIT_OK : EXIT_INVARIANT;
    } catch (err) {
      console.error(
        "invariant checks could not finish after COMMIT: " + (committed ? committed.restored + " records restored and " + committed.auditRows + " rollback audit rows are already committed" : "no writes recorded") +
          "; the checkpoint and integrity check did not run. Cause: " + err.message,
      );
      return EXIT_INVARIANT;
    }
  } finally {
    close();
  }
}

process.exitCode = main(process.argv.slice(2));
