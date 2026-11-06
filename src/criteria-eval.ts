/**
 * Review-set sampling and false-supersede measurement.
 *
 * Both halves have to be reproducible by someone who was not here. The sampler is a
 * deterministic function of the database contents plus a seed — no "pick the ones that
 * look interesting" — and the measurement reads its inputs from files on disk rather
 * than from memory, so the number in the report can be recomputed from the artefacts.
 *
 * The metric that matters is the false-supersede rate: of the pairs the judge called
 * `supersede`, how many did a human say were not. Not accuracy. A judge that answers
 * `keep-both` to everything scores well on accuracy and is useless; a judge that is
 * right about everything except the one case that silently deletes a memory is
 * dangerous, and only this ratio sees that.
 */

import { DatabaseSync } from "node:sqlite";
import { jaccard, shingles } from "./redundancy.ts";
import type { CandidatePair, ReviewSet, SupersedeVerdict } from "./llm-criteria.ts";

export interface SampleOptions {
  /** Target number of pairs. The sampler stops early rather than padding with weak pairs. */
  size: number;
  /** Only consider pairs whose similarity falls in this band. */
  minSimilarity?: number;
  maxSimilarity?: number;
  /** Deterministic ordering seed. Same seed + same database = same set. */
  seed?: number;
  now?: Date;
}

interface Row {
  record_id: string;
  content: string;
  type: string;
  created_time: string;
  scene_name: string;
}

/**
 * Draw candidate pairs.
 *
 * Rule, in order:
 *   1. Sort records by (scene_name, created_time, record_id) — a total order, so the
 *      result does not depend on sqlite's row order.
 *   2. Within each scene, take every ADJACENT pair in time. Adjacency is the whole
 *      point: a supersede candidate is a later record about the same subject, and
 *      pairing across the whole scene would mostly produce unrelated records.
 *   3. Keep pairs whose content similarity is within the band [0.10, 0.90]. The lower
 *      bound drops "same scene, different topic"; the upper bound drops near-identical
 *      copies, which are dedup's business, not supersession's. The band is wide because
 *      this corpus is thin on supersede-shaped pairs (measured: 479 adjacent pairs,
 *      median similarity 0.049, only 63 in band) — narrowing it would leave the review
 *      set short of its target, and padding with clearly-unrelated pairs would flatter
 *      the judge's precision.
 *   4. Sort again by a seeded hash of the pair ids and take the first N.
 *
 * Step 4 exists so the sample is not just "the first N scenes in the database", which
 * would correlate the review set with whatever happens to sort first.
 */
export function samplePairs(dbPath: string, opts: SampleOptions): CandidatePair[] {
  const { size, minSimilarity = 0.1, maxSimilarity = 0.9, seed = 20261026 } = opts;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: Row[];
  try {
    rows = db
      .prepare(
        "SELECT record_id, content, type, created_time, scene_name FROM l1_records ORDER BY scene_name, created_time, record_id",
      )
      .all() as unknown as Row[];
  } finally {
    db.close();
  }

  const byScene = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byScene.get(r.scene_name) ?? [];
    list.push(r);
    byScene.set(r.scene_name, list);
  }

  const scored: Array<{ pair: CandidatePair; rank: string }> = [];
  for (const [, list] of [...byScene.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    for (let i = 1; i < list.length; i++) {
      const older = list[i - 1];
      const newer = list[i];
      if (older.record_id === newer.record_id) continue;
      const sim = jaccard(shingles(older.content, 3), shingles(newer.content, 3));
      if (sim < minSimilarity || sim > maxSimilarity) continue;
      const pair: CandidatePair = { pairId: `${older.record_id}__${newer.record_id}`, oldId: older.record_id, newId: newer.record_id };
      scored.push({ pair, rank: seededRank(pair.pairId, seed) });
    }
  }

  scored.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  return scored.slice(0, size).map((s) => s.pair);
}

/** FNV-1a over the id plus the seed. Cheap, deterministic, and not order-dependent. */
function seededRank(id: string, seed: number): string {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface ConfusionMatrix {
  /** judge \ human, over the labelled pairs only. */
  counts: Record<string, number>;
  labelled: number;
  /** Of the pairs the judge called supersede, the share a human disagreed with. */
  falseSupersedeRate: number | null;
  /** Judge supersede calls that a human also called supersede. */
  trueSupersede: number;
  falseSupersede: number;
  missedSupersede: number;
  /** Per-verdict precision, for the report. */
  precision: Record<string, number | null>;
}

/**
 * Compare judge verdicts against human labels.
 *
 * Returns `null` for every ratio when there is nothing to divide by, rather than 0 —
 * "no data" and "perfect" must not be the same number, because one of them opens the
 * apply gate.
 */
export function evaluate(
  pairs: CandidatePair[],
  judged: Map<string, SupersedeVerdict | null>,
): ConfusionMatrix {
  const counts: Record<string, number> = {};
  let trueSupersede = 0;
  let falseSupersede = 0;
  let missedSupersede = 0;
  let labelled = 0;

  const perVerdict = new Map<SupersedeVerdict, { called: number; right: number }>();

  for (const pair of pairs) {
    const human = pair.humanVerdict;
    const machine = judged.get(pair.pairId) ?? null;
    if (human === undefined || human === null) continue;
    labelled++;

    const key = `${machine ?? "no-verdict"}|${human}`;
    counts[key] = (counts[key] ?? 0) + 1;

    if (machine !== null) {
      const slot = perVerdict.get(machine) ?? { called: 0, right: 0 };
      slot.called++;
      if (machine === human) slot.right++;
      perVerdict.set(machine, slot);
    }

    if (machine === "supersede" && human === "supersede") trueSupersede++;
    if (machine === "supersede" && human !== "supersede") falseSupersede++;
    if (machine !== "supersede" && human === "supersede") missedSupersede++;
  }

  const supersedeCalls = trueSupersede + falseSupersede;
  const precision: Record<string, number | null> = {};
  for (const [verdict, slot] of perVerdict) {
    precision[verdict] = slot.called > 0 ? slot.right / slot.called : null;
  }

  return {
    counts,
    labelled,
    falseSupersedeRate: supersedeCalls > 0 ? falseSupersede / supersedeCalls : null,
    trueSupersede,
    falseSupersede,
    missedSupersede,
    precision,
  };
}

/** Render the confusion matrix and the rate that decides the gate. */
export function renderEvaluation(m: ConfusionMatrix, set: ReviewSet, judged: Map<string, SupersedeVerdict | null>, modelId: string): string {
  const lines: string[] = [];
  lines.push(`review set      ${set.version}  (${set.pairs.length} pairs, ${m.labelled} labelled)`);
  lines.push(`sampling        ${set.sampling}`);
  lines.push(`model           ${modelId}`);
  lines.push("");
  lines.push("confusion matrix (judge | human):");
  const keys = Object.keys(m.counts).sort();
  for (const k of keys) lines.push(`  ${k.padEnd(28)} ${m.counts[k]}`);
  lines.push("");
  lines.push(`true supersede   ${m.trueSupersede}`);
  lines.push(`false supersede  ${m.falseSupersede}`);
  lines.push(`missed supersede ${m.missedSupersede}`);
  lines.push("");
  lines.push(
    `false-supersede rate  ${m.falseSupersedeRate === null ? "n/a (judge made no supersede calls)" : (m.falseSupersedeRate * 100).toFixed(1) + "%"}`,
  );
  lines.push("  = false supersede / (false + true supersede)");
  lines.push("  the gate uses this number and no other");
  lines.push("");
  lines.push("precision per verdict:");
  for (const [v, p] of Object.entries(m.precision).sort()) {
    lines.push(`  ${v.padEnd(12)} ${p === null ? "n/a" : (p * 100).toFixed(1) + "%"}`);
  }
  lines.push("");
  lines.push(`pairs with no verdict: ${[...judged.values()].filter((v) => v === null).length}`);
  return lines.join("\n") + "\n";
}
