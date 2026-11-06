/**
 * Tests for the long-text corpus and the corpus description.
 *
 * The corpus has one job that must not silently rot: a fact group's brief and full
 * statements are the same fact, and they must sit below the shipped duplicate
 * threshold. That gap is the measurement D5 exists to decide about, so it is
 * asserted here rather than assumed. If someone later changes the sentence pools in
 * a way that makes the brief and full text too similar, this test goes red — which is
 * the correct outcome, because then the corpus would no longer contain the defect it
 * is supposed to carry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { longtextCorpus } from "../bench/corpus-long.ts";
import { describeCorpus, formatStats } from "../bench/corpus-stats.ts";
import { DEFAULT_CLUSTER_OPTIONS, findRedundancyClusters, jaccard, shingles } from "../src/redundancy.ts";
import { applyPins } from "../src/pin.ts";
import type { MemoryRecord } from "../src/types.ts";

function record(id: string, content: string, type = "episodic"): MemoryRecord {
  return {
    record_id: id,
    content,
    type,
    priority: 60,
    scene_name: "scene",
    team_id: "bench",
    user_id: "bench",
    agent_id: "bench",
    created_time: "2026-10-26T00:00:00.000Z",
    updated_time: "2026-10-26T00:00:00.000Z",
    access_count: 0,
    last_access_time: null,
    state: "active",
    metadata_json: "{}",
  };
}

test("the long-text corpus produces one brief and one full record per fact", () => {
  const records = longtextCorpus({ facts: 8 });
  assert.equal(records.length, 16);
  assert.deepEqual(
    records.slice(0, 2).map((r) => r.record_id),
    ["long_0_brief", "long_0_full"],
  );
});

test("records stay inside the 500–1500 character band", () => {
  const records = longtextCorpus({ facts: 12 });
  for (const r of records) {
    assert.ok(r.content.length >= 500, `${r.record_id} is ${r.content.length} chars, below the 500 floor`);
    assert.ok(r.content.length <= 1500, `${r.record_id} is ${r.content.length} chars, above the 1500 ceiling`);
  }
});

test("the full statement begins with the brief statement, so they are one fact", () => {
  const records = longtextCorpus({ facts: 6 });
  for (let g = 0; g < 6; g++) {
    const brief = records.find((r) => r.record_id === `long_${g}_brief`);
    const full = records.find((r) => r.record_id === `long_${g}_full`);
    assert.ok(brief && full);
    assert.ok(full.content.startsWith(brief.content), `fact ${g}: the full text must extend the brief one`);
    assert.ok(full.content.length > brief.content.length, `fact ${g}: the full text must be longer`);
  }
});

test("a fact's two versions are measurably the same text", () => {
  const records = longtextCorpus(); // the default corpus, the one the report measures
  for (let g = 0; g < 60; g++) {
    const brief = records.find((r) => r.record_id === `long_${g}_brief`)!;
    const full = records.find((r) => r.record_id === `long_${g}_full`)!;
    const similarity = jaccard(shingles(brief.content), shingles(full.content));
    // Deliberately NOT asserted below the 0.6 threshold. The ratio sits around
    // briefLength/fullLength (~0.45) plus whatever clauses the two documents happen to
    // share, and on the default corpus a few groups reach 0.63 — above the bar. What
    // actually keeps them apart in findRedundancyClusters is the length prefilter
    // (0.43 < 0.6 rejects the pair before Jaccard is computed), and that is the fact
    // the report states. Asserting "below 0.6" here would be recording a coincidence.
    assert.ok(similarity > 0.4, `fact ${g}: ${similarity.toFixed(3)} is too low to read as the same fact`);
    assert.ok(similarity < 0.75, `fact ${g}: ${similarity.toFixed(3)} is suspiciously close to a verbatim copy`);
  }
});

test("the default detector finds none of the 60 fact groups", () => {
  const records = applyPins(longtextCorpus());
  const clusters = findRedundancyClusters(records, DEFAULT_CLUSTER_OPTIONS);
  assert.equal(clusters.length, 0, "60 fact groups are true duplicates, yet the shipped detector pairs none of them");
});

test("unrelated fact groups stay under the duplicate threshold", () => {
  const records = longtextCorpus({ facts: 20 });
  const briefs = records.filter((r) => r.record_id.endsWith("_brief"));
  const worst = { pair: "", similarity: 0 };
  for (let i = 0; i < briefs.length; i++) {
    for (let j = i + 1; j < briefs.length; j++) {
      const similarity = jaccard(shingles(briefs[i].content), shingles(briefs[j].content));
      if (similarity > worst.similarity) {
        worst.pair = `${briefs[i].record_id} / ${briefs[j].record_id}`;
        worst.similarity = similarity;
      }
    }
  }
  // The bar is the shipped threshold, because crossing it would create a fake duplicate
  // group and the duplicate count would stop measuring the detector. It is not "near
  // zero": all sentences are drawn from the same clause pools, so unrelated briefs do
  // share wording. Measured on the default corpus the worst pair sits around 0.42,
  // which is uncomfortably close to a same-fact pair's ~0.47 — that narrow band is a
  // finding for the report, not a reason to loosen this assertion.
  assert.ok(worst.similarity < DEFAULT_CLUSTER_OPTIONS.threshold, `${worst.pair} at ${worst.similarity.toFixed(3)} would be a false duplicate`);
});

test("describeCorpus reports the statistics the calibration needs", () => {
  const records = applyPins([
    record("a", "x".repeat(100)),
    record("b", "x".repeat(100)),
    record("c", "y".repeat(300), "instruction"),
    record("d", "z".repeat(200), "instruction"),
  ]);
  const stats = describeCorpus(records, "fixture");

  assert.equal(stats.records, 4);
  assert.equal(stats.length.min, 100);
  assert.equal(stats.length.max, 300);
  assert.equal(stats.length.p50, 100);
  // a and b are identical, so exactly one group of two.
  assert.equal(stats.duplicates.groups, 1);
  assert.equal(stats.duplicates.recordsInGroups, 2);
  assert.equal(stats.duplicates.threshold, DEFAULT_CLUSTER_OPTIONS.threshold);
  assert.deepEqual(
    stats.types.map((t) => t.type),
    ["episodic", "instruction"],
  );

  const lines = formatStats(stats);
  assert.match(lines[0], /corpus fixture: 4 records/);
  assert.match(lines.join("\n"), new RegExp(`duplicate groups at ${DEFAULT_CLUSTER_OPTIONS.threshold}: 1`));
});
