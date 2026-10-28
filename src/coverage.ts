/**
 * The "where is the access-tracking coverage heading" question, as one call.
 *
 * The decay gate is `trackingCoverage >= 0.10` and that number is a guess: nobody
 * has measured how many days of real traffic a deployment needs to reach it, or
 * what happens to retrieval quality once it does. B5 cannot wait for those days,
 * so it answers the question that CAN be answered now — what would change the
 * moment the gate opens — and leaves an operator something to read while the
 * corpus warms up.
 *
 * Two facts the output is built on, both measured elsewhere in this repo:
 *
 *   1. Coverage is "records carrying an access signal / records", not "accesses /
 *      records". One search that returns ten records moves coverage by ten records,
 *      so the climb is fast at the start and slow at the end.
 *   2. The cold-start rows in bench/experiments.ts (docs/experiments/实测报告) were
 *      measured at 0% and 8% coverage — both below the gate. The transition band,
 *      where the gate actually opens, was never observed. Folding a synthetic log in
 *      steps and re-reading at each step is the cheap way to see it.
 *
 * What this intentionally does NOT do: measure retrieval quality. "The ranking
 * moved" is not "the ranking improved", and the report says so rather than leaving
 * the reader to infer it.
 *
 * One reading caveat, measured rather than assumed. `reordered` is not a property of
 * "is decay on" — it is a property of how strongly the fusion order disagrees with the
 * age order. Fusion scores span 1/(RRF_K+1) .. 1/(RRF_K+N), i.e. about 1.6x across a
 * 45-candidate pool, while the multiplier only spans [0.3, 1.5]; when fusion ranks the
 * oldest records first the two effects nearly cancel and the position count stays low
 * even with the gate open. That is a legitimate reading, not a defect: it says the age
 * term is losing the argument with relevance on this corpus.
 *
 * The corollary matters for anyone extending this: with a SINGLE channel the pool ties
 * on RRF score and that 1.6x spread decides every comparison, so the probe reads near
 * zero on a corpus where decay would definitely move things. `channels` is printed for
 * exactly this reason — a zero there is the first thing to check before trusting a low
 * `reordered`.
 */

import { DatabaseSync } from "node:sqlite";
import { loadRecords } from "./adapters/tdai-sqlite.ts";
import { DEFAULT_DECAY, decayEnabled, rerankHits, trackingCoverage, type RerankOptions } from "./scoring.ts";
import type { DecayConfig, MemoryRecord } from "./types.ts";

/**
 * The fixed probe query.
 *
 * It has to be one string for every deployment, or two `coverage` runs cannot be
 * compared — which would defeat the point of a watch command. "记忆" is the token
 * tdai's own L1 rows repeat most often, so the probe produces a real candidate pool
 * on a real corpus rather than an empty one that would report "0 reordered" for the
 * wrong reason.
 */
export const COVERAGE_QUERY = "记忆";

/** Fusion damping, the constant upstream's l1-candidate-recall uses. */
const RRF_K = 60;

/** Candidate pool size, mirroring `candidateK = limit * 3` in executeMemorySearch. */
const CANDIDATE_K = 45;
/** The pool handed to the reranker before the top-N trim, as upstream does. */
const RERANK_LIMIT = 15;
/** The window the reordering is measured on. Same number as the log's maxRankCounted. */
export const RETURN_N = 10;

export interface CoverageSlice {
  /** Log lines folded so far. One line == one search that returned at least one hit. */
  folds: number;
  records: number;
  withAccess: number;
  coverage: number;
  decayActive: boolean;
  /** Top-N positions that changed, comparing pure fusion against the decayed order. */
  reordered: number;
}

export interface CoverageReport {
  dbPath: string;
  records: number;
  withAccess: number;
  coverage: number;
  decayActive: boolean;
  threshold: number;
  reordered: number;
  /** True when the probe found nothing to rank, so `reordered` is trivially 0. */
  emptyRanking: boolean;
  query: string;
  window: number;
  /** Hits per channel: lexical / FTS5 / vector. A zero channel is a diagnosis, not noise. */
  channels: { lexical: number; fts: number; vector: number };
  /** Distinct records the probe ranked before the top-N trim. */
  candidates: number;
  /** Only present when folds were replayed. */
  climb?: CoverageSlice[];
  /** Why the climb is absent, when it is. */
  climbSkipped?: string;
}

/**
 * An offline stand-in for the retrieval chain, built from the same sources the
 * benchmark uses: an in-memory inverted index over the records themselves, the real
 * `l1_fts` FTS5 table, and the real `l1_vec` payload.
 *
 * It is not upstream's retriever and this module never pretends it is — the
 * absolute ordering is not comparable to production. What IS comparable is the
 * CHANGE in ordering between two readings at different coverage: the chain is a
 * pure function of (corpus, query), so a difference can only come from the counters
 * the fold moved. That is the quantity a watch command has to report.
 *
 * Embeddings are optional on purpose. `l1_vec` can only be read through the vec0
 * shadow tables (see bench/vector-index.ts), and making the CLI depend on an
 * embedding provider would break it on exactly the deployments that need it most.
 */
class ProbeIndex {
  readonly records: MemoryRecord[];
  readonly byId: Map<string, MemoryRecord>;
  private readonly db: DatabaseSync;
  private readonly inverted: Map<string, Set<string>>;
  private readonly vectorTable: string | null;
  private vectors: { ids: string[]; vectors: Float32Array; dimension: number } | null = null;

  constructor(dbPath: string, vectorTable?: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.records = loadRecords(dbPath, {});
    this.byId = new Map(this.records.map((r) => [r.record_id, r]));
    this.inverted = new Map();
    for (const r of this.records) {
      const body = (r.content ?? "") + " " + (r.scene_name ?? "") + " " + (r.type ?? "");
      for (const tok of tokenize(body)) {
        let bucket = this.inverted.get(tok);
        if (!bucket) this.inverted.set(tok, (bucket = new Set()));
        bucket.add(r.record_id);
      }
    }
    this.vectorTable = vectorTable ?? null;
  }

  /** Loaded once, lazily: a missing or unfamiliar vec0 layout degrades, it does not throw. */
  private vectorIndex(): { ids: string[]; vectors: Float32Array; dimension: number } | null {
    if (this.vectors) return this.vectors;
    if (!this.vectorTable) return null;
    try {
      this.vectors = loadVectorShadow(this.db, this.vectorTable);
    } catch {
      // Two channels still fuse into a real candidate pool, so this is a degraded
      // reading, not an error. The vector hit count in the report shows it.
      this.vectors = null;
    }
    return this.vectors;
  }

  /** Distinct record ids per channel, each ranked best-first. */
  channels(): { lexical: string[]; fts: string[]; vector: string[] } {
    const tokens = tokenize(COVERAGE_QUERY);
    const scores = new Map<string, number>();
    for (const t of tokens) {
      const bucket = this.inverted.get(t);
      if (!bucket) continue;
      for (const id of bucket) scores.set(id, (scores.get(id) ?? 0) + 1);
    }
    const lexical = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_K).map(([id]) => id);

    let fts: string[] = [];
    try {
      const rows = this.db
        .prepare("SELECT record_id FROM l1_fts WHERE l1_fts MATCH ? ORDER BY bm25(l1_fts, 1.0, 0.5) LIMIT ?")
        .all('"' + COVERAGE_QUERY.replace(/"/g, '""') + '"', CANDIDATE_K) as unknown as Array<{ record_id: string }>;
      fts = rows.map((r) => r.record_id);
    } catch {
      // An FTS parser rejection is not a failed probe; the other channels still rank.
      fts = [];
    }

    const vec = this.vectorIndex();
    let vector: string[] = [];
    if (vec) {
      // No query embedding without a provider, so this channel is ordered by vector
      // magnitude. Deterministic and corpus-derived, which is all a before/after
      // comparison needs from a channel.
      const scored: Array<{ id: string; score: number }> = vec.ids.map((id, i) => ({
        id,
        score: norm(vec.vectors, vec.dimension, i * vec.dimension),
      }));
      scored.sort((a, b) => b.score - a.score);
      vector = scored.slice(0, CANDIDATE_K).map((h) => h.id);
    }

    return { lexical, fts, vector };
  }

  close(): void {
    this.db.close();
  }
}

/** Reciprocal rank fusion; a channel that found nothing contributes nothing. */
function fuse(channels: string[][]): Array<{ id: string; score: number }> {
  const acc = new Map<string, number>();
  for (const ids of channels) {
    ids.forEach((id, rank) => acc.set(id, (acc.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_K);
}

/**
 * Positions that differ between the fusion order and the decayed order.
 *
 * Compared as positions, not as a set: a record that moved from 4 to 7 is a change,
 * and a set comparison would report 0 for it while the list the user sees came back
 * in a different order.
 */
function countReordered(fusion: string[], decayed: string[]): number {
  const n = Math.min(fusion.length, decayed.length);
  let moved = 0;
  for (let i = 0; i < n; i++) if (fusion[i] !== decayed[i]) moved++;
  return moved;
}

/**
 * Rank the probe twice — pure RRF against the decayed order.
 *
 * `decay: true` is forced on both sides of the gate on purpose. The number answers
 * "how many of the top ten would move if the age term came back", which is the only
 * question an operator can act on during cold start; passing `decayActive` instead
 * would make the command print 0 for every cold database, which is the reading the
 * playbook calls out as misleading.
 */
function rankOnce(
  byId: Map<string, MemoryRecord>,
  channels: string[][],
  cfg: DecayConfig,
  now: Date,
): { fusion: string[]; decayed: string[]; candidates: number } {
  const fused = fuse(channels);
  const scored = fused
    .map((c) => ({ record: byId.get(c.id), score: c.score }))
    .filter((h): h is { record: MemoryRecord; score: number } => h.record !== undefined);

  const ordered = (opts: RerankOptions): string[] =>
    rerankHits(scored, cfg, now, opts)
      .slice(0, RETURN_N)
      .map((h) => h.record.record_id);

  return {
    fusion: ordered({ limit: RERANK_LIMIT, decay: false }),
    decayed: ordered({ limit: RERANK_LIMIT, decay: true }),
    candidates: scored.length,
  };
}

/** Open the corpus, rank the probe twice, close. Read-only. */
export function probeRanking(
  dbPath: string,
  cfg: DecayConfig = DEFAULT_DECAY,
  now: Date = new Date(),
  vectorTable?: string,
): { fusion: string[]; decayed: string[]; candidates: number; channels: { lexical: number; fts: number; vector: number } } {
  const index = new ProbeIndex(dbPath, vectorTable);
  try {
    const ch = index.channels();
    const ranked = rankOnce(index.byId, [ch.lexical, ch.fts, ch.vector], cfg, now);
    return {
      ...ranked,
      channels: { lexical: ch.lexical.length, fts: ch.fts.length, vector: ch.vector.length },
    };
  } finally {
    index.close();
  }
}

/** Measure the database as it stands: coverage, gate state, and how much decay would move. */
export function coverageReport(
  dbPath: string,
  cfg: DecayConfig = DEFAULT_DECAY,
  now: Date = new Date(),
  vectorTable?: string,
): CoverageReport {
  const index = new ProbeIndex(dbPath, vectorTable);
  try {
    const records = index.records;
    const covered = records.filter(hasAccess).length;
    const coverage = trackingCoverage(records);
    const ch = index.channels();
    const ranked = rankOnce(index.byId, [ch.lexical, ch.fts, ch.vector], cfg, now);
    return {
      dbPath,
      records: records.length,
      withAccess: covered,
      coverage,
      decayActive: decayEnabled(coverage, cfg),
      threshold: cfg.minTrackingCoverage,
      reordered: countReordered(ranked.fusion, ranked.decayed),
      emptyRanking: ranked.candidates === 0,
      query: COVERAGE_QUERY,
      window: RETURN_N,
      channels: { lexical: ch.lexical.length, fts: ch.fts.length, vector: ch.vector.length },
      candidates: ranked.candidates,
    };
  } finally {
    index.close();
  }
}

/**
 * Walk the coverage band once, re-reading the corpus after each step.
 *
 * The gate flip is a property of the COUNTERS, and the point of walking rather than
 * sampling is that the threshold a corpus crosses is a function of its size and of
 * which records were already touched: at 822 records a corpus reaches 10% after ~83
 * distinct records are hit, which is a place in the middle of the sequence, not a
 * fixed line number.
 *
 * `step` performs one real fold (or whatever moves the counters) and returns false
 * to stop early. `maxFolds` bounds the replay; the caller owns how the counters move
 * because a synthetic replay and a real log archive are different on purpose.
 */
export function coverageClimb(
  dbPath: string,
  step: (foldIndex: number) => boolean,
  cfg: DecayConfig = DEFAULT_DECAY,
  now: Date = new Date(),
  maxFolds = 200,
): CoverageSlice[] {
  const slices: CoverageSlice[] = [];
  for (let folds = 0; folds < maxFolds; folds++) {
    const report = coverageReport(dbPath, cfg, now);
    slices.push({
      folds,
      records: report.records,
      withAccess: report.withAccess,
      coverage: report.coverage,
      decayActive: report.decayActive,
      reordered: report.reordered,
    });
    if (report.coverage >= 1) break;
    if (!step(folds)) break;
  }
  return slices;
}

// ------------------------------ plumbing ------------------------------

function hasAccess(record: MemoryRecord): boolean {
  if ((record.access_count ?? 0) > 0) return true;
  return !!record.last_access_time;
}

/** CJK bigrams plus ASCII words: the tokenizer bench/latency.ts uses. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[A-Za-z0-9_.+-]{2,}/g) ?? []) out.push(run.toLowerCase());
  const runs = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of runs) for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  return Array.from(new Set(out)).slice(0, 60);
}

/** L2 norm. Stands in for cosine when there is no query embedding to compare against. */
function norm(vectors: Float32Array, dimension: number, offset: number): number {
  let acc = 0;
  for (let i = 0; i < dimension; i++) acc += vectors[offset + i] * vectors[offset + i];
  return Math.sqrt(acc);
}

/** Rebuild a plain vector view from vec0's shadow tables. See bench/vector-index.ts. */
function loadVectorShadow(
  db: DatabaseSync,
  table: string,
): { ids: string[]; vectors: Float32Array; dimension: number } {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql?: string } | undefined;
  const dimMatch = /\[\s*(\d+)\s*\]/.exec(ddl?.sql ?? "");
  if (!dimMatch) throw new Error("cannot determine vector dimension for " + table);
  const dimension = Number(dimMatch[1]);
  const bytesPerVector = dimension * 4;
  const rowids = db
    .prepare('SELECT id, chunk_id, chunk_offset FROM "' + table + '_rowids" ORDER BY chunk_offset ASC')
    .all() as unknown as Array<{ id: string; chunk_id: number; chunk_offset: number }>;
  const chunks = new Map<number, Uint8Array>();
  for (const row of db.prepare('SELECT rowid, vectors FROM "' + table + '_vector_chunks00"').all() as unknown as Array<{
    rowid: number;
    vectors: Uint8Array;
  }>) {
    chunks.set(Number(row.rowid), row.vectors);
  }
  const ids: string[] = [];
  const vectors = new Float32Array(rowids.length * dimension);
  rowids.forEach((row, i) => {
    const blob = chunks.get(Number(row.chunk_id));
    if (!blob) return;
    const offset = Number(row.chunk_offset) * bytesPerVector;
    if (offset + bytesPerVector > blob.byteLength) return;
    const view = new Float32Array(blob.buffer.slice(blob.byteOffset + offset, blob.byteOffset + offset + bytesPerVector));
    vectors.set(view, i * dimension);
    ids.push(row.id);
  });
  return { ids, vectors, dimension };
}
