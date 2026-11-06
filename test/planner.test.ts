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

// ── Invalidation pass (canvas C / c4-planner-pass) ──
//
// The pass reads `invalid_at`; it never decides whether a record was superseded. These
// tests therefore set the field directly, which is also what the supersede command
// does — there is no judgement to simulate.

test("an invalidated record is archived even with a high score", () => {
  const records = [
    // Maximally healthy on every other axis: recent, important, frequently accessed.
    // If invalidation lost to the score, this is the record that would expose it.
    makeRecord({
      record_id: "good-but-wrong",
      updated_time: "2026-10-25T00:00:00.000Z",
      priority: 99,
      access_count: 50,
      invalid_at: "2026-10-20T00:00:00.000Z",
      superseded_by: "newer",
    }),
    makeRecord({ record_id: "fine", updated_time: "2026-10-25T00:00:00.000Z" }),
  ];
  const result = plan(records);
  const d = result.decisions.find((x) => x.record.record_id === "good-but-wrong");
  assert.equal(d?.decision, "archive", "being contradicted overrides being important");
  assert.match(d?.reason ?? "", /^invalid since /);
  assert.equal(result.invalidated, 1);
});

test("the reason names the date and the successor, greppably", () => {
  const records = [
    makeRecord({ record_id: "old", invalid_at: "2026-10-20T00:00:00.000Z", superseded_by: "new" }),
  ];
  const result = plan(records);
  const d = result.decisions.find((x) => x.record.record_id === "old");
  assert.equal(d?.reason, "invalid since 2026-10-20T00:00:00.000Z, superseded by new");
});

test("an invalid record with no successor says so instead of looking truncated", () => {
  const records = [makeRecord({ record_id: "cancelled", invalid_at: "2026-10-20T00:00:00.000Z" })];
  const result = plan(records);
  const d = result.decisions.find((x) => x.record.record_id === "cancelled");
  assert.equal(d?.reason, "invalid since 2026-10-20T00:00:00.000Z, no successor");
});

test("invalidation is archive, never retire: a contradicted conclusion is still history", () => {
  const records = [
    makeRecord({
      record_id: "ancient-and-wrong",
      updated_time: "2020-01-01T00:00:00.000Z",
      priority: 1,
      invalid_at: "2026-10-20T00:00:00.000Z",
    }),
  ];
  const result = plan(records);
  const d = result.decisions.find((x) => x.record.record_id === "ancient-and-wrong");
  assert.equal(d?.decision, "archive", "retiring it would put it past the tier a reader checks");
  assert.equal(result.retired, 0);
});

test("invalidation is decided before the absolute threshold", () => {
  // Both passes would evict this record, and the decision is which reason gets
  // recorded. Invalid is the more specific explanation, so it must be the one the
  // audit shows -- otherwise "we were contradicted" is filed as "we got old".
  const records = [
    makeRecord({
      record_id: "old-and-invalid",
      updated_time: "2020-01-01T00:00:00.000Z",
      priority: 1,
      invalid_at: "2026-10-20T00:00:00.000Z",
    }),
  ];
  const result = plan(records);
  const d = result.decisions.find((x) => x.record.record_id === "old-and-invalid");
  assert.match(d?.reason ?? "", /^invalid since /, "the invalidation reason must win over the age reason");
  assert.doesNotMatch(d?.reason ?? "", /score .* < retire/);
});

test("a hard pin beats invalidation, and the conflict is reported", () => {
  const records = [
    makeRecord({
      record_id: "pinned-but-wrong",
      priority: -1,
      invalid_at: "2026-10-20T00:00:00.000Z",
      superseded_by: "newer",
    }),
    makeRecord({ record_id: "plain", updated_time: "2026-10-25T00:00:00.000Z" }),
  ];
  const result = plan(records);
  const d = result.decisions.find((x) => x.record.record_id === "pinned-but-wrong");
  assert.equal(d?.decision, "keep", "an explicit human instruction wins over the flag");
  assert.equal(result.invalidated, 0);
  assert.equal(result.pinInvalidConflicts.length, 1, "and the collision must not be swallowed");
  assert.equal(result.pinInvalidConflicts[0].record_id, "pinned-but-wrong");
  assert.match(result.pinInvalidConflicts[0].pin_reason, /priority=-1|permanence/i);
});

test("maxEvictionsPerRun caps the invalidation pass like every other pass", () => {
  const records = Array.from({ length: 5 }, (_, i) =>
    makeRecord({ record_id: `inv${i}`, invalid_at: "2026-10-20T00:00:00.000Z" }),
  );
  const result = buildForgettingPlan(records, baseConfig(), { maxEvictionsPerRun: 1 });
  const evicted = result.decisions.filter((d) => d.decision !== "keep");
  assert.equal(evicted.length, 1, "the cap is a guard against a bad config wiping the corpus");
  assert.equal(result.invalidated, 1);
});

test("a corpus with nothing invalidated reports 0 rather than omitting the field", () => {
  const records = [makeRecord({ record_id: "fine", updated_time: "2026-10-25T00:00:00.000Z" })];
  const result = plan(records);
  assert.equal(result.invalidated, 0);
  assert.deepEqual(result.pinInvalidConflicts, []);
});
