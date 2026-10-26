/**
 * Sensitivity experiments.
 *
 * The headline benchmark answers "does the policy help"; this one answers "under
 * which conditions does it stop helping". Decay is a bet that recency and use
 * correlate with usefulness, and the size of that bet's payoff depends entirely on
 * how the access data was produced and what the query is really asking for.
 *
 * Four conditions, same real snapshot, same embedding-derived ground truth:
 *
 *   cold-start   no access data at all — the state of every tdai deployment today
 *   warm-random  access assigned uniformly at random: the betting premise is false
 *                by construction, because being recalled says nothing about relevance
 *   warm-recall  access produced by running recall episodes and recording what came
 *                back, which is what a real tracker would observe
 *   restated     same corpus, but relevance is "is this the current statement of the
 *                fact" instead of "is this text similar to the query". This is the
 *                case decay is actually designed for: an old conclusion and its
 *                replacement are near-identical in wording, and only recency can
 *                tell them apart.
 *
 * Report every condition, including the ones where decay loses. A policy that only
 * quotes its good case is not a measurement.
 */

import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { loadVectorIndex, embedWithOllama, cosine } from "./vector-index.ts";
import { applyPins } from "../src/pin.ts";
import { DEFAULT_DECAY, decayEnabled, demoteWeight, rerankHits, trackingCoverage, usageFactor } from "../src/scoring.ts";
import { jaccard, shingles } from "../src/redundancy.ts";
import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import type { MemoryRecord } from "../src/types.ts";

const DUPLICATE_THRESHOLD = 0.6;
const RRF_K = 60;

interface Scored {
  record: MemoryRecord;
  score: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readScenes(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT scene_name, COUNT(*) AS c FROM l1_records GROUP BY scene_name HAVING c >= 4 ORDER BY c DESC LIMIT 60")
        .all() as unknown as Array<{ scene_name: string }>
    ).map((r) => r.scene_name);
  } finally {
    db.close();
  }
}

interface Query {
  text: string;
  embedding: Float32Array;
  /** Relevant ids under embedding similarity. */
  truth: Set<string>;
  /** Relevant ids when the question is "which of these restates the fact most recently". */
  restatedTruth: Set<string>;
  candidates: Scored[];
}

function fuse(pool: MemoryRecord[], index: ReturnType<typeof loadVectorIndex>, text: string, embedding: Float32Array, k: number): Scored[] {
  const qs = shingles(text, 2);
  const byId = new Map(pool.map((r) => [r.record_id, r]));
  const lex: Scored[] = pool
    .map((record) => ({ record, score: jaccard(qs, shingles(record.content, 2)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k * 4);
  const vec: Scored[] = index.ids
    .map((id, j) => ({ id, score: cosine(index.vectors, embedding, index.dimension, j * index.dimension, 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k * 4)
    .map((h) => ({ record: byId.get(h.id)!, score: h.score }))
    .filter((h) => !!h.record);

  const fused = new Map<string, Scored>();
  for (const list of [lex, vec]) {
    list.forEach((hit, rank) => {
      const weight = 1 / (RRF_K + rank + 1);
      const existing = fused.get(hit.record.record_id);
      if (existing) existing.score += weight;
      else fused.set(hit.record.record_id, { record: hit.record, score: weight });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/** Access history as a tracker would produce it: recall episodes over the past month. */
function recallDrivenAccess(queries: Query[], episodes: number, rand: () => number) {
  const hits = new Map<string, { count: number; lastAt: string }>();
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  for (let e = 0; e < episodes; e++) {
    const query = queries[Math.floor(rand() * queries.length)];
    const stamp = new Date(now - Math.floor(rand() * 30) * 86_400_000).toISOString();
    for (const hit of query.candidates.slice(0, 5)) {
      const existing = hits.get(hit.record.record_id);
      if (existing) {
        existing.count += 1;
        if (stamp > existing.lastAt) existing.lastAt = stamp;
      } else hits.set(hit.record.record_id, { count: 1, lastAt: stamp });
    }
  }
  return hits;
}

function applyAccess(base: MemoryRecord[], hits: Map<string, { count: number; lastAt: string }>): MemoryRecord[] {
  return base.map((record) => {
    const hit = hits.get(record.record_id);
    return hit
      ? { ...record, access_count: hit.count, last_access_time: hit.lastAt }
      : { ...record, access_count: 0, last_access_time: null };
  });
}

function randomAccess(base: MemoryRecord[], rand: () => number): MemoryRecord[] {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  return base.map((record) => {
    if (rand() > 0.3) return { ...record, access_count: 0, last_access_time: null };
    return {
      ...record,
      access_count: 1 + Math.floor(Math.pow(rand(), 2) * 24),
      last_access_time: new Date(now - Math.floor(rand() * 30) * 86_400_000).toISOString(),
    };
  });
}

const dedupe = (window: Scored[]): Scored[] => {
  const kept: Scored[] = [];
  for (const hit of window) {
    const at = kept.findIndex(
      (x) =>
        x.record.type === hit.record.type &&
        jaccard(shingles(x.record.content), shingles(hit.record.content)) >= DUPLICATE_THRESHOLD,
    );
    if (at === -1) kept.push(hit);
    else if (hit.record.pinned && !kept[at].record.pinned) kept[at] = hit;
  }
  return kept;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: "string" },
      queries: { type: "string", default: "20" },
      k: { type: "string", default: "10" },
      "truth-budget": { type: "string", default: "30" },
      episodes: { type: "string", default: "200" },
    },
  });
  const dbPath = values.db as string;
  if (!dbPath) throw new Error("--db is required");

  const index = loadVectorIndex(dbPath);
  const base = applyPins(loadRecords(dbPath));
  const embedded = new Set(index.ids);
  const pool = base.filter((r) => embedded.has(r.record_id));

  const scenes = readScenes(dbPath);
  const k = Number(values.k);
  const truthBudget = Number(values["truth-budget"]);
  const queryCount = Math.min(Number(values.queries), scenes.length);

  const queries: Query[] = [];
  for (let i = 0; i < queryCount; i++) {
    const text = scenes[i];
    const embedding = await embedWithOllama(text);
    const ranked = index.ids
      .map((id, j) => ({ id, score: cosine(index.vectors, embedding, index.dimension, j * index.dimension, 0) }))
      .sort((a, b) => b.score - a.score);
    const candidates = fuse(pool, index, text, embedding, k);
    queries.push({ text, embedding, truth: new Set(ranked.slice(0, truthBudget).map((h) => h.id)), restatedTruth: new Set(), candidates });
  }

  // "Restated" ground truth: within each query's candidate set, group near-identical
  // records and keep only the newest member as relevant. This models the real
  // question "what is the current state of this fact", where older restatements are
  // stale answers rather than additional evidence.
  for (const query of queries) {
    const groups: Scored[][] = [];
    for (const hit of query.candidates.slice(0, truthBudget)) {
      const group = groups.find((g) =>
        g.some((x) => jaccard(shingles(x.record.content), shingles(hit.record.content)) >= DUPLICATE_THRESHOLD),
      );
      if (group) group.push(hit);
      else groups.push([hit]);
    }
    for (const group of groups) {
      const newest = [...group].sort((a, b) => (b.record.updated_time || "").localeCompare(a.record.updated_time || ""))[0];
      query.restatedTruth.add(newest.record.record_id);
    }
  }

  const recallHits = recallDrivenAccess(queries, Number(values.episodes), mulberry32(20261026));
  const conditions: Array<{ label: string; corpus: MemoryRecord[] }> = [
    { label: "cold-start", corpus: base },
    { label: "warm-random", corpus: randomAccess(base, mulberry32(4242)) },
    { label: "warm-recall", corpus: applyAccess(base, recallHits) },
  ];

  const rows: Array<Record<string, string | number>> = [];

  for (const condition of conditions) {
    const byId = new Map(condition.corpus.map((r) => [r.record_id, r]));
    const coverage = trackingCoverage(condition.corpus);
    const tracked = condition.corpus.filter((r) => (r.access_count ?? 0) > 0).length;
    const conditionPool = condition.corpus.filter((r) => embedded.has(r.record_id));
    const decayOn = decayEnabled(coverage, DEFAULT_DECAY);

    const rerank = (candidates: Scored[], forcedOn?: boolean): Scored[] =>
      rerankHits(candidates, DEFAULT_DECAY, new Date(), { limit: k, decay: forcedOn ?? decayOn }).map((h) => ({
        record: byId.get(h.record.record_id)!,
        score: h.multipliedScore,
      }));

    const configs: Record<string, (candidates: Scored[]) => Scored[]> = {
      baseline: (c) => c.slice(0, k),
      "decay-forced": (c) => rerank(c, true),
      decay: (c) => rerank(c),
      "decay+dedupe": (c) => dedupe(rerank(c)),
    };

    const conditionQueries: Query[] = queries.map((query) => ({
      ...query,
      candidates: fuse(conditionPool, index, query.text, query.embedding, k).map((hit) => ({
        record: byId.get(hit.record.record_id)!,
        score: hit.score,
      })),
    }));

    for (const [label, apply] of Object.entries(configs)) {
      const metrics = conditionQueries.map((query) => {
        const window = apply(query.candidates);
        const hits = window.filter((h) => query.truth.has(h.record.record_id)).length;
        const freshHits = window.filter((h) => query.restatedTruth.has(h.record.record_id)).length;
        return {
          precision: window.length > 0 ? hits / window.length : 0,
          current: window.length > 0 ? freshHits / window.length : 0,
          pins: window.some((h) => h.record.pinned) ? 1 : 0,
          relevantDemotion: mean(
            window.filter((h) => query.truth.has(h.record.record_id)).map((h) => demoteWeight(h.record, DEFAULT_DECAY, new Date(), decayOn)),
          ),
          usage: mean(window.filter((h) => query.truth.has(h.record.record_id)).map((h) => usageFactor(h.record.access_count ?? 0))),
        };
      });
      rows.push({
        condition: condition.label,
        gate: decayOn ? "open" : "closed",
        coverage: (coverage * 100).toFixed(0) + "%",
        tracked,
        configuration: label,
        precision: mean(metrics.map((m) => m.precision)).toFixed(3),
        current: mean(metrics.map((m) => m.current)).toFixed(3),
        pins: mean(metrics.map((m) => m.pins)).toFixed(3),
        demotion: mean(metrics.map((m) => m.relevantDemotion)).toFixed(3),
        usage: mean(metrics.map((m) => m.usage)).toFixed(3),
      });
    }
  }

  process.stdout.write(`\nrecords=${base.length}, embedded=${embedded.size}, queries=${queries.length}, k=${k}, truth budget=${truthBudget}\n`);
  for (const condition of ["cold-start", "warm-random", "warm-recall"]) {
    const subset = rows.filter((r) => r.condition === condition);
    const first = subset[0];
    process.stdout.write(`\n[${condition}] gate=${first.gate}, access coverage=${first.coverage}, tracked=${first.tracked}\n`);
    process.stdout.write("  configuration   precision@k  current@k  pinRecall  demotion  usage\n");
    for (const row of subset) {
      process.stdout.write(
        "  " +
          String(row.configuration).padEnd(16) +
          String(row.precision).padEnd(13) +
          String(row.current).padEnd(11) +
          String(row.pins).padEnd(11) +
          String(row.demotion).padEnd(10) +
          String(row.usage) +
          "\n",
      );
    }
  }
  process.stdout.write("\nprecision@k: share of the window that is embedding-relevant to the query\n");
  process.stdout.write("current@k:   share of the window that is the newest statement of its fact\n");
}

void main();
