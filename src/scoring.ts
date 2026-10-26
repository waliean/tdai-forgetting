/**
 * Retention scoring.
 *
 * Three signals, combined as a weighted mean over the signals that are actually
 * present:
 *
 *   retention = (w_imp * importance + w_dec * decay + w_use * usage)
 *             / (w_imp + w_dec + w_use)          -- usage only when it exists
 *
 * The decay term is the half-life model MemOS ships in 12 lines of TypeScript:
 *   decay = floor + (1 - floor) * 2^(-age / halfLife)
 * The floor (0.3, same value mem0 documents) keeps a stale-but-relevant memory
 * retrievable. Forgetting here means "rank lower", never "cannot be found".
 *
 * The usage term uses diminishing returns, as MemoryOS does for its mid-term heat
 * score: 1 - exp(-access / saturation). The gap between zero and three recalls
 * should matter more than the gap between thirty and thirty-three.
 *
 * Why the denominator is dynamic: on a database that has never recorded access
 * (every tdai database today), usage is zero for every row. Dividing by the full
 * weight sum would then subtract a constant from every score, compressing the
 * whole distribution into a narrow band and making thresholds behave like
 * arbitrary cutoffs on a shifted scale. Renormalising over available signals keeps
 * the score interpretable as "mean quality across what we can measure", and the
 * moment access tracking starts, the usage term joins the average on its own.
 */

import { isHardPinned } from "./pin.ts";
import type { DecayConfig, MemoryRecord, ScoredRecord } from "./types.ts";

export const DEFAULT_DECAY: DecayConfig = {
  halfLifeDays: 30,
  floor: 0.3,
  usageWeight: 0.3,
  importanceWeight: 0.4,
  decayWeight: 0.3,
  usageSaturation: 5,
  minTrackingCoverage: 0.1,
};

const MS_PER_DAY = 86_400_000;

/** Bounds on the retrieval multiplier. Below MIN a memory would effectively vanish. */
const MIN_MULTIPLIER = 0.3;
const MAX_MULTIPLIER = 1.5;
/** How much a full usage score (1.0) adds on top of the decay term. */
const USAGE_BOOST = 0.5;

/**
 * Fraction of a corpus that has any access history, in [0, 1].
 *
 * The gate below exists because of a measurement, not a hunch: on a real corpus
 * with no access tracking, age-based demotion cost 7 points of precision@10 against
 * an embedding-derived ground truth (bench/experiments.ts, cold-start). Recency is
 * only a proxy for usefulness when someone is actually recording use.
 */
export function trackingCoverage(records: MemoryRecord[]): number {
  if (records.length === 0) return 0;
  let tracked = 0;
  for (const record of records) if (hasAccessSignal(record)) tracked++;
  return tracked / records.length;
}

/**
 * Whether decay should influence ranking at all.
 *
 * Below the threshold the corpus is in cold start: no retrieval has ever been
 * recorded, so "old" carries no information about "less useful". Ranking stays
 * pure fusion until there is evidence to weigh. This is the difference between a
 * policy with a measured cost and a policy that assumes its own premise.
 */
export function decayEnabled(coverage: number, cfg: DecayConfig = DEFAULT_DECAY): boolean {
  return coverage >= cfg.minTrackingCoverage;
}

/**
 * Anchor for "how old is this memory".
 *
 * Preference order matters. Using updated_time alone is the bug in tdai's own
 * cleaner: dedup merges refresh it on every write, so the longest-lived memories
 * look permanently fresh. Access time is the honest signal when it exists; when it
 * does not, updated_time still beats created_time because a merge means the
 * content was actually rewritten.
 */
export function ageAnchor(record: MemoryRecord): string {
  return record.last_access_time || record.updated_time || record.created_time;
}

export function ageInDays(record: MemoryRecord, now: Date): number {
  const anchor = Date.parse(ageAnchor(record));
  if (Number.isNaN(anchor)) return 0;
  const age = (now.getTime() - anchor) / MS_PER_DAY;
  return age > 0 ? age : 0;
}

/** Half-life decay in [floor, 1]. Never zero. */
export function decayFactor(ageDays: number, cfg: DecayConfig = DEFAULT_DECAY): number {
  const halfLife = Math.max(cfg.halfLifeDays, 1e-6);
  const raw = Math.pow(2, -ageDays / halfLife);
  return cfg.floor + (1 - cfg.floor) * raw;
}

/** Diminishing returns on access count, in [0, 1). */
export function usageFactor(accessCount: number, cfg: DecayConfig = DEFAULT_DECAY): number {
  if (!Number.isFinite(accessCount) || accessCount <= 0) return 0;
  return 1 - Math.exp(-accessCount / Math.max(cfg.usageSaturation, 1e-6));
}

/**
 * Whether access data exists for this record.
 *
 * "Tracked" is not the same as "recalled once": a record with count 0 but a
 * last_access_time has been through the tracker, so its zero is real evidence.
 * A record with neither has never been observed and must not be penalised for a
 * signal nobody collected.
 */
export function hasAccessSignal(record: MemoryRecord): boolean {
  if ((record.access_count ?? 0) > 0) return true;
  return !!record.last_access_time;
}

/** tdai stores priority as 0-100, or -1 for a global instruction. Map to [0, 1]. */
export function importanceFromPriority(priority: number): number {
  if (priority === -1) return 1;
  if (!Number.isFinite(priority)) return 0.5;
  return Math.min(1, Math.max(0, priority / 100));
}

export function scoreRecord(
  record: MemoryRecord,
  cfg: DecayConfig = DEFAULT_DECAY,
  now: Date = new Date(),
): ScoredRecord {
  const ageDays = ageInDays(record, now);
  // A soft-pinned record decays against a stretched half-life rather than being
  // exempt: "remember this a very long time" is not "never reconsider this".
  const effectiveCfg =
    record.pin_kind === "extended"
      ? { ...cfg, halfLifeDays: cfg.halfLifeDays * (record.pin_half_life_multiplier ?? 12) }
      : cfg;

  const d = decayFactor(ageDays, effectiveCfg);
  const u = usageFactor(record.access_count ?? 0, cfg);
  const i = record.importance ?? importanceFromPriority(record.priority);

  let weighted = cfg.importanceWeight * i + cfg.decayWeight * d;
  let totalWeight = cfg.importanceWeight + cfg.decayWeight;
  if (hasAccessSignal(record)) {
    weighted += cfg.usageWeight * u;
    totalWeight += cfg.usageWeight;
  }
  const finalScore = clamp01(weighted / totalWeight);

  return {
    record,
    baseScore: finalScore,
    decayFactor: d,
    usageFactor: u,
    importanceFactor: i,
    finalScore,
    ageDays,
  };
}

/**
 * Re-rank search hits, mem0-style: multiply the retrieval score by a bounded
 * factor, never drop candidates. A record at the decay floor still scores 0.3x
 * rather than vanishing, so recall can change order but not lose the tail.
 *
 * Range is [floor, 1.5]: usage can push a hot memory up, decay can pull a cold one
 * down, and the 1.5 cap stops one popular record from burying everything else.
 */
export function searchMultiplier(
  record: MemoryRecord,
  cfg: DecayConfig = DEFAULT_DECAY,
  now: Date = new Date(),
  decayOn = true,
): number {
  const effectiveCfg =
    record.pin_kind === "extended"
      ? { ...cfg, halfLifeDays: cfg.halfLifeDays * (record.pin_half_life_multiplier ?? 12) }
      : cfg;
  // With decay off, only usage can move a record: a recently recalled memory still
  // gets its boost, an old one is not punished for being old.
  const d = decayOn ? decayFactor(ageInDays(record, now), effectiveCfg) : 1;
  const u = hasAccessSignal(record) ? usageFactor(record.access_count ?? 0, cfg) : 0;
  // A hard pin ranks as if it were permanently fresh: immune to age, not promoted.
  //
  // An earlier version returned the 1.5 ceiling here, reasoning that a neutral 1.0
  // would let recently-recalled records slide above it. Measured against an
  // embedding-derived ground truth on a real snapshot, that ceiling cost 5 points of
  // precision@10 (0.955 → 0.905) by pushing mediocre pinned records above genuinely
  // better matches. "Never forget" is not "always first": a memory the user recalls
  // twenty times should outrank a pinned one they never touch.
  if (isHardPinned(record)) return 1;
  const raw = d + USAGE_BOOST * u;
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, raw));
}

export interface RerankOptions {
  /** Candidate pool is trimmed to this after reranking; 0 or absent means no trimming. */
  limit?: number;
  /** Whether the age term participates. Callers pass `decayEnabled(coverage)`. */
  decay?: boolean;
}

/**
 * Alias used by the analysis scripts: "how much was this record demoted" reads
 * better at a call site than "what is its search multiplier".
 */
export const demoteWeight = searchMultiplier;

/**
 * Apply the multiplier to already-scored search hits.
 *
 * Order of operations follows mem0's documented pipeline: over-retrieve, scale,
 * sort on the unscaled product, then clamp the reported score back into [0, 1] so
 * the public API contract does not change shape.
 */
export function rerankHits<T extends { record: MemoryRecord; score: number }>(
  hits: T[],
  cfg: DecayConfig = DEFAULT_DECAY,
  now: Date = new Date(),
  opts: RerankOptions = {},
): Array<T & { multipliedScore: number; reportedScore: number; multiplier: number }> {
  // Decide once for the whole result set: a per-hit decision would split one ranking
  // between two policies and produce an order that means nothing.
  const decayOn = opts.decay ?? true;
  const scaled = hits.map((hit) => {
    const multiplier = searchMultiplier(hit.record, cfg, now, decayOn);
    return {
      ...hit,
      multipliedScore: hit.score * multiplier,
      reportedScore: clamp01(hit.score * multiplier),
      multiplier,
    };
  });

  scaled.sort((a, b) => b.multipliedScore - a.multipliedScore);
  return opts.limit && opts.limit > 0 ? scaled.slice(0, opts.limit) : scaled;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
