import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DECAY_SETTINGS,
  decayOutcome,
  rerankCandidates,
  rerankL1,
  trackingCoverageOf,
  type DecayCandidate,
} from "../src/l1-decay.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function candidate(overrides: Partial<DecayCandidate> = {}): DecayCandidate {
  return {
    id: "c1",
    content: "内容",
    type: "episodic",
    priority: 90,
    score: 0.5,
    created_at: "2026-10-20T12:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
    access_count: 0,
    last_access_time: null,
    ...overrides,
  };
}

test("a six-day-old unused record keeps most of its weight", () => {
  const outcome = decayOutcome(candidate(), { now: NOW });
  // 0.3 + 0.7 * 2^(-6/30) ≈ 0.909: mildly demoted, nowhere near the floor.
  assert.ok(Math.abs(outcome.multiplier - (0.3 + 0.7 * Math.pow(2, -6 / 30))) < 1e-9);
  assert.equal(outcome.reason, "decayed");
});

test("a brand-new record sits at the ceiling of the decay term", () => {
  const outcome = decayOutcome(candidate({ updated_at: NOW.toISOString() }), { now: NOW });
  assert.ok(Math.abs(outcome.multiplier - 1) < 1e-9);
});

test("an old, unused record is demoted to the floor, never below", () => {
  const ancient = decayOutcome(candidate({ updated_at: "2015-01-01T00:00:00.000Z" }), { now: NOW });
  assert.ok(Math.abs(ancient.multiplier - DEFAULT_DECAY_SETTINGS.floor) < 1e-6);
});

test("a frequently recalled record is promoted but capped", () => {
  const hot = decayOutcome(candidate({ access_count: 200, last_access_time: NOW.toISOString() }), { now: NOW });
  assert.ok(hot.multiplier > 1);
  assert.ok(hot.multiplier <= DEFAULT_DECAY_SETTINGS.ceiling);
});

test("a global instruction is exactly neutral, not promoted", () => {
  const pinned = decayOutcome(candidate({ priority: -1, updated_at: "2015-01-01T00:00:00.000Z" }), { now: NOW });
  assert.equal(pinned.multiplier, 1);
  assert.equal(pinned.reason, "pinned");

  // A recently recalled record outranks the pin. Being pinned is "never decay",
  // not "always first".
  const hot = decayOutcome(
    candidate({ access_count: 20, last_access_time: NOW.toISOString(), updated_at: NOW.toISOString() }),
    { now: NOW },
  );
  assert.ok(hot.multiplier > pinned.multiplier);
});

test("an archived record is not treated as pinned", () => {
  const archived = decayOutcome(candidate({ priority: -1, state: "archived" }), { now: NOW });
  assert.notEqual(archived.reason, "pinned");
});

test("coverage counts any access evidence, including a zero count with a timestamp", () => {
  assert.equal(
    trackingCoverageOf([
      candidate({ access_count: 3 }),
      candidate({ access_count: 0, last_access_time: NOW.toISOString() }),
      candidate(),
    ]),
    2 / 3,
  );
  assert.equal(trackingCoverageOf([]), 0);
});

test("a cold candidate set turns the age term off for every record", () => {
  const results = rerankCandidates(
    [
      candidate({ id: "old", score: 0.9, updated_at: "2015-01-01T00:00:00.000Z" }),
      candidate({ id: "new", score: 0.8, updated_at: NOW.toISOString() }),
    ],
    { now: NOW },
  );
  assert.equal(results[0].candidate.id, "old", "relevance order preserved when age is not evidence");
  assert.equal(results.every((r) => r.outcome.reason === "decay-off"), true);
});

test("a warm candidate set lets the age term reorder results", () => {
  const results = rerankCandidates(
    [
      candidate({ id: "old", score: 0.9, updated_at: "2015-01-01T00:00:00.000Z", access_count: 0, last_access_time: "2015-01-01T00:00:00.000Z" }),
      candidate({ id: "new", score: 0.8, updated_at: NOW.toISOString(), access_count: 2, last_access_time: NOW.toISOString() }),
    ],
    { now: NOW },
  );
  assert.equal(results[0].candidate.id, "new");
});

test("reported scores stay inside the [0,1] API contract", () => {
  const results = rerankCandidates(
    [
      candidate({ id: "a", score: 0.99, access_count: 50, last_access_time: NOW.toISOString() }),
      candidate({ id: "b", score: 0, updated_at: "2014-01-01T00:00:00.000Z" }),
    ],
    { now: NOW, minTrackingCoverage: 0 },
  );
  for (const r of results) {
    assert.ok(r.outcome.reportedScore >= 0 && r.outcome.reportedScore <= 1);
  }
});

test("rerankL1 preserves the input shape and logs the gate decision", async () => {
  const messages: string[] = [];
  const out = await rerankL1(
    [candidate({ id: "a", score: 0.6, updated_at: NOW.toISOString() })],
    { now: NOW },
    { debug: (m) => messages.push(m) },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "a");
  assert.equal(out[0].content, "内容");
  assert.match(messages.join("\n"), /cold start/);
});

test("rerankL1 is a no-op on an empty result set", async () => {
  assert.deepEqual(await rerankL1([], { now: NOW }), []);
});

test("half-life is configurable and halves at the stated age", () => {
  const atHalfLife = decayOutcome(candidate({ updated_at: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() }), {
    now: NOW,
    halfLifeDays: 10,
    floor: 0.3,
    minTrackingCoverage: 0,
  });
  const expected = 0.3 + 0.7 * 0.5;
  assert.ok(Math.abs(atHalfLife.multiplier - expected) < 1e-9);
});
