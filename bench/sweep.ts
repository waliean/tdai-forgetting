/**
 * Parameter sweep.
 *
 * The numbers this project ships — a 10% tracking-coverage gate, a 30-day
 * half-life, a 0.6 Jaccard bar — were picked from a handful of runs, not derived.
 * A picked parameter stops being defensible the moment the corpus changes, and it
 * fails silently when it does: nothing in the system says "these numbers are wrong
 * for this data". This script makes the reachable space visible — one command, one
 * CSV, each row a parameter combination and the metrics it produced.
 *
 * The metrics are not redefined here. `bench/harness.ts` owns the definitions that
 * `bench/run-bench.ts` reports (`precision@k`, `dupShare`, `pinRecall`, and the
 * duplicate-collapse step), and this file is a second driver over that same code.
 * A sweep whose precision meant something slightly different from the published
 * benchmark would make every historical number incomparable, which is the exact
 * failure the calibration exists to prevent.
 *
 * Retrieval is fixed to lexical-only on purpose. A sweep over policy parameters
 * must not also move the retrieval substrate: if some rows used embeddings and
 * others fell back, the difference between two rows would mix a policy change with
 * a provider being up. The comparable baseline is `run-bench --no-embeddings`.
 *
 * Usage:
 *   node bench/sweep.ts --grid halfLifeDays=14,30,60 --out sweep.csv
 *   node bench/sweep.ts --grid floor=0.2,0.3,0.5 --grid clusterThreshold=0.5,0.6,0.7
 *   node bench/sweep.ts --corpus snapshot --db data/snapshot.db --queries 20
 *
 * Combinations that cannot run are skipped with a reason on stderr, and the exit
 * code stays 0: a grid is a request to explore, and one bad point in it is data
 * about the grid, not a crashed run.
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

import { isTdaiDatabase, snapshotCorpus, syntheticCorpus } from "./corpus.ts";
import { longtextCorpus } from "./corpus-long.ts";
import { describeCorpus, formatStats } from "./corpus-stats.ts";
import { buildQueries, collapseDuplicates, lexical, mean, measureWindow } from "./harness.ts";
import { applyPins } from "../src/pin.ts";
import { DEFAULT_DECAY, decayEnabled, rerankHits, trackingCoverage } from "../src/scoring.ts";
import { DEFAULT_CLUSTER_OPTIONS } from "../src/redundancy.ts";
import { DEFAULT_EVICTION, buildForgettingPlan } from "../src/planner.ts";
import type { MemoryRecord } from "../src/types.ts";

/**
 * The six knobs under calibration. Order is the CSV column order.
 *
 * The names are the same ones used in the config types, so a row can be pasted
 * into a bug report and read without a translation table.
 */
const GRID_KEYS = [
  "halfLifeDays",
  "floor",
  "minTrackingCoverage",
  "clusterThreshold",
  "archiveThreshold",
  "retireThreshold",
  "retirePercentile",
] as const;
type ParamKey = (typeof GRID_KEYS)[number];
type GridPoint = Record<ParamKey, number>;

/**
 * Defaults are read from the shipped constants, never retyped.
 *
 * When D4 changes a default, the sweep must follow it automatically. A sweep that
 * carried its own copy of "30 days" would keep calibrating a value the system no
 * longer uses, and it would look correct while doing it.
 */
const DEFAULTS: GridPoint = {
  halfLifeDays: DEFAULT_DECAY.halfLifeDays,
  floor: DEFAULT_DECAY.floor,
  minTrackingCoverage: DEFAULT_DECAY.minTrackingCoverage,
  clusterThreshold: DEFAULT_CLUSTER_OPTIONS.threshold,
  archiveThreshold: DEFAULT_EVICTION.archiveThreshold,
  retireThreshold: DEFAULT_EVICTION.retireThreshold,
  retirePercentile: DEFAULT_EVICTION.retirePercentile,
};

/** Legal domain per parameter. A violation skips the combination, it does not crash the run. */
const PARAM_RULES: Record<ParamKey, (value: number) => string | null> = {
  halfLifeDays: (v) => (v > 0 ? null : "must be > 0"),
  floor: (v) => (v >= 0 && v <= 1 ? null : "must be in [0, 1]"),
  minTrackingCoverage: (v) => (v >= 0 && v <= 1 ? null : "must be in [0, 1]"),
  clusterThreshold: (v) => (v > 0 && v <= 1 ? null : "must be in (0, 1]"),
  archiveThreshold: (v) => (v >= 0 && v <= 1 ? null : "must be in [0, 1]"),
  retireThreshold: (v) => (v >= 0 && v <= 1 ? null : "must be in [0, 1]"),
  retirePercentile: (v) => (v >= 0 && v < 1 ? null : "must be in [0, 1)"),
};

const CSV_HEADER = [
  ...GRID_KEYS,
  "decayActive",
  "precisionAtK",
  "pinRecall",
  "dupShare",
  "evictedShare",
];

interface PointMetrics {
  decayActive: boolean;
  precisionAtK: number;
  pinRecall: number;
  dupShare: number;
  evictedShare: number;
}

/** A command-line problem is not a grid point: it means the request itself is malformed. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function loadCorpus(kind: string, dbPath?: string): MemoryRecord[] {
  switch (kind) {
    case "synthetic":
      return syntheticCorpus();
    case "snapshot": {
      if (!dbPath) throw new Error("--corpus snapshot requires --db <path>");
      if (!isTdaiDatabase(dbPath)) throw new Error(`${dbPath} does not look like a tdai database (no l1_records table)`);
      return snapshotCorpus(dbPath);
    }
    case "longtext":
      return longtextCorpus();
    default:
      throw new Error(`unknown corpus "${kind}"; expected synthetic, snapshot or longtext`);
  }
}

/**
 * Evaluate one combination.
 *
 * Builds the window exactly the way `run-bench.ts`'s `forgetting` configuration
 * does — fuse, re-rank with the swept decay config, collapse duplicates at the
 * swept threshold — then measures with the shared metrics. `evictedShare` comes
 * from the planner, because the two eviction thresholds act there, not in ranking.
 */
function evaluatePoint(
  records: MemoryRecord[],
  queries: ReturnType<typeof buildQueries>,
  point: GridPoint,
  k: number,
  now: Date,
  coverage: number,
): PointMetrics {
  const decay = {
    ...DEFAULT_DECAY,
    halfLifeDays: point.halfLifeDays,
    floor: point.floor,
    minTrackingCoverage: point.minTrackingCoverage,
  };
  const cluster = { ...DEFAULT_CLUSTER_OPTIONS, threshold: point.clusterThreshold };
  const eviction = {
    ...DEFAULT_EVICTION,
    archiveThreshold: point.archiveThreshold,
    retireThreshold: point.retireThreshold,
    retirePercentile: point.retirePercentile,
  };
  const decayOn = decayEnabled(coverage, decay);

  const windows = queries.map((query) => {
    const candidates = lexical(records, query.text, k * 3);
    const reranked = rerankHits(candidates, decay, now, { limit: k, decay: decayOn }).map((h) => ({
      record: h.record,
      score: h.multipliedScore,
    }));
    const window = collapseDuplicates(reranked, point.clusterThreshold);
    return measureWindow(window, query, point.clusterThreshold);
  });

  // The planner is the only place the eviction thresholds do anything, and it scores
  // with the same decay config and clusters with the same threshold, so a row's
  // evictedShare and its precision describe one policy rather than two.
  const plan = buildForgettingPlan(records, { decay, eviction, now: () => now }, { cluster });
  const evictedShare = plan.total > 0 ? (plan.archived + plan.retired) / plan.total : 0;

  return {
    decayActive: decayOn,
    precisionAtK: mean(windows.map((w) => w.precision)),
    pinRecall: mean(windows.map((w) => w.pinRecall)),
    dupShare: mean(windows.map((w) => w.dupShare)),
    evictedShare,
  };
}

function formatRow(point: GridPoint, metrics: PointMetrics): string[] {
  return [
    ...GRID_KEYS.map((key) => String(point[key])),
    metrics.decayActive ? "true" : "false",
    metrics.precisionAtK.toFixed(4),
    metrics.pinRecall.toFixed(4),
    metrics.dupShare.toFixed(4),
    metrics.evictedShare.toFixed(4),
  ];
}

function writeCsv(outPath: string | undefined, rows: string[][]): void {
  const body = [CSV_HEADER.join(","), ...rows.map((row) => row.join(","))].join("\n") + "\n";
  if (outPath) {
    writeFileSync(outPath, body, "utf8");
    return;
  }
  process.stdout.write(body);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      grid: { type: "string", multiple: true, default: [] },
      corpus: { type: "string", default: "synthetic" },
      db: { type: "string" },
      queries: { type: "string", default: "24" },
      k: { type: "string", default: "10" },
      out: { type: "string" },
      describe: { type: "boolean", default: false },
    },
  });

  // ── Parse the grid ──
  const overrides = new Map<ParamKey, number[]>();
  for (const spec of values.grid) {
    const eq = spec.indexOf("=");
    if (eq < 0) fail(`--grid expects key=v1,v2,..., got "${spec}"`);
    const key = spec.slice(0, eq).trim();
    if (!(GRID_KEYS as readonly string[]).includes(key)) {
      fail(`unknown grid key "${key}"; known: ${GRID_KEYS.join(", ")}`);
    }
    const parts = spec
      .slice(eq + 1)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) fail(`--grid ${key}= has no values`);
    overrides.set(
      key as ParamKey,
      parts.map((part) => {
        const parsed = Number(part);
        if (!Number.isFinite(parsed)) fail(`--grid ${key}: "${part}" is not a number`);
        return parsed;
      }),
    );
  }

  // ── Load the corpus ──
  let records: MemoryRecord[];
  try {
    records = loadCorpus(values.corpus, values.db);
  } catch (err) {
    process.stderr.write(`failed to load corpus "${values.corpus}": ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  records = applyPins(records);
  if (values.describe) {
    // On stderr and off the CSV: "what this corpus is made of" describes the input,
    // while every CSV row describes an output. Mixing them would make one table whose
    // columns mean two different things.
    for (const line of formatStats(describeCorpus(records, values.corpus))) process.stderr.write(line + "\n");
  }
  const coverage = trackingCoverage(records);
  const queryCount = Number(values.queries);
  const k = Number(values.k);
  const queries = buildQueries(records, queryCount);
  if (queries.length === 0) {
    process.stderr.write(
      `corpus "${values.corpus}" produced no queries; buildQueries needs scenes with at least 5 records\n`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Expand the Cartesian product ──
  let points: GridPoint[] = [{ ...DEFAULTS }];
  for (const key of GRID_KEYS) {
    const valuesFor = overrides.get(key);
    if (!valuesFor) continue;
    const next: GridPoint[] = [];
    for (const point of points) {
      for (const value of valuesFor) next.push({ ...point, [key]: value } as GridPoint);
    }
    points = next;
  }

  // ── Run ──
  const now = new Date();
  const rows: string[][] = [];
  let skipped = 0;
  const startedAt = performance.now();

  for (const point of points) {
    const problems: string[] = [];
    for (const key of GRID_KEYS) {
      const reason = PARAM_RULES[key](point[key]);
      if (reason) problems.push(`${key}=${point[key]} ${reason}`);
    }
    if (problems.length > 0) {
      process.stderr.write(`skipped combination: ${problems.join("; ")}\n`);
      skipped++;
      continue;
    }
    rows.push(formatRow(point, evaluatePoint(records, queries, point, k, now, coverage)));
  }

  writeCsv(values.out, rows);

  const elapsed = Math.round(performance.now() - startedAt);
  process.stderr.write(
    `sweep: ${rows.length} of ${points.length} combination(s) written` +
      `${skipped > 0 ? `, ${skipped} skipped` : ""}` +
      ` (corpus=${values.corpus}, records=${records.length}, queries=${queries.length}, k=${k},` +
      ` retrieval=lexical-only, ${elapsed}ms)\n`,
  );
}

void main();
