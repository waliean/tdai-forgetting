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
  /** Similarity floor inside the cluster (min pairwise similarity). */
  minSimilarity: number;
}

export interface ClusterOptions {
  /** Jaccard threshold above which two records are considered the same fact. */
  threshold: number;
  /** Skip records shorter than this; short text produces noisy shingle sets. */
  minLength: number;
  /** Only cluster within the same type; instruction and persona rarely duplicate each other. */
  sameTypeOnly: boolean;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  threshold: 0.6,
  minLength: 40,
  sameTypeOnly: true,
};

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
      // Cheap prefilter: wildly different lengths cannot clear a 0.6 Jaccard bar.
      const lenRatio = Math.min(a.content.length, b.content.length) / Math.max(a.content.length, b.content.length);
      if (lenRatio < opts.threshold) continue;
      const sim = jaccard(sets[i], sets[j]);
      if (sim >= opts.threshold) {
        union(a.record_id, b.record_id);
        edgeSim.set(a.record_id + "|" + b.record_id, sim);
      }
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
