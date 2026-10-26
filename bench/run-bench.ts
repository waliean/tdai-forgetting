/**
 * Recall benchmark.
 *
 * Answers one question with numbers instead of adjectives: does adding decay and
 * duplicate collapsing to retrieval return less noise, and does it cost anything
 * in the memories people asked to keep?
 *
 * Configurations compared:
 *
 *   baseline    rank fusion only — what tdai does today
 *   decay       rank fusion, then multiplied by the retention multiplier
 *   forgetting  rank fusion + decay, with near-duplicates collapsed in the window
 *
 * Metrics, all averaged over a fixed query set:
 *
 *   precision@k  share of returned slots whose record belongs to the query topic.
 *                Higher is better; this is the noise measure. Note it is a proxy:
 *                "same topic" is not "actually answers the query". The embedding-
 *                grounded check in bench/eval-embedding.ts is the one to trust.
 *   top1         share of queries whose first result belongs to the query topic.
 *                Reported but marked degenerate on this corpus: queries are derived
 *                from a record inside the topic, so fusion is guaranteed to find that
 *                record first. Any drop here means "decay demoted the very record the
 *                query was cut from", which is a different (and interesting) fact, not
 *                a quality measure.
 *   dupShare     share of returned slots occupied by a near-duplicate of an
 *                earlier result. Those slots carry no new information.
 *   pinRecall    share of queries whose window contains at least one pinned
 *                memory. A decay policy that lowers this is eating what users
 *                explicitly asked to keep.
 *
 * Usage:
 *   node bench/run-bench.ts                    # synthetic corpus, publishing-safe
 *   node bench/run-bench.ts --db <path>        # real snapshot, aggregate only
 *   node bench/run-bench.ts --k 10 --queries 40
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

import { isTdaiDatabase, snapshotCorpus, syntheticCorpus } from "./corpus.ts";
import { loadVectorIndex, embedWithOllama, searchVectors } from "./vector-index.ts";
import { jaccard, shingles } from "../src/redundancy.ts";
import { DEFAULT_DECAY, decayEnabled, rerankHits, trackingCoverage } from "../src/scoring.ts";
import { applyPins } from "../src/pin.ts";
import type { MemoryRecord } from "../src/types.ts";

const RRF_K = 60;
/** Similarity at or above which two records are treated as the same fact. */
const DUPLICATE_THRESHOLD = 0.6;

interface QueryCase {
  text: string;
  /** Scene the query is about; a returned record is relevant when its scene matches. */
  scene: string;
}

type Candidate = { record: MemoryRecord; score: number };

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
function lexical(records: MemoryRecord[], query: string, topK: number): Candidate[] {
  const queryShingles = shingles(query, 2);
  const scored = records.map((record) => ({ record, score: jaccard(queryShingles, shingles(record.content, 2)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function rrf(lists: Candidate[][]): Candidate[] {
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

function isDuplicate(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.type !== b.type) return false;
  return jaccard(shingles(a.content), shingles(b.content)) >= DUPLICATE_THRESHOLD;
}

interface WindowMetrics {
  precision: number;
  top1: number;
  dupShare: number;
  pinRecall: number;
}

function measureWindow(window: Candidate[], query: QueryCase): WindowMetrics {
  if (window.length === 0) return { precision: 0, top1: 0, dupShare: 0, pinRecall: 0 };
  const relevant = window.filter((h) => (h.record.scene_name || h.record.type) === query.scene).length;
  const top1 = (window[0].record.scene_name || window[0].record.type) === query.scene ? 1 : 0;
  let dup = 0;
  for (let i = 1; i < window.length; i++) {
    if (window.slice(0, i).some((earlier) => isDuplicate(earlier.record, window[i].record))) dup++;
  }
  return {
    precision: relevant / window.length,
    top1,
    dupShare: dup / window.length,
    pinRecall: window.some((h) => h.record.pinned) ? 1 : 0,
  };
}

interface RunOptions {
  dbPath?: string;
  k: number;
  queryCount: number;
  outFile?: string;
  useEmbeddings: boolean;
}

async function run(opts: RunOptions): Promise<void> {
  const source = opts.dbPath ? "snapshot" : "synthetic";
  let records: MemoryRecord[];
  if (opts.dbPath) {
    if (!isTdaiDatabase(opts.dbPath)) {
      throw new Error(`${opts.dbPath} does not look like a tdai database (no l1_records table)`);
    }
    records = snapshotCorpus(opts.dbPath);
  } else {
    records = syntheticCorpus();
  }

  records = applyPins(records);
  const pinnedCount = records.filter((r) => r.pinned).length;
  const queries = buildQueries(records, opts.queryCount);

  let vectorIndex: ReturnType<typeof loadVectorIndex> | undefined;
  if (opts.useEmbeddings && opts.dbPath) {
    try {
      vectorIndex = loadVectorIndex(opts.dbPath);
    } catch (err) {
      process.stderr.write(`embeddings unavailable, lexical only: ${String(err)}\n`);
    }
  }

  const now = new Date();
  // The shipped policy stands down when nothing records access. Benchmark the policy
  // that ships, not a variant that cannot run in the field.
  const coverage = trackingCoverage(records);
  const decayOn = decayEnabled(coverage, DEFAULT_DECAY);
  process.stdout.write(`access coverage ${(coverage * 100).toFixed(0)}% → decay ${decayOn ? "on" : "off (cold start)"}\n`);

  const result: Array<{ configuration: string } & WindowMetrics & { avgScore: number }> = [];

  for (const label of ["baseline", "decay", "forgetting"]) {
    const windows: Array<{ metrics: WindowMetrics; avgScore: number }> = [];

    for (const query of queries) {
      const candidates = await candidatesFor(records, vectorIndex, query.text, opts.k);
      let window: Candidate[];

      if (label === "baseline") {
        window = candidates.slice(0, opts.k);
      } else {
        window = rerankHits(candidates, DEFAULT_DECAY, now, { limit: opts.k, decay: decayOn }).map((h) => ({
          record: h.record,
          score: h.multipliedScore,
        }));
      }

      if (label === "forgetting") {
        // Collapse duplicates inside the window. When the incoming hit is pinned and
        // the resident copy is not, the pinned copy takes the slot: dropping it would
        // be a quiet way to lose exactly the memories a pin protects.
        const kept: Candidate[] = [];
        for (const hit of window) {
          const duplicateAt = kept.findIndex((k) => isDuplicate(k.record, hit.record));
          if (duplicateAt === -1) {
            kept.push(hit);
            continue;
          }
          if (hit.record.pinned && !kept[duplicateAt].record.pinned) kept[duplicateAt] = hit;
        }
        window = kept;
      }

      const avgScore = window.length > 0 ? window.reduce((sum, h) => sum + h.score, 0) / window.length : 0;
      windows.push({ metrics: measureWindow(window, query), avgScore });
    }

    result.push({
      configuration: label,
      precision: mean(windows.map((w) => w.metrics.precision)),
      top1: mean(windows.map((w) => w.metrics.top1)),
      dupShare: mean(windows.map((w) => w.metrics.dupShare)),
      pinRecall: mean(windows.map((w) => w.metrics.pinRecall)),
      avgScore: mean(windows.map((w) => w.avgScore)),
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source,
    corpusSize: records.length,
    pinned: pinnedCount,
    queries: queries.length,
    k: opts.k,
    embeddings: !!vectorIndex,
    results: result,
  };

  process.stdout.write(
    `\nsource ${source}, ${records.length} records, ${pinnedCount} pinned, ${queries.length} queries, k=${opts.k}, embeddings=${!!vectorIndex}\n\n`,
  );
  const header = ["configuration", "precision@k", "top1", "dupShare", "pinRecall", "avgScore"];
  const widths = [14, 13, 8, 10, 11, 10];
  process.stdout.write(header.map((h, i) => h.padEnd(widths[i])).join("") + "\n");
  for (const row of result) {
    process.stdout.write(
      [
        row.configuration.padEnd(14),
        row.precision.toFixed(3).padEnd(13),
        row.top1.toFixed(3).padEnd(8),
        row.dupShare.toFixed(3).padEnd(10),
        row.pinRecall.toFixed(3).padEnd(11),
        row.avgScore.toFixed(4).padEnd(10),
      ].join("") + "\n",
    );
  }

  process.stdout.write(
    "\nprecision@k is topical, not semantic — cross-check with bench/eval-embedding.ts before quoting it.\n",
  );

  if (opts.outFile) {
    writeFileSync(opts.outFile, JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`report written to ${opts.outFile}\n`);
  }
}

/** Fuse lexical and vector candidates when embeddings are available. */
async function candidatesFor(
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

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    k: { type: "string", default: "10" },
    queries: { type: "string", default: "40" },
    out: { type: "string" },
    "no-embeddings": { type: "boolean", default: false },
  },
});

void run({
  dbPath: values.db,
  k: Number(values.k),
  queryCount: Number(values.queries),
  outFile: values.out,
  useEmbeddings: !values["no-embeddings"],
});
