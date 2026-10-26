import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { applyPlan, auditSummary } from "../src/applier.ts";
import { buildForgettingPlan, DEFAULT_EVICTION } from "../src/planner.ts";
import { DEFAULT_DECAY } from "../src/scoring.ts";
import { createTempDb, insertRecords, makeRecord, readStates } from "./fixtures.ts";
import type { ForgettingPlanReport } from "../src/planner.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

/**
 * A deliberately blunt policy: thresholds in the middle of the range so a simple
 * fixture produces both archival and retirement without depending on exact scores.
 */
function freshPlan(records: Parameters<typeof buildForgettingPlan>[0]) {
  return buildForgettingPlan(records, {
    // These fixtures exercise the applier, not the cold-start gate, so decay stays
    // on regardless of whether the fixture happens to carry access history.
    decay: { ...DEFAULT_DECAY, minTrackingCoverage: 0 },
    // Thresholds sit inside the reachable band: an ancient high-priority record
    // scores about 0.67 (importance 0.95, decay pinned at the floor), a fresh one
    // about 0.99. 0.90/0.95 separates them cleanly without magic precision.
    eviction: { ...DEFAULT_EVICTION, retireThreshold: 0.9, archiveThreshold: 0.95, minAgeDays: 0 },
    now: () => NOW,
  });
}

test("apply moves records to archive/retire and writes one audit row each", () => {
  const db = createTempDb();
  try {
    const records = [
      makeRecord({ record_id: "a", updated_time: "2026-01-01T00:00:00.000Z", priority: 95 }),
      makeRecord({ record_id: "b", updated_time: "2026-01-01T00:00:00.000Z", priority: 96 }),
      makeRecord({ record_id: "keep", updated_time: "2026-10-25T00:00:00.000Z", priority: 99 }),
    ];
    insertRecords(db.path, records);
    const plan = freshPlan(records);
    assert.ok(plan.retired > 0, "fixture should produce retirements");
    assert.ok(plan.decisions.some((d) => d.record.record_id === "keep" && d.decision === "keep"));

    const result = applyPlan(db.path, plan, { notes: "unit test" });
    assert.equal(result.dryRun, false);
    assert.equal(result.auditRows, plan.archived + plan.retired);

    const states = readStates(db.path);
    assert.equal(states.keep, "active");
    for (const d of plan.decisions) {
      if (d.decision === "retire") assert.equal(states[d.record.record_id], "retired");
      if (d.decision === "archive") assert.equal(states[d.record.record_id], "archived");
    }

    const db2 = new DatabaseSync(db.path, { readOnly: true });
    const audit = db2.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as { c: number };
    const runs = db2.prepare("SELECT COUNT(*) AS c FROM forgetting_runs").get() as { c: number };
    db2.close();
    assert.equal(audit.c, result.auditRows);
    assert.equal(runs.c, 1);
  } finally {
    db.cleanup();
  }
});

test("dry run writes nothing at all", () => {
  const db = createTempDb();
  try {
    const records = [
      makeRecord({ record_id: "a", updated_time: "2026-01-01T00:00:00.000Z", priority: 5 }),
      makeRecord({ record_id: "b", updated_time: "2026-10-25T00:00:00.000Z", priority: 99 }),
    ];
    insertRecords(db.path, records);
    const plan = freshPlan(records);
    const result = applyPlan(db.path, plan, { dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.archived + result.retired > 0, true, "dry run should still report what would happen");
    assert.deepEqual(readStates(db.path), { a: "active", b: "active" });

    const db2 = new DatabaseSync(db.path, { readOnly: true });
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'forgetting%'")
      .all() as unknown as Array<{ name: string }>;
    db2.close();
    assert.deepEqual(tables, [], "dry run must not create the audit tables either");
  } finally {
    db.cleanup();
  }
});

test("a hard pin is never written even if a plan claims it should be", () => {
  const db = createTempDb();
  try {
    const records = [makeRecord({ record_id: "pin", priority: -1, updated_time: "2020-01-01T00:00:00.000Z" })];
    insertRecords(db.path, records);
    const plan = freshPlan(records);
    // Forge a malicious/buggy plan entry to prove the applier enforces the pin.
    const forged: ForgettingPlanReport = {
      ...plan,
      decisions: [
        { record: { ...records[0], pinned: true, pin_kind: "hard" }, score: 0, decision: "retire", reason: "forged" },
      ],
    };
    const result = applyPlan(db.path, forged);
    assert.equal(result.skippedPinned, 1);
    assert.equal(result.retired, 0);
    assert.equal(readStates(db.path).pin, "active");
  } finally {
    db.cleanup();
  }
});

test("an extended pin is writable: slow decay is not immunity", () => {
  const db = createTempDb();
  try {
    const records = [makeRecord({ record_id: "slow", updated_time: "2020-01-01T00:00:00.000Z" })];
    insertRecords(db.path, records);
    const forged: ForgettingPlanReport = {
      ...freshPlan(records),
      decisions: [
        {
          record: { ...records[0], pinned: true, pin_kind: "extended", pin_half_life_multiplier: 12 },
          score: 0.2,
          decision: "archive",
          reason: "score below threshold despite extended half-life",
        },
      ],
    };
    const result = applyPlan(db.path, forged);
    assert.equal(result.skippedPinned, 0);
    assert.equal(result.archived, 1);
    assert.equal(readStates(db.path).slow, "archived");
  } finally {
    db.cleanup();
  }
});

test("applying twice is idempotent for states and additive for audit", () => {
  const db = createTempDb();
  try {
    const records = [
      makeRecord({ record_id: "a", updated_time: "2026-01-01T00:00:00.000Z", priority: 5 }),
      makeRecord({ record_id: "b", updated_time: "2026-10-25T00:00:00.000Z", priority: 99 }),
    ];
    insertRecords(db.path, records);
    const plan = freshPlan(records);
    applyPlan(db.path, plan);
    const afterFirst = readStates(db.path);
    const second = applyPlan(db.path, plan);
    assert.deepEqual(readStates(db.path), afterFirst);
    assert.equal(second.auditRows, plan.archived + plan.retired, "second run still logs what it decided");
  } finally {
    db.cleanup();
  }
});

test("an unknown record id in the plan does not abort the transaction", () => {
  const db = createTempDb();
  try {
    const records = [makeRecord({ record_id: "real", updated_time: "2026-01-01T00:00:00.000Z", priority: 5 })];
    insertRecords(db.path, records);
    const plan = freshPlan(records);
    const withGhost: ForgettingPlanReport = {
      ...plan,
      decisions: [
        ...plan.decisions,
        { record: { ...records[0], record_id: "ghost" }, score: 0.01, decision: "retire", reason: "not in db" },
      ],
    };
    const result = applyPlan(db.path, withGhost);
    assert.ok(result.auditRows >= 2);
    assert.equal(readStates(db.path).real !== "active", true);
  } finally {
    db.cleanup();
  }
});

test("audit summary reports states and run history", () => {
  const db = createTempDb();
  try {
    const records = [makeRecord({ record_id: "a", updated_time: "2026-01-01T00:00:00.000Z", priority: 5 })];
    insertRecords(db.path, records);
    applyPlan(db.path, freshPlan(records), { notes: "summary test" });

    const summary = auditSummary(db.path);
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.runs[0].status, "completed");
    assert.ok((summary.states.retired ?? 0) + (summary.states.archived ?? 0) === 1);
  } finally {
    db.cleanup();
  }
});

test("audit summary tolerates an un-migrated database", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [makeRecord({ record_id: "a" })]);
    const summary = auditSummary(db.path);
    assert.deepEqual(summary.runs, []);
    assert.equal(summary.states.active, 1);
  } finally {
    db.cleanup();
  }
});
