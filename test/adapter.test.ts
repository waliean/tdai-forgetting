import { test } from "node:test";
import assert from "node:assert/strict";

import { corpusStats, loadRecords } from "../src/adapters/tdai-sqlite.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

test("isolation filters select one tenant and leave the rest alone", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [
      makeRecord({ record_id: "a1", team_id: "alpha", agent_id: "x", user_id: "u1" }),
      makeRecord({ record_id: "a2", team_id: "alpha", agent_id: "x", user_id: "u2" }),
      makeRecord({ record_id: "b1", team_id: "beta", agent_id: "x", user_id: "u1" }),
    ]);
    assert.deepEqual(
      loadRecords(db.path, { team_id: "alpha" }).map((r) => r.record_id).sort(),
      ["a1", "a2"],
    );
    assert.deepEqual(
      loadRecords(db.path, { team_id: "alpha", user_id: "u1" }).map((r) => r.record_id),
      ["a1"],
    );
  } finally {
    db.cleanup();
  }
});

test("limit and ordering are stable", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [
      makeRecord({ record_id: "new", created_time: "2026-10-01T00:00:00.000Z" }),
      makeRecord({ record_id: "old", created_time: "2026-08-01T00:00:00.000Z" }),
    ]);
    assert.deepEqual(loadRecords(db.path).map((r) => r.record_id), ["old", "new"]);
    assert.deepEqual(loadRecords(db.path, { limit: 1 }).map((r) => r.record_id), ["old"]);
  } finally {
    db.cleanup();
  }
});

test("corpus stats summarise types, months and priority pins", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [
      makeRecord({ record_id: "a", type: "episodic", created_time: "2026-09-03T00:00:00.000Z", priority: -1 }),
      makeRecord({ record_id: "b", type: "instruction", created_time: "2026-09-20T00:00:00.000Z" }),
      makeRecord({ record_id: "c", type: "episodic", created_time: "2026-10-01T00:00:00.000Z" }),
    ]);
    const stats = corpusStats(loadRecords(db.path));
    assert.equal(stats.total, 3);
    assert.deepEqual(stats.byType, { episodic: 2, instruction: 1 });
    assert.deepEqual(stats.byMonth, { "2026-09": 2, "2026-10": 1 });
    assert.equal(stats.pinnedByPriority, 1);
    assert.equal(stats.oldest, "2026-09-03T00:00:00.000Z");
    assert.equal(stats.newest, "2026-10-01T00:00:00.000Z");
  } finally {
    db.cleanup();
  }
});

test("records with empty fields do not crash the stats", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [makeRecord({ record_id: "a", type: "", created_time: "" })]);
    const stats = corpusStats(loadRecords(db.path));
    assert.equal(stats.byType["(empty)"], 1);
    assert.equal(stats.byMonth["(unknown)"], 1);
  } finally {
    db.cleanup();
  }
});
