/**
 * Recall-evaluation harness.
 *
 * The measurement code lives here, apart from the CLI that drives it, for one
 * reason: `bench/sweep.ts` has to report the same precision, dupShare and
 * pinRecall that `bench/run-bench.ts` reports. Two implementations of "what
 * counts as relevant" drift into two incompatible numbers, and the moment they
 * do, no historical figure is comparable to a new one. This module is the single
 * definition; run-bench.ts and sweep.ts are two drivers over it.
 *
 * Nothing here is parameterised by a policy: a candidate list, a window and a
 * query go in, metrics come out. The policy that produced the window is the
 * caller's business — which is what lets a sweep reuse these metrics across a
 * grid without redefining them per grid point.
 */

import { loadVectorIndex, embedWithOllama, searchVectors } from "./vector-index.ts";
import { DEFAULT_CLUSTER_OPTIONS, jaccard, shingles } from "../src/redundancy.ts";
import type { MemoryRecord } from "../src/types.ts";

export const RRF_K = 60;
/**
 * The similarity at which two records count as the same fact.
 *
 * Deliberately an alias of the shipped clustering threshold rather than a second
 * constant that happens to hold the same number. It was a copy of 0.6 for two sweeps'
 * worth of time, and the only reason nothing disagreed is that the two literals were
 * equal — the moment D4 moved the default to 0.7 the benchmark and the sweep started
 * measuring different collapse points. One definition, imported.
 */
export const DUPLICATE_THRESHOLD = DEFAULT_CLUSTER_OPTIONS.threshold;

export interface QueryCase {
  text: string;
  /** Scene the query is about; a returned record is relevant when its scene matches. */
  scene: string;
}

export type Candidate = { record: MemoryRecord; score: number };

/**
 * Build queries from the corpus itself.
 *
 * Each query is the opening clause of one record — the shape a real recall query
 * takes when the agent asks "what do we know about <the thing the user just said>".
 * Relevance is the record's own scene. Crucially the query is *not* the scene name:
 * using the topic label alone makes lexical matching perfect by construction and
 * hides the noise this benchmark exists to measure.
 */
export function buildQueries(records: MemoryRecord[], count: number, seed = 11): QueryCase[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = r.scene_name || r.type;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const eligible = records.filter((r) => (counts.get(r.scene_name || r.type) ?? 0) >= 5);
  if (eligible.length === 0) return [];

  const queries: QueryCase[] = [];
  // Up to three queries per scene, each derived from a different record in it, so the
  // sample is not one lucky pick per topic.
  const perScene = new Map<string, number>();
  for (let i = 0; queries.length < count && i < eligible.length * 8; i++) {
    const record = eligible[(i * seed) % eligible.length];
    const scene = record.scene_name || record.type;
    if ((perScene.get(scene) ?? 0) >= 3) continue;
    perScene.set(scene, (perScene.get(scene) ?? 0) + 1);
    queries.push({ text: record.content.slice(0, 40), scene });
  }
  return queries;
}

/** Lexical candidates. Stands in for tdai's FTS5 path without needing the extension. */
export function lexical(records: MemoryRecord[], query: string, topK: number): Candidate[] {
  const queryShingles = shingles(query, 2);
  const scored = records.map((record) => ({ record, score: jaccard(queryShingles, shingles(record.content, 2)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function rrf(lists: Candidate[][]): Candidate[] {
  const merged = new Map<string, { record: MemoryRecord; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const score = 1 / (RRF_K + rank + 1);
      const existing = merged.get(hit.record.record_id);
      if (existing) existing.score += score;
      else merged.set(hit.record.record_id, { record: hit.record, score });
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

/**
 * Whether two records say the same fact.
 *
 * The threshold is a parameter rather than a constant because it is one of the six
 * values under calibration: a sweep that could only move the policy but not the
 * duplicate bar would report half the space. `run-bench.ts` passes nothing and gets
 * the shipped 0.6, so its published numbers keep their meaning.
 */
export function isDuplicate(a: MemoryRecord, b: MemoryRecord, threshold: number = DUPLICATE_THRESHOLD): boolean {
  if (a.type !== b.type) return false;
  return jaccard(shingles(a.content), shingles(b.content)) >= threshold;
}

export interface WindowMetrics {
  precision: number;
  top1: number;
  dupShare: number;
  pinRecall: number;
}

export function measureWindow(
  window: Candidate[],
  query: QueryCase,
  duplicateThreshold: number = DUPLICATE_THRESHOLD,
): WindowMetrics {
  if (window.length === 0) return { precision: 0, top1: 0, dupShare: 0, pinRecall: 0 };
  const relevant = window.filter((h) => (h.record.scene_name || h.record.type) === query.scene).length;
  const top1 = (window[0].record.scene_name || window[0].record.type) === query.scene ? 1 : 0;
  let dup = 0;
  for (let i = 1; i < window.length; i++) {
    if (window.slice(0, i).some((earlier) => isDuplicate(earlier.record, window[i].record, duplicateThreshold))) dup++;
  }
  return {
    precision: relevant / window.length,
    top1,
    dupShare: dup / window.length,
    pinRecall: window.some((h) => h.record.pinned) ? 1 : 0,
  };
}

/**
 * Collapse near-duplicates inside a result window, keeping the first of each group.
 *
 * When the incoming hit is pinned and the resident copy is not, the pinned copy
 * takes the slot: dropping it would be a quiet way to lose exactly the memories a
 * pin protects. Shared with `run-bench.ts`'s `forgetting` configuration so that a
 * sweep of `clusterThreshold` moves the same code the benchmark reports.
 */
export function collapseDuplicates(window: Candidate[], threshold: number = DUPLICATE_THRESHOLD): Candidate[] {
  const kept: Candidate[] = [];
  for (const hit of window) {
    const duplicateAt = kept.findIndex((existing) => isDuplicate(existing.record, hit.record, threshold));
    if (duplicateAt === -1) {
      kept.push(hit);
      continue;
    }
    if (hit.record.pinned && !kept[duplicateAt].record.pinned) kept[duplicateAt] = hit;
  }
  return kept;
}

/** Fuse lexical and vector candidates when embeddings are available. */
export async function candidatesFor(
  records: MemoryRecord[],
  vectorIndex: ReturnType<typeof loadVectorIndex> | undefined,
  query: string,
  k: number,
): Promise<Candidate[]> {
  const lex = lexical(records, query, k * 3);
  if (!vectorIndex) return lex;
  try {
    const embedding = await embedWithOllama(query);
    const byId = new Map(records.map((r) => [r.record_id, r]));
    const vec: Candidate[] = searchVectors(vectorIndex, embedding, k * 3)
      .map((hit) => byId.get(hit.id))
      .filter((r): r is MemoryRecord => !!r)
      .map((record, rank) => ({ record, score: 1 - rank / (k * 3) }));
    return rrf([lex, vec]);
  } catch {
    // Provider down: lexical-only numbers are still meaningful and comparable.
    return lex;
  }
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
