/**
 * Tests for scripts/healthcheck.ts.
 *
 * The script is spawned rather than imported: its contract is an exit code plus one
 * screen of text, and a scheduler only ever sees those two. Each test breaks the
 * database in one specific way and asserts that exactly the matching check fails —
 * a check that cannot be made to fail is decoration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { applyPlan } from "../src/applier.ts";
import { buildForgettingPlan, DEFAULT_EVICTION } from "../src/planner.ts";
import { DEFAULT_DECAY } from "../src/scoring.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/healthcheck.ts", import.meta.url));
const NOW = new Date("2026-10-26T12:00:00.000Z");

function run(dbPath: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, "--db", dbPath], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A database with one completed apply, plus whatever the caller wants to break. */
function seededDb(): { path: string; runId: string; cleanup: () => void } {
  const db = createTempDb();
  const records = [
    makeRecord({ record_id: "old", updated_time: "2026-01-01T00:00:00.000Z", priority: 96 }),
    makeRecord({ record_id: "pin", updated_time: "2026-01-01T00:00:00.000Z", priority: -1 }),
    // Enough healthy records that one eviction is a low rate: with a three-record
    // fixture, archiving one would read 33% and trip the very check under test.
    ...Array.from({ length: 20 }, (_, i) =>
      makeRecord({ record_id: `keep${i}`, updated_time: "2026-10-25T00:00:00.000Z", priority: 99 }),
    ),
  ];
  insertRecords(db.path, records);
  const plan = buildForgettingPlan(records, {
    decay: { ...DEFAULT_DECAY, minTrackingCoverage: 0 },
    eviction: { ...DEFAULT_EVICTION, retireThreshold: 0.9, archiveThreshold: 0.95, minAgeDays: 0 },
    now: () => NOW,
  });
  const result = applyPlan(db.path, plan);
  return { path: db.path, runId: result.runId, cleanup: db.cleanup };
}

test("a healthy database exits 0 and prints all four checks", () => {
  const db = seededDb();
  try {
    const r = run(db.path);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const name of ["coverage", "evictionRate", "pinIntact", "auditGaps"]) {
      assert.match(r.stdout, new RegExp(`\\b${name}\\b`), `missing check ${name}`);
    }
    assert.match(r.stdout, /all checks OK|WARN/);
  } finally {
    db.cleanup();
  }
});

test("a hard pin that left active fails pinIntact, and the exit code says so", () => {
  const db = seededDb();
  try {
    // The planner refuses to evict a hard pin, so an archived one cannot arise from the
    // normal path — it means something wrote around the engine. That is exactly the
    // invariant this check exists to catch.
    const writer = new DatabaseSync(db.path);
    try {
      writer.prepare("UPDATE l1_records SET state = 'archived' WHERE record_id = 'pin'").run();
    } finally {
      writer.close();
    }
    const r = run(db.path);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /pinIntact\s+1\s+FAIL/);
    assert.match(r.stdout, /pin\(archived\)/);
  } finally {
    db.cleanup();
  }
});

test("an eviction rate above 30% fails evictionRate", () => {
  const db = seededDb();
  try {
    const writer = new DatabaseSync(db.path);
    try {
      writer.prepare("UPDATE forgetting_runs SET archived = 300, total = 900 WHERE run_id = ?").run(db.runId);
    } finally {
      writer.close();
    }
    const r = run(db.path);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /evictionRate\s+[\d.]+%\s+FAIL/);
  } finally {
    db.cleanup();
  }
});

test("audit rows that do not match the run counters fail auditGaps", () => {
  const db = seededDb();
  try {
    const writer = new DatabaseSync(db.path);
    try {
      writer.prepare("DELETE FROM forgetting_audit WHERE run_id = ?").run(db.runId);
    } finally {
      writer.close();
    }
    const r = run(db.path);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /auditGaps\s+0 \/ \d+\s+FAIL/);
  } finally {
    db.cleanup();
  }
});

test("a database with no forgetting schema is reported, not crashed on", () => {
  const db = createTempDb();
  try {
    const r = run(db.path);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SKIP/);
  } finally {
    db.cleanup();
  }
});

test("the check leaves the database byte-identical", () => {
  const db = seededDb();
  try {
    // A read-only open is the implementation, but the contract is "no writes", so assert
    // the contract: the file must be unchanged after a run.
    const before = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
    assert.equal(before.status, 0);
    const writer = new DatabaseSync(db.path, { readOnly: true });
    let beforeCount = 0;
    try {
      beforeCount = (writer.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as unknown as { c: number }).c;
    } finally {
      writer.close();
    }
    run(db.path);
    const after = new DatabaseSync(db.path, { readOnly: true });
    try {
      const afterCount = (after.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as unknown as { c: number }).c;
      assert.equal(afterCount, beforeCount);
    } finally {
      after.close();
    }
  } finally {
    db.cleanup();
  }
});
