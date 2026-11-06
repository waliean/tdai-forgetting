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
 *   1.5 Invalidation comes next: a conclusion that has been contradicted does not get
 *      to hold a slot just because it once scored well. It runs BEFORE the thresholds
 *      on purpose — a record can be old AND invalid, and "invalid" is the more
 *      specific explanation. It runs AFTER the pins because a pin is a human saying
 *      "keep this", and when a human says both, the explicit instruction wins.
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
  // Bottom 10% of the corpus's own scores, but only while decay is on. See the field doc.
  retirePercentile: 0.1,
  minAgeDays: 14,
};

export interface PlanOptions {
  pin?: PinOptions;
  cluster?: ClusterOptions;
  /** Cap on how many records one plan may demote. Guards against a bad config wiping the corpus. */
  maxEvictionsPerRun?: number;
}

export interface ForgettingPlanReport extends ForgettingPlan {
  /** Records archived because they were contradicted. A subset of `archived`. */
  invalidated: number;
  /**
   * Records that are BOTH hard-pinned and invalid. The pin wins, so nothing is
   * evicted — and the combination is surfaced rather than resolved silently, because
   * "never forget this" and "this is no longer true" cannot both be satisfied and only
   * a person can decide which instruction they meant.
   */
  pinInvalidConflicts: Array<{ record_id: string; type: string; invalid_at: string; pin_reason: string }>;
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
  /**
   * The score below which an old record is retired, after resolution.
   *
   * Reported because it is no longer simply `config.eviction.retireThreshold`: with a
   * percentile configured and the decay gate open it is the corpus's own bottom slice.
   * An operator comparing two runs needs to see which number actually applied.
   */
  retireCut: number;
  config: { decay: DecayConfig; eviction: EvictionConfig };
}

/**
 * The audit reason for an invalidation eviction.
 *
 * One format, built in one place, because the review criterion is that a reviewer can
 * grep the audit for invalidations and recognise every one of them. The successor is
 * spelled out when there is one — "superseded by nothing" is a real case (a cancelled
 * project) and must not read like a missing field.
 */
function invalidReason(record: MemoryRecord): string {
  const since = record.invalid_at ?? "unknown";
  const by = record.superseded_by ? `superseded by ${record.superseded_by}` : "no successor";
  return `invalid since ${since}, ${by}`;
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

  // One sorted copy feeds both the retire cutoff and the reported distribution.
  const sortedScores = scored.map((s) => s.finalScore).sort((a, b) => a - b);
  // Percentile only while the gate is open: with no access data the score is importance
  // alone, so "bottom tenth" would mean "least important", not "least useful".
  const retireCut =
    decayOn && eviction.retirePercentile > 0
      ? percentile(sortedScores, eviction.retirePercentile)
      : eviction.retireThreshold;

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

  // ── Pass 0.5: invalidation ──
  //
  // Reads the field, does not judge it. "Who decided this record was superseded" is
  // answered by the supersede command (or, behind its own gate, the LLM criteria) —
  // the planner only acts on what is already recorded. A planner that inferred
  // supersession would be the heuristic this whole canvas exists to replace.
  //
  // Archive, not retire: a contradicted conclusion is exactly the kind of thing worth
  // keeping. "We thought so, then we found out otherwise" is history, and history
  // needs to stay readable. Retiring it would put it past the archive tier where a
  // later reader stops looking.
  const pinInvalidConflicts: ForgettingPlanReport["pinInvalidConflicts"] = [];
  for (const s of scored) {
    if (!s.record.invalid_at) continue;
    // The conflict check comes BEFORE the decided-guard, and that order is the whole
    // point: Pass 0 has already decided every hard pin, so a guard-first loop can never
    // reach one. Written guard-first — which is how it was written the first time —
    // this block is dead code that reports zero conflicts forever while looking right.
    // The planner test "a hard pin beats invalidation, and the conflict is reported"
    // fails if this order is swapped back; it is the only thing that catches it.
    if (s.record.pinned && s.record.pin_kind === "hard") {
      pinInvalidConflicts.push({
        record_id: s.record.record_id,
        type: s.record.type,
        invalid_at: s.record.invalid_at,
        pin_reason: s.record.pin_reason ?? "",
      });
      continue;
    }
    if (!canEvict()) continue;
    markEvict(s, "archive", invalidReason(s.record));
  }

  // ── Pass 1: absolute thresholds ──
  for (const s of scored) {
    if (decided.has(s.record.record_id)) continue;
    const elderly = s.ageDays >= eviction.minAgeDays;
    if (canEvict() && s.finalScore < retireCut && elderly) {
      markEvict(
        s,
        "retire",
        `score ${s.finalScore.toFixed(3)} < retire ${retireCut.toFixed(3)}; age ${s.ageDays.toFixed(0)}d`,
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
  // Counted from the decisions themselves, not from a counter incremented in the pass:
  // a reviewer asking "how many of these archives were invalidations" should get the
  // answer from the same list the audit is built from.
  const invalidated = decisions.filter((d) => d.decision === "archive" && d.reason.startsWith("invalid since ")).length;

  return {
    generatedAt: now.toISOString(),
    total: records.length,
    pinned: pinned.filter((r) => r.pinned).length,
    kept: survivors.length,
    archived,
    retired,
    invalidated,
    pinInvalidConflicts,
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
    retireCut,
    config: { decay, eviction },
  };
}
