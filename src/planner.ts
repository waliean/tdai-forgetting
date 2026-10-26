/**
 * Eviction planning.
 *
 * The planner answers one question: given the current corpus and a policy, which
 * records move to the archive tier, which get retired, and why. It produces a plan,
 * never side effects. Applying the plan is a separate, reviewable step (see
 * applier.ts). A forgetting system that edits production on the first pass cannot
 * be audited after the fact.
 *
 * Decision order:
 *   1. Pins are resolved first and cost nothing to respect. Hard pins never enter
 *      any eviction list; extended pins enter it with a stretched half-life.
 *   2. Absolute thresholds retire ancient, low-value records. They run before
 *      redundancy because a record that is both stale and duplicated should be
 *      explained by its age, not by its neighbour.
 *   3. Redundancy resolves duplicate groups: the worse copy is archived, the best
 *      one stays. This runs before quota so that a quota cannot force out unique
 *      facts while a duplicate of another record survives.
 *   4. The quota, if set, evicts lowest-score-first until the corpus fits. Pinned
 *      records are skipped, so the effective quota is the quota minus pins, and that
 *      is stated in the run notes rather than silently applied.
 *
 * Every decision carries a machine-readable reason so the audit log answers "why"
 * without a human re-deriving it from the score.
 */

import { applyPins, unprotectedPermanence, type PinOptions, DEFAULT_PIN_OPTIONS } from "./pin.ts";
import { DEFAULT_DECAY, decayEnabled, scoreRecord, trackingCoverage } from "./scoring.ts";
import { DEFAULT_CLUSTER_OPTIONS, findRedundancyClusters, type ClusterOptions } from "./redundancy.ts";
import type {
  DecayConfig,
  EvictionConfig,
  EvictionDecision,
  ForgettingConfig,
  ForgettingPlan,
  MemoryRecord,
  ScoredRecord,
} from "./types.ts";

export const DEFAULT_EVICTION: EvictionConfig = {
  quota: 0,
  minRetain: 100,
  archiveThreshold: 0.45,
  retireThreshold: 0.25,
  minAgeDays: 14,
};

export interface PlanOptions {
  pin?: PinOptions;
  cluster?: ClusterOptions;
  /** Cap on how many records one plan may demote. Guards against a bad config wiping the corpus. */
  maxEvictionsPerRun?: number;
}

export interface ForgettingPlanReport extends ForgettingPlan {
  /** Permanence-worded records that no pin rule protected. Empty under default rules. */
  reviewCandidates: Array<{ record_id: string; type: string; content: string }>;
  clusters: Array<{ leadId: string; memberIds: string[]; minSimilarity: number }>;
  /** Score distribution, so a reviewer sees whether a threshold sits in the tail or the bulk. */
  scoreDistribution: { p10: number; p25: number; p50: number; p75: number; p90: number; min: number; max: number };
  /**
   * Share of records carrying access history. Below the configured minimum, age is
   * not evidence of disuse and the plan says so instead of pretending otherwise.
   */
  trackingCoverage: number;
  decayActive: boolean;
  config: { decay: DecayConfig; eviction: EvictionConfig };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function buildForgettingPlan(
  records: MemoryRecord[],
  config: ForgettingConfig,
  opts: PlanOptions = {},
): ForgettingPlanReport {
  const now = config.now ? config.now() : new Date();
  const decay = { ...DEFAULT_DECAY, ...config.decay };
  const eviction = { ...DEFAULT_EVICTION, ...config.eviction };
  const pinOpts = opts.pin ?? DEFAULT_PIN_OPTIONS;
  const clusterOpts = opts.cluster ?? DEFAULT_CLUSTER_OPTIONS;
  const maxEvictions = opts.maxEvictionsPerRun ?? Number.POSITIVE_INFINITY;

  const pinned = applyPins(records, pinOpts);
  const active = pinned.filter((r) => (r.state ?? "active") === "active");

  // The coverage gate applies to eviction exactly as it applies to ranking: with no
  // access data, "old" cannot justify demotion. Age still gates retirement, but it
  // must not be the only thing a record is judged on.
  const coverage = trackingCoverage(active);
  const decayOn = decayEnabled(coverage, decay);
  const scoringDecay = decayOn ? decay : { ...decay, decayWeight: 0, floor: 1 };

  const scored: ScoredRecord[] = active.map((r) => scoreRecord(r, scoringDecay, now));
  const scoreById = new Map(scored.map((s) => [s.record.record_id, s.finalScore]));

  const clusters = findRedundancyClusters(active, clusterOpts, scoreById);
  const redundantNonLeads = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) {
      if (id !== cluster.leadId) redundantNonLeads.set(id, cluster.leadId);
    }
  }

  const decisions: EvictionDecision[] = [];
  const survivors: string[] = [];
  const decided = new Set<string>();
  let evicted = 0;
  const canEvict = (): boolean => evicted < maxEvictions;

  const markKeep = (s: ScoredRecord, reason: string): void => {
    decisions.push({ record: s.record, score: s.finalScore, decision: "keep", reason });
    survivors.push(s.record.record_id);
    decided.add(s.record.record_id);
  };
  const markEvict = (s: ScoredRecord, decision: "archive" | "retire", reason: string): void => {
    decisions.push({ record: s.record, score: s.finalScore, decision, reason });
    decided.add(s.record.record_id);
    evicted++;
  };

  // ── Pass 0: hard pins ──
  for (const s of scored) {
    if (s.record.pinned && s.record.pin_kind === "hard") markKeep(s, `pinned (hard): ${s.record.pin_reason}`);
  }

  // ── Pass 1: absolute thresholds ──
  for (const s of scored) {
    if (decided.has(s.record.record_id)) continue;
    const elderly = s.ageDays >= eviction.minAgeDays;
    if (canEvict() && s.finalScore < eviction.retireThreshold && elderly) {
      markEvict(
        s,
        "retire",
        `score ${s.finalScore.toFixed(3)} < retire ${eviction.retireThreshold}; age ${s.ageDays.toFixed(0)}d`,
      );
      continue;
    }
    if (canEvict() && s.finalScore < eviction.archiveThreshold) {
      markEvict(s, "archive", `score ${s.finalScore.toFixed(3)} < archive ${eviction.archiveThreshold}`);
    }
  }

  // ── Pass 2: redundancy ──
  for (const s of scored) {
    if (decided.has(s.record.record_id)) continue;
    const lead = redundantNonLeads.get(s.record.record_id);
    if (lead && canEvict()) markEvict(s, "archive", `redundant with ${lead}`);
  }

  // ── Pass 3: quota ──
  const stillActive = scored.filter((s) => !decided.has(s.record.record_id));
  const quota = eviction.quota > 0 ? Math.max(eviction.quota, eviction.minRetain) : 0;
  if (quota > 0 && stillActive.length > quota) {
    const budget = stillActive.length - quota;
    const order = [...stillActive].sort((a, b) => a.finalScore - b.finalScore);
    let used = 0;
    for (const s of order) {
      if (used >= budget || !canEvict()) break;
      if (s.record.pin_kind === "hard") continue;
      markEvict(s, "archive", `quota ${quota}: bottom-ranked (${used + 1}/${budget})`);
      used++;
    }
  }

  // ── Pass 4: everything else stays ──
  for (const s of scored) {
    if (decided.has(s.record.record_id)) continue;
    const reason = s.record.pinned ? `pinned (${s.record.pin_kind}): ${s.record.pin_reason}` : "retained";
    markKeep(s, reason);
  }

  const archived = decisions.filter((d) => d.decision === "archive").length;
  const retired = decisions.filter((d) => d.decision === "retire").length;
  const sortedScores = scored.map((s) => s.finalScore).sort((a, b) => a - b);

  return {
    generatedAt: now.toISOString(),
    total: records.length,
    pinned: pinned.filter((r) => r.pinned).length,
    kept: survivors.length,
    archived,
    retired,
    decisions,
    survivors,
    reviewCandidates: unprotectedPermanence(pinned).map((r) => ({
      record_id: r.record_id,
      type: r.type,
      content: r.content.slice(0, 160),
    })),
    clusters: clusters.map((c) => ({ leadId: c.leadId, memberIds: c.memberIds, minSimilarity: c.minSimilarity })),
    scoreDistribution: {
      p10: percentile(sortedScores, 0.1),
      p25: percentile(sortedScores, 0.25),
      p50: percentile(sortedScores, 0.5),
      p75: percentile(sortedScores, 0.75),
      p90: percentile(sortedScores, 0.9),
      min: sortedScores[0] ?? 0,
      max: sortedScores[sortedScores.length - 1] ?? 0,
    },
    trackingCoverage: coverage,
    decayActive: decayOn,
    config: { decay, eviction },
  };
}
