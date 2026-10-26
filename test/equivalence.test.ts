import { test } from "node:test";
import assert from "node:assert/strict";

import { decayOutcome, rerankCandidates, trackingCoverageOf, type DecayCandidate } from "../src/l1-decay.ts";
import { DEFAULT_DECAY, rerankHits, searchMultiplier, trackingCoverage } from "../src/scoring.ts";
import { makeRecord } from "./fixtures.ts";

/**
 * The shipped patch calls `src/l1-decay.ts`; the engine in this repo uses
 * `src/scoring.ts`. They were written twice on purpose (one for upstream's shape,
 * one for the planner's) and that duplication is only safe while the numbers agree.
 *
 * These tests are the guard: if the two implementations drift, one of them is
 * silently shipping a different policy than the benchmark measured.
 */

const NOW = new Date("2026-10-26T12:00:00.000Z");
const MIN_COVERAGE = 0; // hold the gate open so the formulas are compared directly

function pair(overrides: { ageDays?: number; accessCount?: number; priority?: number }) {
  const ageDays = overrides.ageDays ?? 0;
  const stamp = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
  const record = makeRecord({
    record_id: "x",
    priority: overrides.priority ?? 90,
    updated_time: stamp,
    created_time: stamp,
    access_count: overrides.accessCount ?? 0,
    last_access_time: (overrides.accessCount ?? 0) > 0 ? stamp : null,
  });
  const candidate: DecayCandidate = {
    id: "x",
    content: record.content,
    type: record.type,
    priority: record.priority,
    score: 0.5,
    created_at: stamp,
    updated_at: stamp,
    access_count: overrides.accessCount ?? 0,
    last_access_time: record.last_access_time,
  };
  return { record, candidate };
}

test("both implementations agree on the multiplier across the input grid", () => {
  for (const ageDays of [0, 1, 7, 30, 90, 365, 3650]) {
    for (const accessCount of [0, 1, 3, 8, 20, 100]) {
      const { record, candidate } = pair({ ageDays, accessCount });
      const engine = searchMultiplier(record, { ...DEFAULT_DECAY, minTrackingCoverage: MIN_COVERAGE }, NOW, true);
      const patch = decayOutcome(candidate, { now: NOW, minTrackingCoverage: MIN_COVERAGE }, true).multiplier;
      assert.ok(
        Math.abs(engine - patch) < 1e-9,
        `drift at age=${ageDays}d access=${accessCount}: engine=${engine}, patch=${patch}`,
      );
    }
  }
});

test("both implementations agree that a pinned record is neutral", () => {
  for (const ageDays of [0, 30, 3650]) {
    const { record, candidate } = pair({ ageDays, priority: -1 });
    assert.equal(searchMultiplier(record, DEFAULT_DECAY, NOW), 1);
    assert.equal(decayOutcome(candidate, { now: NOW }).multiplier, 1);
  }
});

test("both implementations agree on the coverage gate", () => {
  for (const tracked of [0, 1, 5, 10]) {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ record_id: `r${i}`, access_count: i < tracked ? 1 : 0, last_access_time: i < tracked ? NOW.toISOString() : null }),
    );
    const candidates: DecayCandidate[] = records.map((r) => ({
      id: r.record_id,
      content: r.content,
      type: r.type,
      priority: r.priority,
      score: 0.5,
      created_at: r.created_time,
      updated_at: r.updated_time,
      access_count: r.access_count,
      last_access_time: r.last_access_time,
    }));
    assert.equal(trackingCoverage(records), trackingCoverageOf(candidates));
  }
});

test("both implementations agree on ordering after a re-rank", () => {
  const inputs = [
    { ageDays: 200, accessCount: 0, score: 0.9 },
    { ageDays: 2, accessCount: 1, score: 0.6 },
    { ageDays: 60, accessCount: 12, score: 0.5 },
    { ageDays: 400, accessCount: 0, score: 0.95 },
  ];

  const records = inputs.map((input, i) => {
    const { record } = pair({ ageDays: input.ageDays, accessCount: input.accessCount });
    return { record: { ...record, record_id: `r${i}` }, score: input.score };
  });
  const engineOrder = rerankHits(records, { ...DEFAULT_DECAY, minTrackingCoverage: MIN_COVERAGE }, NOW, {
    decay: true,
  }).map((h) => h.record.record_id);

  const candidates: Array<DecayCandidate & { id: string }> = records.map(({ record, score }, i) => ({
    id: `r${i}`,
    content: record.content,
    type: record.type,
    priority: record.priority,
    score,
    created_at: record.created_time,
    updated_at: record.updated_time,
    access_count: record.access_count,
    last_access_time: record.last_access_time,
  }));
  const patchOrder = rerankCandidates(candidates, { now: NOW, minTrackingCoverage: MIN_COVERAGE }).map((r) => r.candidate.id);

  assert.deepEqual(engineOrder, patchOrder);
});
