/**
 * What does one log line cost?
 *
 * B2 wires `appendRecall` into the synchronous return path of a search. The call
 * is a single `appendFileSync`, so it "should" be free. "Should" has already been
 * falsified twice in this repo (the pin ceiling, the cold-start decay gate), so the
 * question is settled with a measurement instead of an argument:
 *
 *   two modes, same corpus, same query set, same retrieval chain
 *   --telemetry off   the search ends when the ranking does          (B2 reverted)
 *   --telemetry on    appendRecall writes one JSON line before return (B2 wired)
 *
 * The measured quantity is THE WHOLE SEARCH, not `appendRecall` alone. A cheap
 * append can still cost a search: the synchronous write dirties a file the next
 * write must extend, and on Windows the realtime scanner (Defender) walks the
 * directory between the two. Timing the append in isolation would answer a
 * question nobody asked and hide the one that decides the block.
 *
 * Cache state, stated rather than implied. Everything that is expensive and
 * cacheable is warmed BEFORE the clock starts and is identical in both modes:
 *
 *   - corpus + inverted index   in memory, built once, frozen (no writes)
 *   - sqlite page cache         one read-only connection opened once; both modes
 *                               share those pages, neither re-opens it
 *   - query-prefix embeddings   every prefix either mode will ask for is fetched
 *                               up front (Ollama bge-m3), so no mode pays a model
 *                               miss the other does not
 *
 * So this is a WARM run. What that buys: the delta below is attributable to
 * telemetry, not to cache luck. What it costs: a cold first search pays an
 * embedding call this bench never measures, so these numbers are the floor of
 * the steady state, not a cold-start figure.
 *
 * Usage:
 *   node bench/latency.ts --db data/snapshot-20261026.db --iterations 200 --telemetry-both
 *   node bench/latency.ts --db ... --telemetry-both --json .scratch/b4-latency.json
 *
 * Writes only to a fresh temp directory. The database is opened read-only.
 */

import { mkdtempSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import { appendRecall, type RecallHit } from "../src/recall.ts";
import { DEFAULT_DECAY, rerankHits, trackingCoverage, hasAccessSignal } from "../src/scoring.ts";
import { loadVectorIndex, cosine, type VectorIndex } from "./vector-index.ts";
import type { MemoryRecord } from "../src/types.ts";

// ------------------------------ knobs ------------------------------

/** 45 candidates merged from three channels, reranked, reported as the top 10 --
 *  the shape `executeMemorySearch` hands to `appendRecall` (candidateK = limit*3,
 *  then a rerank, then a trim). Ranks handed to the log are therefore 1..10. */
const CANDIDATE_K = 45;
const RETURN_N = 15;
const RESULT_LIMIT = 10;

/** RRF damping, the same constant upstream uses in l1-candidate-recall. */
const RRF_K = 60;

/** Terms in a query that run through the FTS channel. Caps a long sentence's cost. */
const MAX_FTS_TERMS = 8;

// ---------------------------- query set ----------------------------
//
// >= 10 queries spanning the three shapes the prompt asks for (single token,
// multiple tokens, long sentence). Each carries an embedding prefix: real queries
// about a corpus tend to name the scene, and the prefix doubles as the embedding
// cache key so both modes share one cached vector per query. Content-free -- these
// are topic words already visible in the corpus's scene names, not record bodies.

interface QuerySpec {
  id: string;
  shape: "single" | "multi" | "long";
  prefix: string;
  text: string;
}

const QUERIES: QuerySpec[] = [
  { id: "q01", shape: "single", prefix: "RRS", text: "RRS" },
  { id: "q02", shape: "single", prefix: "JFPE", text: "JFPE" },
  { id: "q03", shape: "single", prefix: "LongCat", text: "LongCat" },
  { id: "q04", shape: "multi", prefix: "RRS 课题3", text: "RRS 课题3 论文 图表 生产" },
  { id: "q05", shape: "multi", prefix: "JFPE", text: "JFPE 论文 盲审 意见 整改" },
  { id: "q06", shape: "multi", prefix: "LongCat", text: "LongCat Video 服务器 部署 NCCL 坑" },
  { id: "q07", shape: "multi", prefix: "Cogito", text: "Cogito 比赛版 构建 竞赛报告 迭代" },
  { id: "q12", shape: "multi", prefix: "tdai", text: "tdai 复刻 部署 记忆库 备份 容器" },
  { id: "q08", shape: "long", prefix: "RRS", text: "我在和用户（RRS课题3 PL王晨博）存档课题执行记录与管理决策记忆，需要把这一轮的执行结论、图表线生产和全章审查口径一起归档，方便下一轮复查时直接引用" },
  { id: "q09", shape: "long", prefix: "JFPE", text: "我在和JFPE论文研究者用户把全自动取点成果存为永久记忆，同时记录数字化工具链的处理方式与上一轮整改遗留的问题清单" },
  { id: "q10", shape: "long", prefix: "LongCat", text: "我在和数字人视频研究用户永久保存 LongCat-Video-Avatar 双卡 A800 实测记忆，包括服务器部署步骤、接入巡检结论和 NCCL P2P 踩坑的复现步骤" },
  { id: "q11", shape: "long", prefix: "数学建模", text: "我（AI）在和数学建模研究者用户做 cumcm-skill 实测勘误研究记忆的永久存档，把三项门槛的实测结果与抽样复算的数字差异都记下来" },
];

// ---------------------- candidate generation ----------------------
//
// A real candidate set, assembled from the snapshot the way the product does:
// independently-ranked channels fused by reciprocal rank, then scored. No channel
// here is a stub -- each one reads data that exists in the snapshot.

/** Query terms for the FTS channel. Separators are dropped on purpose. */
function terms(text: string): string[] {
  return Array.from(new Set(text.split(/[\s，。、（）:：;；]+/).filter((t) => t.length >= 2)));
}

/** Bigrams over CJK runs: the fallback channel when a topic word is out of
 *  vocabulary or a coined product name has no dictionary entry. */
function bigrams(text: string): string[] {
  const runs = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const out: string[] = [];
  for (const run of runs) for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  return Array.from(new Set(out)).slice(0, 40);
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[A-Za-z0-9_.+-]{2,}/g) ?? []) out.push(run.toLowerCase());
  for (const bg of bigrams(text)) out.push(bg);
  return out.slice(0, 60);
}

interface Channel {
  name: string;
  /** Ordered record ids, best first. */
  ids: string[];
}

class RetrievalIndex {
  readonly records: MemoryRecord[];
  readonly byId: Map<string, MemoryRecord>;
  readonly vecIndex: VectorIndex;
  private readonly inverted: Map<string, Set<string>>;
  private readonly db: DatabaseSync;

  constructor(dbPath: string, vecTable = "l1_vec") {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    // One connection, opened once: both modes share the sqlite page cache, so
    // neither pays a different number of page faults for the same read.
    this.records = loadRecords(dbPath, {});
    this.byId = new Map(this.records.map((r) => [r.record_id, r]));
    this.vecIndex = loadVectorIndex(dbPath, vecTable);

    this.inverted = new Map();
    for (const r of this.records) {
      const body = (r.content ?? "") + " " + (r.scene_name ?? "") + " " + (r.type ?? "");
      for (const tok of tokenize(body)) {
        let bucket = this.inverted.get(tok);
        if (!bucket) this.inverted.set(tok, (bucket = new Set()));
        bucket.add(r.record_id);
      }
    }
  }

  /** FTS5 bm25 over the real l1_fts table. Returns [] when the query has no CJK terms. */
  ftsChannel(query: string): Channel {
    const ts = terms(query).slice(0, MAX_FTS_TERMS);
    if (ts.length === 0) return { name: "fts", ids: [] };
    try {
      const rows = this.db
        .prepare("SELECT record_id FROM l1_fts WHERE l1_fts MATCH ? ORDER BY bm25(l1_fts, 1.0, 0.5) LIMIT ?")
        .all(ts.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" OR "), CANDIDATE_K) as unknown as Array<{ record_id: string }>;
      return { name: "fts", ids: rows.map((r) => r.record_id) };
    } catch {
      // A query the FTS parser rejects is not a failed search: the other two
      // channels still produce a candidate pool. Silence here is deliberate.
      return { name: "fts", ids: [] };
    }
  }

  /** Inverted-index overlap. Pure in-memory and deterministic -- the channel whose
   *  cost does not swamp the signal being measured. */
  lexicalChannel(query: string): Channel {
    const ts = tokenize(query);
    if (ts.length === 0) return { name: "lexical", ids: [] };
    const scores = new Map<string, number>();
    for (const t of ts) {
      const bucket = this.inverted.get(t);
      if (!bucket) continue;
      for (const id of bucket) scores.set(id, (scores.get(id) ?? 0) + 1);
    }
    const ids = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_K).map(([id]) => id);
    return { name: "lexical", ids };
  }

  /** Cosine over the real l1_vec payload. The only channel that needs an embedding,
   *  hence the only one with a cache to declare. */
  vectorChannel(queryVec: Float32Array): Channel {
    const { ids, vectors, dimension } = this.vecIndex;
    const scored: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < ids.length; i++) {
      scored.push({ id: ids[i], score: cosine(vectors, queryVec, dimension, i * dimension, 0) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { name: "vector", ids: scored.slice(0, CANDIDATE_K).map((h) => h.id) };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Reciprocal rank fusion over whatever channels returned something.
 *
 * Same shape as upstream's l1-candidate-recall: a channel that found nothing
 * contributes nothing, no channel is weighted by hand. Fusion rather than a single
 * channel is the point -- a search that ran only the vector channel would make the
 * telemetry delta a function of one scan, not of the merge this block is about.
 */
function fuse(channels: Channel[]): Array<{ id: string; score: number }> {
  const acc = new Map<string, number>();
  for (const ch of channels) {
    ch.ids.forEach((id, rank) => acc.set(id, (acc.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_K);
}

// ---------------------------- the search ----------------------------
//
// == COMPARABILITY CONTRACT ==
// `runPipeline` is the ONLY code between the two modes, and they differ by exactly
// the `if (mode === "on")` append at the bottom of it. Everything above that line --
// candidate generation, fusion, rerank, trim, RecallHit[] construction -- is shared
// source, executed identically, reading only frozen state. There is no `if (telemetry)`
// earlier in the function and no second implementation to drift.
//
// The post-run fingerprint check is what makes this checkable rather than asserted:
// both modes must return byte-identical hit sequences, or the timing comparison is
// between two different code paths and the number means nothing.

interface SearchResult {
  hits: RecallHit[];
  total: number;
}

function runPipeline(
  index: RetrievalIndex,
  spec: QuerySpec,
  queryVec: Float32Array,
  mode: "on" | "off",
  logPath: string,
  decayOn: boolean,
  now: Date,
): SearchResult {
  // ---- shared region: identical source for both modes ----
  const fused = fuse([index.lexicalChannel(spec.text), index.ftsChannel(spec.text), index.vectorChannel(queryVec)]);

  const scored = fused
    .map((c) => ({ record: index.byId.get(c.id), score: c.score }))
    .filter((h): h is { record: MemoryRecord; score: number } => h.record !== undefined);

  const ranked = rerankHits(scored, DEFAULT_DECAY, now, { limit: RETURN_N, decay: decayOn });

  const trimmed = ranked.slice(0, RESULT_LIMIT);
  const hits: RecallHit[] = trimmed.map((r, i) => ({ record_id: r.record.record_id, rank: i + 1 }));
  const total = trimmed.length;
  // ---- end shared region ----

  if (mode === "on" && logPath) {
    appendRecall(logPath, hits, now);
  }
  return { hits, total };
}

// ------------------------------ timing ------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface Stats {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? 0,
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? 0,
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  };
}

function fmt(n: number, digits = 4): string {
  return n.toFixed(digits);
}

function table(label: string, s: Stats): string {
  return (label + " ").padEnd(20) +
    "n=" + String(s.n).padStart(4) +
    "  min=" + fmt(s.min) +
    "  p50=" + fmt(s.p50) +
    "  p90=" + fmt(s.p90) +
    "  p99=" + fmt(s.p99) +
    "  max=" + fmt(s.max) +
    "  mean=" + fmt(s.mean);
}

// -------------------------- embedding cache --------------------------
//
// Warmed before either mode runs. Every prefix the query set will ask for is
// embedded exactly once; `runPipeline` then reads a Map. If this were lazy, the
// first mode to run would absorb every miss and the delta would measure cache
// warmth -- the single easiest way to get this block wrong.

async function warmEmbeddings(baseUrl: string, model: string): Promise<Map<string, Float32Array>> {
  const cache = new Map<string, Float32Array>();
  const prefixes = Array.from(new Set(QUERIES.map((q) => q.prefix)));
  for (const p of prefixes) {
    const res = await fetch(baseUrl + "/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: p }),
    });
    if (!res.ok) throw new Error("ollama embeddings failed: " + res.status + " " + (await res.text()));
    const body = (await res.json()) as { embedding?: number[] };
    if (!body.embedding) throw new Error("ollama response missing embedding");
    cache.set(p, Float32Array.from(body.embedding));
  }
  return cache;
}

// ------------------------------- main -------------------------------

interface ModeRun {
  mode: "on" | "off";
  statsMs: Stats;
  samples: number[];
  logBytes: number;
  hitCounts: number[];
  fingerprints: string[];
}

function runMode(
  index: RetrievalIndex,
  mode: "on" | "off",
  iterations: number,
  warmup: number,
  logPath: string,
  embeddings: Map<string, Float32Array>,
  decayOn: boolean,
): ModeRun {
  const now = new Date();
  const samples: number[] = [];
  const hitCounts = new Set<number>();
  const fingerprints: string[] = [];

  const total = warmup + iterations;
  for (let i = 0; i < total; i++) {
    const spec = QUERIES[i % QUERIES.length];
    const vec = embeddings.get(spec.prefix);
    if (!vec) throw new Error("embedding cache miss for prefix " + spec.prefix);

    const t0 = performance.now();
    const result = runPipeline(index, spec, vec, mode, logPath, decayOn, now);
    const t1 = performance.now();

    if (i >= warmup) {
      samples.push(t1 - t0);
      hitCounts.add(result.total);
      fingerprints.push(result.hits.map((h) => h.record_id).join(","));
    }
  }

  let logBytes = 0;
  if (mode === "on" && logPath) {
    try {
      logBytes = statSync(logPath).size;
    } catch {
      // off mode leaves no file; a missing file is the expected state, not a failure.
    }
  }

  return { mode, statsMs: stats(samples), samples, logBytes, hitCounts: [...hitCounts].sort(), fingerprints };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: "string" },
      iterations: { type: "string", default: "200" },
      warmup: { type: "string", default: "10" },
      "telemetry-both": { type: "boolean", default: false },
      "ollama-url": { type: "string", default: "http://127.0.0.1:11434" },
      model: { type: "string", default: "bge-m3" },
      "log-dir": { type: "string" },
      json: { type: "string" },
      "round-label": { type: "string", default: "round1" },
    },
  });

  const dbPath = values.db;
  if (!dbPath) throw new Error("--db is required");
  const iterations = Number(values.iterations);
  const warmup = Number(values.warmup);

  const index = new RetrievalIndex(dbPath);
  const coverage = trackingCoverage(index.records);
  const covered = index.records.filter(hasAccessSignal).length;
  const decayOn = coverage >= DEFAULT_DECAY.minTrackingCoverage;

  const embeddings = await warmEmbeddings(values["ollama-url"] as string, values.model as string);
  const cacheMissing = QUERIES.filter((q) => !embeddings.has(q.prefix)).length;

  const logDir = (values["log-dir"] as string) ?? mkdtempSync(join(tmpdir(), "b4-latency-"));
  mkdirSync(logDir, { recursive: true });

  console.log("== B4 latency: the cost of one log line on the search path ==");
  console.log("node             " + process.version);
  console.log("platform         " + process.platform + " " + process.arch);
  console.log("db               " + dbPath + " (read-only)");
  console.log("records          " + index.records.length + "   vector rows " + index.vecIndex.ids.length + "   dim " + index.vecIndex.dimension);
  console.log("trackingCoverage " + fmt(coverage) + "  (" + covered + "/" + index.records.length + " carry an access signal) -> decay " + (decayOn ? "ON" : "OFF"));
  console.log("queries          " + QUERIES.length + "  (single " + QUERIES.filter((q) => q.shape === "single").length +
    " / multi " + QUERIES.filter((q) => q.shape === "multi").length +
    " / long " + QUERIES.filter((q) => q.shape === "long").length + ")");
  console.log("iterations       " + iterations + " timed + " + warmup + " warmup, per mode");
  console.log("cache            WARM -- corpus+index in memory, one shared read-only sqlite connection,");
  console.log("                 " + embeddings.size + " query-prefix embeddings pre-fetched (missing " + cacheMissing + ")");
  console.log("pipeline         candidateK=" + CANDIDATE_K + " -> rerank limit=" + RETURN_N + " -> return " + RESULT_LIMIT + " hits");
  console.log("");

  const modes: Array<"off" | "on"> = values["telemetry-both"] ? ["off", "on"] : ["off"];
  const runs: ModeRun[] = [];

  for (const mode of modes) {
    const logPath = join(logDir, "recall-access-" + mode + ".jsonl");
    if (mode === "on") writeFileSync(logPath, "");
    const run = runMode(index, mode, iterations, warmup, logPath, embeddings, decayOn);
    runs.push(run);
    console.log(table("telemetry " + mode, run.statsMs));
    if (mode === "on") {
      console.log("                     log bytes=" + run.logBytes + "  distinct hit-counts=" + run.hitCounts.join("/"));
    }
  }

  const off = runs.find((r) => r.mode === "off")!;
  const on = runs.find((r) => r.mode === "on");

  console.log("");
  let delta: Record<string, number> | null = null;
  let identical: boolean | null = null;
  if (on) {
    delta = {
      p50: on.statsMs.p50 - off.statsMs.p50,
      p90: on.statsMs.p90 - off.statsMs.p90,
      p99: on.statsMs.p99 - off.statsMs.p99,
      max: on.statsMs.max - off.statsMs.max,
      mean: on.statsMs.mean - off.statsMs.mean,
    };
    console.log("delta (on - off)  p50=" + fmt(delta.p50) + "  p90=" + fmt(delta.p90) + "  p99=" + fmt(delta.p99) + "  max=" + fmt(delta.max) + "  mean=" + fmt(delta.mean));
    console.log("verdict           p99 delta " + fmt(delta.p99) + " ms -> " + (delta.p99 > 5 ? "ABOVE 5ms" : "within 5ms"));

    identical = off.fingerprints.length === on.fingerprints.length &&
      off.fingerprints.every((f, i) => f === on.fingerprints[i]);
    console.log("comparability     identical hit sequences in both modes = " + identical +
      "  (" + off.fingerprints.length + " off / " + on.fingerprints.length + " on)");
    if (!identical) {
      let firstDiff = -1;
      for (let i = 0; i < Math.min(off.fingerprints.length, on.fingerprints.length); i++) {
        if (off.fingerprints[i] !== on.fingerprints[i]) { firstDiff = i; break; }
      }
      console.log("                  first divergence at timed iteration " + firstDiff);
    }
  } else {
    console.log("only one mode ran; pass --telemetry-both for the comparison");
  }

  if (values.json) {
    const payload = {
      round: values["round-label"],
      ranAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform + " " + process.arch,
      db: dbPath,
      records: index.records.length,
      vectorRows: index.vecIndex.ids.length,
      dimension: index.vecIndex.dimension,
      trackingCoverage: coverage,
      decayOn,
      queries: QUERIES.length,
      iterations,
      warmup,
      cache: "warm",
      embeddingPrefixes: embeddings.size,
      pipeline: { candidateK: CANDIDATE_K, rerankLimit: RETURN_N, returnN: RESULT_LIMIT },
      modes: Object.fromEntries(runs.map((r) => [r.mode, { ...r.statsMs, logBytes: r.logBytes, distinctHitCounts: r.hitCounts }])),
      delta,
      identicalHitSequences: identical,
      samples: Object.fromEntries(runs.map((r) => [r.mode, r.samples])),
    };
    mkdirSync(dirname(values.json as string), { recursive: true });
    writeFileSync(values.json as string, JSON.stringify(payload, null, 2), "utf8");
    console.log("json -> " + values.json);
  }

  index.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
