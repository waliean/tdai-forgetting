import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "../src/migrate.ts";
import { applySupersede, listInvalidated, planSupersede, restoreRecord } from "../src/invalidation.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

/**
 * The supersede command, through both entry points.
 *
 * Two things are being defended here, and neither is the happy path:
 *
 *   1. The default must not write. A command that invalidates records is exactly the
 *      kind of command someone runs to "see what would happen", so "see" has to be
 *      the thing that happens by default and the only way to write must be explicit.
 *   2. A rejection must leave the database bit-for-bit unchanged, including the audit
 *      table. An audit row for an action that did not happen is worse than no row:
 *      it is a false record in the one place a mistake is supposed to be findable.
 */

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** A migrated database with two records: the one being contradicted, and its successor. */
function seededDb(): ReturnType<typeof createTempDb> {
  const db = createTempDb();
  migrate(db.path);
  insertRecords(db.path, [
    makeRecord({ record_id: "old", content: "项目 A 正在推进，下周交付第一版。" }),
    makeRecord({ record_id: "new", content: "项目 A 已取消，不再交付任何版本。" }),
  ]);
  return db;
}

function counts(dbPath: string): { invalid: number; audit: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      invalid: (db.prepare("SELECT COUNT(*) AS c FROM l1_records WHERE invalid_at IS NOT NULL").get() as { c: number }).c,
      audit: (db.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

function row(dbPath: string, id: string): { state: string; invalid_at: string | null; superseded_by: string | null } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT state, invalid_at, superseded_by FROM l1_records WHERE record_id = ?").get(id) as {
      state: string;
      invalid_at: string | null;
      superseded_by: string | null;
    };
  } finally {
    db.close();
  }
}

test("the CLI defaults to a dry run and writes nothing", () => {
  const db = seededDb();
  try {
    const before = counts(db.path);
    const out = runCli(["supersede", "--db", db.path, "--old", "old", "--new", "new", "--reason", "已被推翻"]);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /DRY RUN/);
    assert.match(out.stdout, /Re-run with --apply/);
    assert.deepEqual(counts(db.path), before, "a dry run must not touch the record or the audit trail");
    assert.equal(row(db.path, "old").invalid_at, null);
  } finally {
    db.cleanup();
  }
});

test("--apply writes invalid_at, superseded_by and one audit row", () => {
  const db = seededDb();
  try {
    const out = runCli([
      "supersede", "--db", db.path, "--old", "old", "--new", "new", "--reason", "已被推翻", "--apply",
    ]);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /INVALIDATED \(written\)/);

    const r = row(db.path, "old");
    assert.ok(r.invalid_at, "invalid_at must be set");
    assert.equal(r.superseded_by, "new");
    assert.equal(r.state, "active", "invalidation is not eviction: state must not move");

    const audit = new DatabaseSync(db.path, { readOnly: true });
    const rows = audit.prepare("SELECT action, reason, from_state, to_state FROM forgetting_audit").all() as Array<{
      action: string;
      reason: string;
      from_state: string;
      to_state: string;
    }>;
    audit.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "invalidate");
    assert.equal(rows[0].reason, "已被推翻", "the operator's reason must reach the audit row, not just stdout");
    assert.equal(rows[0].from_state, "active");
  } finally {
    db.cleanup();
  }
});

test("a missing or blank --reason is rejected and nothing is written", () => {
  const db = seededDb();
  try {
    const before = counts(db.path);
    for (const args of [
      ["supersede", "--db", db.path, "--old", "old", "--apply"],
      ["supersede", "--db", db.path, "--old", "old", "--reason", "   ", "--apply"],
      ["supersede", "--db", db.path, "--old", "old", "--reason", "", "--apply"],
    ]) {
      const out = runCli(args);
      assert.equal(out.status, 4, `expected the rejection exit code for: ${args.join(" ")}`);
      assert.match(out.stderr, /--reason is required/);
    }
    assert.deepEqual(counts(db.path), before);
  } finally {
    db.cleanup();
  }
});

test("an unknown --old is rejected and nothing is written", () => {
  const db = seededDb();
  try {
    const before = counts(db.path);
    const out = runCli(["supersede", "--db", db.path, "--old", "ghost", "--reason", "测试", "--apply"]);
    assert.equal(out.status, 4);
    assert.match(out.stderr, /--old does not name a record/);
    assert.deepEqual(counts(db.path), before);
  } finally {
    db.cleanup();
  }
});

test("an unknown --new is rejected, so a typo cannot orphan a supersede", () => {
  const db = seededDb();
  try {
    const before = counts(db.path);
    const out = runCli(["supersede", "--db", db.path, "--old", "old", "--new", "ghost", "--reason", "测试", "--apply"]);
    assert.equal(out.status, 4);
    assert.match(out.stderr, /--new does not name a record/);
    assert.deepEqual(counts(db.path), before);
  } finally {
    db.cleanup();
  }
});

test("a record can be invalidated with no successor at all", () => {
  const db = seededDb();
  try {
    // A cancelled project has nothing replacing it. Requiring --new would force the
    // operator to name some arbitrary record, which is a lie in the audit trail.
    const out = runCli(["supersede", "--db", db.path, "--old", "old", "--reason", "项目取消", "--apply"]);
    assert.equal(out.status, 0);
    const r = row(db.path, "old");
    assert.ok(r.invalid_at);
    assert.equal(r.superseded_by, null, "no successor is a legitimate state, not a missing value");
  } finally {
    db.cleanup();
  }
});

test("invalidating twice is rejected rather than silently rewriting the reason", () => {
  const db = seededDb();
  try {
    runCli(["supersede", "--db", db.path, "--old", "old", "--reason", "第一次", "--apply"]);
    const after = counts(db.path);
    const out = runCli(["supersede", "--db", db.path, "--old", "old", "--reason", "第二次", "--apply"]);
    assert.equal(out.status, 4);
    assert.match(out.stderr, /already invalidated/);
    assert.deepEqual(counts(db.path), after, "the second attempt must not add an audit row");
    const audit = new DatabaseSync(db.path, { readOnly: true });
    const reason = (audit.prepare("SELECT reason FROM forgetting_audit").get() as { reason: string }).reason;
    audit.close();
    assert.equal(reason, "第一次", "the original reason stands; a rejected retry must not overwrite it");
  } finally {
    db.cleanup();
  }
});

test("an invalidated record leaves the recall view but keeps its state", () => {
  const db = seededDb();
  try {
    runCli(["supersede", "--db", db.path, "--old", "old", "--reason", "被推翻", "--apply"]);
    const conn = new DatabaseSync(db.path, { readOnly: true });
    const visible = conn.prepare("SELECT record_id FROM l1_recallable WHERE record_id = ?").get("old");
    const stillRow = conn.prepare("SELECT state FROM l1_records WHERE record_id = ?").get("old") as { state: string };
    conn.close();
    assert.equal(visible, undefined, "the view is the definition of recallable");
    assert.equal(stillRow.state, "active", "and the record is still in the active set");
  } finally {
    db.cleanup();
  }
});

test("restore clears one column and the record is recallable again", () => {
  const db = seededDb();
  try {
    runCli(["supersede", "--db", db.path, "--old", "old", "--reason", "被推翻", "--apply"]);
    const out = runCli(["invalidated", "--db", db.path, "--restore", "old"]);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /recallable again/);

    const r = row(db.path, "old");
    assert.equal(r.invalid_at, null);
    assert.equal(r.superseded_by, null);
    assert.equal(r.state, "active");

    const conn = new DatabaseSync(db.path, { readOnly: true });
    const visible = conn.prepare("SELECT record_id FROM l1_recallable WHERE record_id = ?").get("old");
    const auditCount = (conn.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as { c: number }).c;
    conn.close();
    assert.ok(visible, "restoring puts it back on the recall path");
    // The audit row is history. Restoring does not erase the fact that someone once
    // invalidated it, which is what makes a mistaken invalidation reviewable later.
    assert.equal(auditCount, 1, "restore must not delete the audit trail");
  } finally {
    db.cleanup();
  }
});

test("restoring a record that is not invalidated reports no change and exits non-zero", () => {
  const db = seededDb();
  try {
    const out = runCli(["invalidated", "--db", db.path, "--restore", "old"]);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /no change/);
  } finally {
    db.cleanup();
  }
});

test("the invalidated listing is how a mistake stays findable", () => {
  const db = seededDb();
  try {
    runCli(["supersede", "--db", db.path, "--old", "old", "--reason", "标错了的那条", "--apply"]);
    const out = runCli(["invalidated", "--db", db.path]);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /invalidated records: 1/);
    assert.match(out.stdout, /old/);
    assert.match(out.stdout, /state=active/, "the listing shows state, so an operator can see it was not evicted");

    const json = runCli(["invalidated", "--db", db.path, "--json"]);
    const parsed = JSON.parse(json.stdout) as Array<{ record_id: string; superseded_by: string | null }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].record_id, "old");
  } finally {
    db.cleanup();
  }
});

test("planSupersede describes exactly what applySupersede writes", () => {
  const db = seededDb();
  try {
    const opts = { oldId: "old", newId: "new", reason: "  理由带空格  " };
    const planned = planSupersede(db.path, opts);
    assert.ok(planned.plan);
    assert.equal(planned.applied, false);
    // Whitespace is trimmed once, in the plan, so the dry run and the write cannot
    // disagree about what the audit row will say.
    assert.equal(planned.plan.reason, "理由带空格");

    applySupersede(db.path, opts);
    const audit = new DatabaseSync(db.path, { readOnly: true });
    const reason = (audit.prepare("SELECT reason FROM forgetting_audit").get() as { reason: string }).reason;
    audit.close();
    assert.equal(reason, planned.plan.reason);
  } finally {
    db.cleanup();
  }
});

test("there is no automatic invalidation path in this module", () => {
  // C2's scope is the human command plus the criteria document. A judgement about
  // whether one record supersedes another must come from a caller passing an explicit
  // reason; nothing here decides it. C6 owns the LLM path, behind its own gate.
  const db = seededDb();
  try {
    for (const bad of [
      { oldId: "old", reason: "" },
      { oldId: "old", reason: "   " },
    ]) {
      const r = applySupersede(db.path, bad);
      assert.equal(r.rejection, "empty-reason");
    }
    assert.deepEqual(counts(db.path), { invalid: 0, audit: 0 }, "a reason is mandatory, so no caller can auto-fire this");
    assert.deepEqual(listInvalidated(db.path), []);
  } finally {
    db.cleanup();
  }
});
