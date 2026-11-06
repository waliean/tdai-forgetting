/**
 * Redundancy clustering.
 *
 * The live corpus shows the same failure over and over: several records say
 * almost the same thing ("用户要求 AI 永久记住 …" for the same research note, one
 * per migration run). They are not exact duplicates, so tdai's dedup leaves them
 * alone, and retrieval returns five near-identical hits that crowd out the one
 * fact the user actually needed.
 *
 * Eviction should prefer removing a near-duplicate over removing a unique
 * record of the same age and score. This module does the cheap version of that:
 * character-shingle Jaccard similarity, no embeddings, no dependencies. It runs
 * in O(n^2) worst case, which is fine for the sizes L1 reaches (thousands, not
 * millions) and keeps the plan reproducible without an embedding provider.
 */

import type { MemoryRecord } from "./types.ts";

/** Normalize text so shingles survive whitespace, punctuation and casing changes. */
export function normalizeForShingles(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、；：！？,.;:!?"'`()\[\]{}<>《》「」『』…—-]/g, "");
}

export function shingles(text: string, size = 4): Set<string> {
  const norm = normalizeForShingles(text);
  const out = new Set<string>();
  if (norm.length <= size) {
    if (norm.length > 0) out.add(norm);
    return out;
  }
  for (let i = 0; i + size <= norm.length; i++) {
    out.add(norm.slice(i, i + size));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export interface RedundancyCluster {
  /** Canonical member: the highest-scoring record in the cluster, kept on eviction. */
  leadId: string;
  memberIds: string[];
  /**
   * Similarity floor inside the cluster (min pairwise similarity).
   *
   * For a pair compared by the block path this is block coverage, not Jaccard — the two
   * are different scales and only comparable within one mode.
   */
  minSimilarity: number;
}

export interface ClusterOptions {
  /** Jaccard threshold above which two records are considered the same fact. */
  threshold: number;
  /** Skip records shorter than this; short text produces noisy shingle sets. */
  minLength: number;
  /** Only cluster within the same type; instruction and persona rarely duplicate each other. */
  sameTypeOnly: boolean;
  /**
   * Above this content length, compare by block coverage instead of whole-text Jaccard.
   *
   * 4-gram Jaccard falls as text grows even when the content is the same fact: measured
   * on the long-text corpus, a fixed 100-character prefix scores 0.506 against a
   * 200-character document and 0.111 against a 1200-character one. No single threshold
   * serves both a 70-character note and a 1200-character document, so length decides
   * which comparison runs. 0 disables the block path entirely.
   */
  blockMinLength: number;
  /** Per-block similarity at or above which two blocks count as the same sentence. */
  blockSimilarity: number;
  /** Share of the shorter document's blocks that must find a match for the pair to merge. */
  blockCoverage: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  // 0.6 was the value copied from the published examples; the sweep moved it to the
  // middle of the safe band instead. At 0.4 the synthetic corpus loses 93.6% of its
  // records to duplicate collapsing and the long-text one 81.7%; at 0.6 that is
  // already 35.8% and 0%, and 0.6 is only 0.2 above the cliff. 0.7 keeps the duplicate
  // count falling (35.8% -> 26.2%) within the band from 0.6 to 0.8, so the shipped
  // default is no longer one nudge away from collapsing a corpus.
  // See docs/experiments/参数敏感度-2026-11-06.md.
  threshold: 0.7,
  minLength: 40,
  sameTypeOnly: true,
  // 400 is above the length where whole-text Jaccard stops being usable and below the
  // shortest document in the long-text corpus (540 for a brief). Measured on that
  // corpus: block coverage found 60/60 true pairs with 0/7,080 false merges; the
  // length-tiered threshold found the same 60 but merged 9.4% of unrelated pairs.
  // See docs/design/长文本相似度-2026-11-06.md.
  blockMinLength: 400,
  blockSimilarity: 0.8,
  blockCoverage: 0.8,
};

/** Sentence-ish blocks: split on terminal punctuation, drop fragments too short to match. */
function splitBlocks(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/)
    .map((block) => block.trim())
    .filter((block) => block.length >= 12);
}

/**
 * Share of `a`'s blocks that find a near-identical block in `b`.
 *
 * Jaccard asks "how much of the union do these share", which punishes `b` for being
 * longer than `a`. Coverage asks "is each part of `a` present in `b`", which is what a
 * duplicate detector means. A brief statement inside a longer restatement of the same
 * fact scores 1.0 here and about 0.45 under Jaccard.
 */
function blockCoverageOf(a: string, b: string, blockSimilarity: number): number {
  const blocksA = splitBlocks(a);
  const blocksB = splitBlocks(b);
  if (blocksA.length === 0 || blocksB.length === 0) return 0;
  const setsB = blocksB.map((block) => shingles(block, 3));
  let matched = 0;
  for (const block of blocksA) {
    const setA = shingles(block, 3);
    let best = 0;
    for (const setB of setsB) {
      const similarity = jaccard(setA, setB);
      if (similarity > best) best = similarity;
      if (best >= blockSimilarity) break;
    }
    if (best >= blockSimilarity) matched++;
  }
  return matched / blocksA.length;
}

/**
 * Which copy survives a cluster.
 *
 * Pins outrank score, always. A pinned record that loses a duplicate contest gets
 * demoted, which is the one outcome a pin exists to prevent; the copy that
 * survives should be the one the user asked to keep. Only among equally pinned (or
 * equally unpinned) records does the retention score decide.
 */
function pickLead(candidates: MemoryRecord[], scoreById: Map<string, number>): MemoryRecord {
  return [...candidates].sort((a, b) => {
    const pinA = a.pinned ? 1 : 0;
    const pinB = b.pinned ? 1 : 0;
    if (pinB !== pinA) return pinB - pinA;
    const sa = scoreById.get(a.record_id) ?? 0;
    const sb = scoreById.get(b.record_id) ?? 0;
    if (sb !== sa) return sb - sa;
    const ua = a.access_count ?? 0;
    const ub = b.access_count ?? 0;
    if (ub !== ua) return ub - ua;
    return (b.updated_time || "").localeCompare(a.updated_time || "");
  })[0];
}

/**
 * Single-linkage clustering over the similarity graph.
 *
 * Single linkage means A~B and B~C put A, B and C in one cluster even if A and C
 * are borderline. For duplicate cleanup that is the behaviour we want: a chain of
 * reworded copies is still one fact.
 */
export function findRedundancyClusters(
  records: MemoryRecord[],
  opts: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
  scoreById: Map<string, number> = new Map(),
): RedundancyCluster[] {
  const candidates = records.filter(
    (r) => r.content.length >= opts.minLength,
  );
  const sets = candidates.map((r) => shingles(r.content));

  const parent = new Map<string, string>();
  for (const r of candidates) parent.set(r.record_id, r.record_id);

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = id;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const edgeSim = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (opts.sameTypeOnly && a.type !== b.type) continue;

      // Long documents are compared by block coverage, everything else by whole-text
      // Jaccard. The two branches ask different questions, so the length prefilter below
      // is deliberately skipped for the block path: a brief inside a longer restatement
      // is the exact case the prefilter was rejecting (0.43 < 0.7) before Jaccard ran.
      const longEnough = opts.blockMinLength > 0 && (a.content.length >= opts.blockMinLength || b.content.length >= opts.blockMinLength);
      let sim: number;
      if (longEnough) {
        sim = blockCoverageOf(a.content, b.content, opts.blockSimilarity);
        if (sim < opts.blockCoverage) continue;
      } else {
        // Cheap prefilter: wildly different lengths cannot clear the Jaccard bar.
        const lenRatio = Math.min(a.content.length, b.content.length) / Math.max(a.content.length, b.content.length);
        if (lenRatio < opts.threshold) continue;
        sim = jaccard(sets[i], sets[j]);
        if (sim < opts.threshold) continue;
      }
      union(a.record_id, b.record_id);
      edgeSim.set(a.record_id + "|" + b.record_id, sim);
    }
  }

  const groups = new Map<string, MemoryRecord[]>();
  for (const r of candidates) {
    const root = find(r.record_id);
    const list = groups.get(root) ?? [];
    list.push(r);
    groups.set(root, list);
  }

  const clusters: RedundancyCluster[] = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const lead = pickLead(members, scoreById);
    const sorted = [lead, ...members.filter((m) => m.record_id !== lead.record_id)];
    let minSim = 1;
    const ids = sorted.map((r) => r.record_id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const direct = edgeSim.get(ids[i] + "|" + ids[j]) ?? edgeSim.get(ids[j] + "|" + ids[i]);
        if (typeof direct === "number" && direct < minSim) minSim = direct;
      }
    }
    clusters.push({
      leadId: lead.record_id,
      memberIds: ids,
      minSimilarity: minSim === 1 ? 1 : minSim,
    });
  }

  clusters.sort((a, b) => b.memberIds.length - a.memberIds.length);
  return clusters;
}
