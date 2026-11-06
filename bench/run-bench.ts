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
import { buildQueries, candidatesFor, collapseDuplicates, mean, measureWindow, type Candidate, type QueryCase, type WindowMetrics } from "./harness.ts";
import { loadVectorIndex } from "./vector-index.ts";
import { DEFAULT_DECAY, decayEnabled, rerankHits, trackingCoverage } from "../src/scoring.ts";
import { applyPins } from "../src/pin.ts";
import type { MemoryRecord } from "../src/types.ts";

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
        window = collapseDuplicates(window);
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
