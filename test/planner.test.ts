import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForgettingPlan, DEFAULT_EVICTION } from "../src/planner.ts";
import { DEFAULT_DECAY } from "../src/scoring.ts";
import type { MemoryRecord } from "../src/types.ts";
import { makeRecord } from "./fixtures.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

const baseConfig = (eviction: Partial<typeof DEFAULT_EVICTION> = {}) => ({
  // Pin, redundancy and quota behaviour is what these tests cover; the cold-start
  // gate has its own tests, so it is held open here.
  decay: { ...DEFAULT_DECAY, minTrackingCoverage: 0 },
  eviction: { ...DEFAULT_EVICTION, ...eviction },
  now: () => NOW,
});

function plan(records: MemoryRecord[], eviction: Partial<typeof DEFAULT_EVICTION> = {}) {
  return buildForgettingPlan(records, baseConfig(eviction));
}

test("a pinned record is never demoted, whatever the quota says", () => {
  const records = [
    makeRecord({ record_id: "pin", priority: -1, updated_time: "2020-01-01T00:00:00.000Z" }),
    makeRecord({ record_id: "fresh", updated_time: "2026-10-25T00:00:00.000Z" }),
  ];
  const result = plan(records, { quota: 1, minRetain: 1 });
  const pinned = result.decisions.find((d) => d.record.record_id === "pin");
  assert.equal(pinned?.decision, "keep");
  assert.match(pinned?.reason ?? "", /pinned/);
});

test("quota evicts the lowest-scoring records first", () => {
  const records = [
    makeRecord({ record_id: "cold", updated_time: "2026-08-01T00:00:00.000Z", priority: 60 }),
    makeRecord({ record_id: "warm", updated_time: "2026-10-20T00:00:00.000Z", priority: 80 }),
    makeRecord({ record_id: "hot", updated_time: "2026-10-25T00:00:00.000Z", priority: 95, access_count: 10 }),
  ];
  const result = plan(records, { quota: 2, minRetain: 1 });
  const demoted = result.decisions.filter((d) => d.decision !== "keep").map((d) => d.record.record_id);
  assert.deepEqual(demoted, ["cold"]);
  assert.equal(result.kept, 2);
});

test("the quota can never push the corpus below min-retain", () => {
  const records = Array.from({ length: 10 }, (_, i) =>
    makeRecord({ record_id: `r${i}`, updated_time: "2026-08-01T00:00:00.000Z" }),
  );
  const result = plan(records, { quota: 2, minRetain: 8 });
  assert.ok(result.kept >= 8, `kept ${result.kept}`);
});

test("redundancy is resolved before the quota, so duplicates pay first", () => {
  const shared = "这段话在两条记录里几乎一模一样，用来验证冗余优先于配额淘汰的判断顺序是否正确。";
  const records = [
    makeRecord({ record_id: "dup1", content: shared + "甲", priority: 95, updated_time: "2026-10-25T00:00:00.000Z" }),
    makeRecord({ record_id: "dup2", content: shared + "乙", priority: 60, updated_time: "2026-10-25T00:00:00.000Z" }),
    makeRecord({ record_id: "unique", content: "另一条完全独立的内容，内容长度同样足够参与聚类判断的计算。", priority: 70, updated_time: "2026-10-25T00:00:00.000Z" }),
  ];
  const result = plan(records, { quota: 2, minRetain: 1 });
  const demoted = result.decisions.filter((d) => d.decision !== "keep");
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].record.record_id, "dup2");
  assert.match(demoted[0].reason, /redundant with dup1/);
});

test("retire requires both a low score and an age past the gate", () => {
  const young = makeRecord({ record_id: "young", updated_time: "2026-10-24T00:00:00.000Z", priority: 0 });
  const ancient = makeRecord({ record_id: "ancient", updated_time: "2025-01-01T00:00:00.000Z", priority: 0 });
  const result = plan([young, ancient], { retireThreshold: 0.9, archiveThreshold: 0.95, minAgeDays: 14 });
  const decisions = Object.fromEntries(result.decisions.map((d) => [d.record.record_id, d.decision]));
  // Both score low, but only the ancient one clears the age gate.
  assert.equal(decisions.young, "archive");
  assert.equal(decisions.ancient, "retire");
});

test("maxEvictionsPerRun caps a plan even when the policy asks for more", () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    makeRecord({ record_id: `r${i}`, updated_time: "2026-08-01T00:00:00.000Z", priority: 0 }),
  );
  const result = buildForgettingPlan(records, baseConfig({ retireThreshold: 0.99, minAgeDays: 0 }), {
    maxEvictionsPerRun: 3,
  });
  const demoted = result.decisions.filter((d) => d.decision !== "keep");
  assert.equal(demoted.length, 3);
});

test("an empty corpus produces an empty plan rather than throwing", () => {
  const result = plan([]);
  assert.equal(result.total, 0);
  assert.equal(result.kept, 0);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.scoreDistribution.p50, 0);
});

test("the plan is deterministic: same input, same output", () => {
  const records = Array.from({ length: 30 }, (_, i) =>
    makeRecord({
      record_id: `r${i}`,
      updated_time: `2026-0${(i % 9) + 1}-01T00:00:00.000Z`,
      priority: 50 + (i % 40),
    }),
  );
  const a = plan(records, { quota: 10 });
  const b = plan(records, { quota: 10 });
  assert.deepEqual(
    a.decisions.map((d) => [d.record.record_id, d.decision]),
    b.decisions.map((d) => [d.record.record_id, d.decision]),
  );
});

test("non-active records are not re-planned", () => {
  const records = [
    makeRecord({ record_id: "archived", state: "archived", updated_time: "2026-01-01T00:00:00.000Z" }),
    makeRecord({ record_id: "live", state: "active", updated_time: "2026-10-25T00:00:00.000Z" }),
  ];
  const result = plan(records);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].record.record_id, "live");
});

test("score distribution is reported for threshold review", () => {
  const records = Array.from({ length: 100 }, (_, i) =>
    makeRecord({
      record_id: `r${i}`,
      updated_time: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
      priority: 50 + (i % 50),
    }),
  );
  const result = plan(records);
  const d = result.scoreDistribution;
  assert.ok(d.min <= d.p10 && d.p10 <= d.p50 && d.p50 <= d.p90 && d.p90 <= d.max);
});
