/**
 * Corpus description.
 *
 * A parameter calibration is only as general as the corpora it was measured on, so
 * every corpus this project reports on has to be described in numbers a reader can
 * compare: how long the records are, what they are made of, how many carry a pin,
 * and how much duplication the shipped detector actually finds in them.
 *
 * The duplicate count is the one to read carefully. It is measured with
 * `DEFAULT_CLUSTER_OPTIONS`, i.e. the threshold the system ships, not a threshold
 * chosen to make the corpus look tidy. On the long-text corpus the count is lower
 * than the number of fact groups that genuinely are duplicates, and that gap is the
 * measurement — see bench/corpus-long.ts.
 */

import { DEFAULT_CLUSTER_OPTIONS, findRedundancyClusters } from "../src/redundancy.ts";
import type { MemoryRecord } from "../src/types.ts";

export interface CorpusStats {
  label: string;
  records: number;
  length: { min: number; p50: number; p90: number; max: number };
  types: Array<{ type: string; count: number; share: number }>;
  pins: { hard: number; extended: number; ratio: number };
  duplicates: { groups: number; recordsInGroups: number; largestGroup: number; threshold: number };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Describe a corpus.
 *
 * Expects records that have already been through `applyPins`: without that pass
 * `pinned`/`pin_kind` are unset and the pin row would read as zero on any corpus,
 * which is a wrong number that looks like a finding.
 */
export function describeCorpus(records: MemoryRecord[], label: string): CorpusStats {
  const lengths = records.map((r) => r.content.length).sort((a, b) => a - b);

  const typeCounts = new Map<string, number>();
  for (const record of records) typeCounts.set(record.type, (typeCounts.get(record.type) ?? 0) + 1);

  const hard = records.filter((r) => r.pinned && r.pin_kind === "hard").length;
  const extended = records.filter((r) => r.pinned && r.pin_kind === "extended").length;

  const clusters = findRedundancyClusters(records, DEFAULT_CLUSTER_OPTIONS);

  return {
    label,
    records: records.length,
    length: {
      min: lengths[0] ?? 0,
      p50: percentile(lengths, 0.5),
      p90: percentile(lengths, 0.9),
      max: lengths[lengths.length - 1] ?? 0,
    },
    types: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count, share: records.length > 0 ? count / records.length : 0 }))
      .sort((a, b) => b.count - a.count),
    pins: { hard, extended, ratio: records.length > 0 ? (hard + extended) / records.length : 0 },
    duplicates: {
      groups: clusters.length,
      recordsInGroups: clusters.reduce((sum, cluster) => sum + cluster.memberIds.length, 0),
      largestGroup: clusters.reduce((max, cluster) => Math.max(max, cluster.memberIds.length), 0),
      threshold: DEFAULT_CLUSTER_OPTIONS.threshold,
    },
  };
}

/** Render one corpus description as lines, for a `--describe` switch on stderr. */
export function formatStats(stats: CorpusStats): string[] {
  const pct = (n: number): string => (n * 100).toFixed(1) + "%";
  const lines = [
    `corpus ${stats.label}: ${stats.records} records`,
    `  length (chars): min ${stats.length.min}, p50 ${stats.length.p50}, p90 ${stats.length.p90}, max ${stats.length.max}`,
    `  types: ${stats.types.map((t) => `${t.type} ${t.count} (${pct(t.share)})`).join(", ") || "none"}`,
    `  pins: hard ${stats.pins.hard}, extended ${stats.pins.extended} (${pct(stats.pins.ratio)} of records)`,
    `  duplicate groups at ${stats.duplicates.threshold}: ${stats.duplicates.groups}` +
      ` (${stats.duplicates.recordsInGroups} records, largest group ${stats.duplicates.largestGroup})`,
  ];
  return lines;
}
