import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DECAY, decayEnabled, rerankHits, trackingCoverage } from "../src/scoring.ts";
import { buildForgettingPlan, DEFAULT_EVICTION } from "../src/planner.ts";
import { makeRecord } from "./fixtures.ts";
import type { MemoryRecord } from "../src/types.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

test("coverage counts records with any access evidence, not just nonzero counts", () => {
  const records = [
    makeRecord({ record_id: "a", access_count: 4 }),
    makeRecord({ record_id: "b", access_count: 0, last_access_time: NOW.toISOString() }),
    makeRecord({ record_id: "c" }),
    makeRecord({ record_id: "d" }),
  ];
  assert.equal(trackingCoverage(records), 0.5);
  assert.equal(trackingCoverage([]), 0);
});

test("the gate closes below the threshold and opens above it", () => {
  const cfg = { ...DEFAULT_DECAY, minTrackingCoverage: 0.2 };
  assert.equal(decayEnabled(0, cfg), false);
  assert.equal(decayEnabled(0.19, cfg), false);
  assert.equal(decayEnabled(0.2, cfg), true);
  assert.equal(decayEnabled(1, cfg), true);
});

test("a threshold of zero keeps decay always on, for callers that mean it", () => {
  assert.equal(decayEnabled(0, { ...DEFAULT_DECAY, minTrackingCoverage: 0 }), true);
});

test("with decay off, age no longer moves a record's rank", () => {
  const ancient = makeRecord({ record_id: "ancient", updated_time: "2019-01-01T00:00:00.000Z" });
  const fresh = makeRecord({ record_id: "fresh", updated_time: "2026-10-26T00:00:00.000Z" });
  const ranked = rerankHits(
    [
      { record: ancient, score: 0.9 },
      { record: fresh, score: 0.8 },
    ],
    DEFAULT_DECAY,
    NOW,
    { decay: false },
  );
  // Order follows the raw score because the age term is gone.
  assert.equal(ranked[0].record.record_id, "ancient");
  assert.equal(ranked[0].multiplier, ranked[1].multiplier);
});

test("with decay off, a recalled record still outranks a forgotten one", () => {
  const used = makeRecord({ record_id: "used", updated_time: "2026-10-26T00:00:00.000Z", access_count: 12, last_access_time: NOW.toISOString() });
  const unused = makeRecord({ record_id: "unused", updated_time: "2026-10-26T00:00:00.000Z" });
  const ranked = rerankHits(
    [
      { record: unused, score: 0.8 },
      { record: used, score: 0.8 },
    ],
    DEFAULT_DECAY,
    NOW,
    { decay: false },
  );
  assert.equal(ranked[0].record.record_id, "used");
});

test("a cold corpus produces a plan with decay off and says so", () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    makeRecord({
      record_id: `r${i}`,
      updated_time: new Date(NOW.getTime() - (i + 1) * 86_400_000).toISOString(),
      priority: 90,
    }),
  );
  const plan = buildForgettingPlan(records, {
    decay: DEFAULT_DECAY,
    eviction: DEFAULT_EVICTION,
    now: () => NOW,
  });
  assert.equal(plan.trackingCoverage, 0);
  assert.equal(plan.decayActive, false);
  // Nothing is stale enough to evict on age alone when age is not evidence.
  assert.equal(plan.retired + plan.archived, 0);
});

test("a warm corpus lets the same records be evicted on their merits", () => {
  const records: MemoryRecord[] = Array.from({ length: 20 }, (_, i) =>
    makeRecord({
      record_id: `r${i}`,
      updated_time: new Date(NOW.getTime() - (i + 1) * 86_400_000).toISOString(),
      priority: 40,
      access_count: i % 3 === 0 ? 9 : 0,
      last_access_time: NOW.toISOString(),
    }),
  );
  const plan = buildForgettingPlan(records, {
    decay: DEFAULT_DECAY,
    eviction: { ...DEFAULT_EVICTION, archiveThreshold: 0.9, retireThreshold: 0.5, minAgeDays: 0 },
    now: () => NOW,
  });
  assert.equal(plan.trackingCoverage, 1);
  assert.equal(plan.decayActive, true);
  assert.ok(plan.archived + plan.retired > 0);
});

test("the gate never touches pins", () => {
  const plan = buildForgettingPlan(
    [
      makeRecord({ record_id: "pin", priority: -1, updated_time: "2018-01-01T00:00:00.000Z" }),
      makeRecord({ record_id: "plain", priority: 30, updated_time: "2018-01-01T00:00:00.000Z" }),
    ],
    { decay: DEFAULT_DECAY, eviction: { ...DEFAULT_EVICTION, retireThreshold: 1, minAgeDays: 0 }, now: () => NOW },
  );
  const pin = plan.decisions.find((d) => d.record.record_id === "pin");
  assert.equal(pin?.decision, "keep");
});
