/**
 * Tests for the readable audit view.
 *
 * Two things are being protected here. The grouping must be honest — a flat JSON dump
 * does not tell an operator which run moved forty records or why, so the counters have
 * to be computed from the audit table rather than from anything the plan claims. And the
 * reason grouping must use the same digit-collapsing rule as the plan renderer, or "the
 * top reason" would mean two things in the two places an operator looks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { applyPlan, auditRun, auditSummary, reasonKey } from "../src/applier.ts";
import { buildForgettingPlan, DEFAULT_EVICTION } from "../src/planner.ts";
import { DEFAULT_DECAY } from "../src/scoring.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NOW = new Date("2026-10-26T12:00:00.000Z");

/** Blunt policy so a simple fixture lands in archive/retire without exact-score maths. */
function bluntPlan(records: Parameters<typeof buildForgettingPlan>[0]) {
  return buildForgettingPlan(records, {
    decay: { ...DEFAULT_DECAY, minTrackingCoverage: 0 },
    eviction: { ...DEFAULT_EVICTION, retireThreshold: 0.9, archiveThreshold: 0.95, minAgeDays: 0 },
    now: () => NOW,
  });
}

test("reasonKey collapses reasons that differ only in their numbers", () => {
  assert.equal(reasonKey("score 0.312 < archive 0.45"), reasonKey("score 0.298 < archive 0.45"));
  assert.notEqual(reasonKey("score 0.312 < archive 0.45"), reasonKey("quota 100: bottom-ranked (1/5)"));
  // The generalisation is not "drop everything after the first space": the words carry
  // the meaning and must survive.
  assert.match(reasonKey("score 0.312 < archive 0.45"), /archive/);
});

test("an empty audit trail reports zeroes instead of failing", () => {
  const db = createTempDb();
  try {
    const summary = auditSummary(db.path);
    assert.deepEqual(summary.actions, {});
    assert.deepEqual(summary.reasons, []);
    assert.deepEqual(summary.types, {});
    assert.deepEqual(summary.runs, []);
  } finally {
    db.cleanup();
  }
});

test("three runs are counted separately and aggregated by action", () => {
  const db = createTempDb();
  try {
    for (let i = 0; i < 3; i++) {
      const records = [
        makeRecord({ record_id: `run${i}`, updated_time: "2026-01-01T00:00:00.000Z", priority: 96 }),
      ];
      insertRecords(db.path, records);
      applyPlan(db.path, bluntPlan(records));
    }

    const summary = auditSummary(db.path);
    assert.equal(summary.runs.length, 3, "one row per apply");
    const totalAuditRows = Object.values(summary.actions).reduce((sum, n) => sum + n, 0);
    assert.equal(totalAuditRows, 3, "one audit row per eviction");

    // Aggregation by reason must see one bucket for three single-row reasons that only
    // differ in their numbers — which is every one of these.
    const reasonTotal = summary.reasons.reduce((sum, r) => sum + r.count, 0);
    assert.equal(reasonTotal, totalAuditRows);
    assert.ok(summary.reasons.length <= totalAuditRows);

    // By type needs the join back to l1_records; a fixture that forgot to insert the
    // records would silently report nothing here.
    const typeTotal = Object.values(summary.types).reduce((sum, n) => sum + n, 0);
    assert.equal(typeTotal, totalAuditRows, "every audit row resolves to a record type");
  } finally {
    db.cleanup();
  }
});

test("auditRun returns the rows a run wrote, and nothing for an unknown id", () => {
  const db = createTempDb();
  try {
    const records = [makeRecord({ record_id: "only", updated_time: "2026-01-01T00:00:00.000Z", priority: 96 })];
    insertRecords(db.path, records);
    const result = applyPlan(db.path, bluntPlan(records));

    const entries = auditRun(db.path, result.runId, 50);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].record_id, "only");
    // The blunt policy puts the record through one of the two eviction paths; which one
    // depends on the score, and pinning that here would make this test about scoring.
    assert.ok(["archive", "retire"].includes(entries[0].action), `unexpected action ${entries[0].action}`);

    assert.deepEqual(auditRun(db.path, "no-such-run", 50), []);
  } finally {
    db.cleanup();
  }
});

test("audit --run on an unknown id says so and still exits 0", () => {
  const db = createTempDb();
  try {
    const result = spawnSync(process.execPath, [CLI, "audit", "--db", db.path, "--run", "no-such-run"], {
      encoding: "utf8",
    });
    // A run id that matched nothing is an empty answer, not a failure. A script asking
    // "did anything happen" must not have to parse stderr to learn that.
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no audit rows for run no-such-run/);
  } finally {
    db.cleanup();
  }
});

test("audit --json still returns the raw structure", () => {
  const db = createTempDb();
  try {
    const result = spawnSync(process.execPath, [CLI, "audit", "--db", db.path, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ["states", "runs", "actions", "reasons", "types"]) {
      assert.ok(key in parsed, `--json must keep the ${key} key for existing callers`);
    }
  } finally {
    db.cleanup();
  }
});
