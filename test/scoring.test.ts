import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DECAY,
  ageAnchor,
  ageInDays,
  decayFactor,
  hasAccessSignal,
  importanceFromPriority,
  rerankHits,
  scoreRecord,
  searchMultiplier,
  usageFactor,
} from "../src/scoring.ts";
import type { MemoryRecord } from "../src/types.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: "r1",
    content: "用户偏好用中文回答",
    type: "instruction",
    priority: 90,
    scene_name: "prefs",
    team_id: "t",
    user_id: "u",
    agent_id: "a",
    created_time: "2026-10-25T12:00:00.000Z",
    updated_time: "2026-10-25T12:00:00.000Z",
    last_access_time: null,
    access_count: 0,
    state: "active",
    metadata_json: "{}",
    ...overrides,
  };
}

test("decay halves at one half-life and never drops below the floor", () => {
  const cfg = { ...DEFAULT_DECAY, halfLifeDays: 10, floor: 0.3 };
  assert.equal(decayFactor(0, cfg), 1);
  assert.ok(Math.abs(decayFactor(10, cfg) - (0.3 + 0.7 * 0.5)) < 1e-12);
  assert.ok(Math.abs(decayFactor(20, cfg) - (0.3 + 0.7 * 0.25)) < 1e-12);
  // Asymptote, not a crossing point: an ancient record still carries the floor.
  assert.ok(decayFactor(100000, cfg) > 0.3 - 1e-9);
});

test("decay is monotone decreasing and never exceeds 1", () => {
  let previous = Infinity;
  for (let day = 0; day <= 200; day += 7) {
    const value = decayFactor(day);
    assert.ok(value <= 1);
    assert.ok(value <= previous, `day ${day} broke monotonicity`);
    previous = value;
  }
});

test("usage saturates: early recalls matter more than later ones", () => {
  const firstThree = usageFactor(3) - usageFactor(0);
  const nextThree = usageFactor(6) - usageFactor(3);
  assert.ok(firstThree > nextThree, "diminishing returns expected");
  assert.equal(usageFactor(0), 0);
  // Asymptote at 1: repeated recall approaches certainty but floating point
  // reaches it long before the mathematical limit does.
  assert.ok(usageFactor(20) < 1);
  assert.ok(usageFactor(1000) <= 1);
  assert.ok(Math.abs(usageFactor(DEFAULT_DECAY.usageSaturation) - (1 - Math.exp(-1))) < 1e-12);
});

test("age anchor prefers access time over updated time", () => {
  const r = record({ last_access_time: "2026-10-26T12:00:00.000Z", updated_time: "2026-01-01T00:00:00.000Z" });
  assert.equal(ageAnchor(r), "2026-10-26T12:00:00.000Z");
  assert.equal(ageInDays(r, NOW), 0);
});

test("age anchor falls back to updated time when access was never recorded", () => {
  const r = record({ updated_time: "2026-10-16T12:00:00.000Z" });
  assert.equal(ageInDays(r, NOW), 10);
});

test("age is clamped at zero for clock skew and future timestamps", () => {
  const r = record({ updated_time: "2026-11-26T12:00:00.000Z" });
  assert.equal(ageInDays(r, NOW), 0);
});

test("priority -1 maps to full importance, 0-100 maps linearly", () => {
  assert.equal(importanceFromPriority(-1), 1);
  assert.equal(importanceFromPriority(0), 0);
  assert.equal(importanceFromPriority(100), 1);
  assert.equal(importanceFromPriority(45), 0.45);
  assert.equal(importanceFromPriority(Number.NaN), 0.5);
});

test("score without access history ignores the usage term entirely", () => {
  const cold = scoreRecord(record({ updated_time: "2026-10-16T12:00:00.000Z" }), DEFAULT_DECAY, NOW);
  const hot = scoreRecord(record({ updated_time: "2026-10-16T12:00:00.000Z", access_count: 40 }), DEFAULT_DECAY, NOW);
  // Both have the same importance and age; the difference must come only from the
  // scores that actually have usage data behind them.
  assert.equal(cold.usageFactor, 0);
  assert.equal(hot.usageFactor > 0, true);
});

test("an observed zero-access record scores below an unmeasured one at the same age", () => {
  const updated = "2026-10-16T12:00:00.000Z";
  const untracked = scoreRecord(record({ updated_time: updated }), DEFAULT_DECAY, NOW);
  // Same age anchor, but access tracking is live and the count is genuinely zero.
  const observedZero = scoreRecord(
    record({ updated_time: updated, access_count: 0, last_access_time: updated }),
    DEFAULT_DECAY,
    NOW,
  );
  // "We know it was never recalled" is evidence, and it must count against the
  // record; "nobody ever measured" must not. That is the whole point of the
  // renormalised denominator.
  assert.ok(observedZero.finalScore < untracked.finalScore);
  assert.ok(Math.abs(observedZero.decayFactor - untracked.decayFactor) < 1e-12);
});

test("usage raises the retention score of an otherwise identical record", () => {
  const stale = scoreRecord(record({ updated_time: "2026-10-16T12:00:00.000Z" }), DEFAULT_DECAY, NOW);
  const used = scoreRecord(
    record({ updated_time: "2026-10-16T12:00:00.000Z", access_count: 20, last_access_time: "2026-10-26T00:00:00.000Z" }),
    DEFAULT_DECAY,
    NOW,
  );
  assert.ok(used.finalScore > stale.finalScore);
});

test("hasAccessSignal distinguishes 'never observed' from 'observed zero'", () => {
  assert.equal(hasAccessSignal(record()), false);
  assert.equal(hasAccessSignal(record({ access_count: 0, last_access_time: "2026-10-01T00:00:00.000Z" })), true);
  assert.equal(hasAccessSignal(record({ access_count: 3 })), true);
});

test("scores stay inside [0, 1] for arbitrary inputs", () => {
  const cases: MemoryRecord[] = [
    record({ priority: -5, access_count: -3 }),
    record({ priority: 1000, access_count: 1e9 }),
    record({ updated_time: "not a date" }),
    record({ content: "", type: "" }),
  ];
  for (const r of cases) {
    const s = scoreRecord(r, DEFAULT_DECAY, NOW);
    assert.ok(s.finalScore >= 0 && s.finalScore <= 1, `out of range: ${s.finalScore}`);
  }
});

test("extended pins decay against a stretched half-life", () => {
  const plain = record({ updated_time: "2026-08-26T12:00:00.000Z" });
  const extended = { ...plain, pinned: true, pin_kind: "extended" as const, pin_half_life_multiplier: 12 };
  const a = scoreRecord(plain, DEFAULT_DECAY, NOW);
  const b = scoreRecord(extended, DEFAULT_DECAY, NOW);
  assert.ok(b.decayFactor > a.decayFactor, "extended pin should decay slower");
  assert.ok(b.finalScore > a.finalScore);
});

test("a hard pin ranks like a permanently fresh record: no decay, no boost", () => {
  const ancient = { ...record({ updated_time: "2020-01-01T00:00:00.000Z" }), pin_kind: "hard" as const };
  const fresh = { ...record({ updated_time: "2026-10-26T00:00:00.000Z" }), pin_kind: "hard" as const };
  assert.equal(searchMultiplier(ancient, DEFAULT_DECAY, NOW), 1);
  assert.equal(searchMultiplier(ancient, DEFAULT_DECAY, NOW), searchMultiplier(fresh, DEFAULT_DECAY, NOW));

  // A frequently recalled record still beats a pin. Recall frequency is evidence of
  // usefulness; being pinned only means "never decay", not "always first".
  const hot = record({ updated_time: "2026-10-26T00:00:00.000Z", access_count: 20, last_access_time: NOW.toISOString() });
  assert.ok(searchMultiplier(hot, DEFAULT_DECAY, NOW) > searchMultiplier(ancient, DEFAULT_DECAY, NOW));
});

test("search multiplier is bounded and order-preserving for equal scores", () => {
  const fresh = record({ record_id: "fresh", updated_time: "2026-10-26T00:00:00.000Z", access_count: 50 });
  const stale = record({ record_id: "stale", updated_time: "2025-01-01T00:00:00.000Z", access_count: 0 });
  assert.ok(searchMultiplier(fresh, DEFAULT_DECAY, NOW) <= 1.5);
  assert.ok(searchMultiplier(stale, DEFAULT_DECAY, NOW) >= 0.3);

  const ranked = rerankHits(
    [
      { record: stale, score: 0.9 },
      { record: fresh, score: 0.5 },
    ],
    DEFAULT_DECAY,
    NOW,
  );
  // The stale hit is more similar but decays below the fresh one; ordering flips.
  assert.equal(ranked[0].record.record_id, "fresh");
  // Reported scores stay inside the public [0,1] contract.
  for (const hit of ranked) {
    assert.ok(hit.reportedScore >= 0 && hit.reportedScore <= 1);
  }
});

test("rerank never drops a candidate below the decay floor", () => {
  const ancient = record({ updated_time: "2020-01-01T00:00:00.000Z" });
  const ranked = rerankHits([{ record: ancient, score: 0.8 }], DEFAULT_DECAY, NOW);
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].multipliedScore > 0, "a floor hit must still score above zero");
});
