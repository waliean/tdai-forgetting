/**
 * Shared types for the forgetting engine.
 *
 * The engine is deliberately storage-agnostic: it never touches sqlite directly.
 * Callers hand it plain records (read from l1_records) and it hands back decisions
 * (which records to demote, which to retire). This keeps the scoring logic
 * testable without a database and lets the same engine run against the live tdai
 * schema, a snapshot, or a fixture.
 */

/** Lifecycle state of a memory record. Mirrors a column added by the migration. */
export type MemoryState = "active" | "archived" | "retired" | "deleted";

/**
 * How firmly a record is protected.
 *
 * "hard"     - exempt from every decay and eviction path.
 * "extended" - decays, but against a stretched half-life. For records where the
 *              user asked for durability without literally asking for forever.
 */
export type PinKind = "hard" | "extended";

/**
 * A memory record as the engine sees it.
 *
 * Field names follow tdai's l1_records column names on purpose: the adapter that
 * reads the table maps 1:1, and a reviewer can diff this against the real schema
 * without a translation table in their head.
 */
export interface MemoryRecord {
  record_id: string;
  content: string;
  type: string;
  /** tdai convention: -1 marks a global instruction that must never be forgotten. */
  priority: number;
  scene_name: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  /** ISO timestamp of first capture. */
  created_time: string;
  /** ISO timestamp of last dedup merge or update. Not a proxy for access. */
  updated_time: string;
  /** ISO timestamp of the last retrieval that returned this record. */
  last_access_time?: string | null;
  /** Number of retrievals that returned this record. */
  access_count?: number;
  state?: MemoryState;
  /** Set by the pin resolver. */
  pinned?: boolean;
  pin_kind?: PinKind;
  /** Reason the pin resolver fired, for audit output. */
  pin_reason?: string;
  /** Stretch factor applied to the half-life when pin_kind is "extended". */
  pin_half_life_multiplier?: number;
  /**
   * Importance in [0, 1], derived from tdai's integer priority (0-100).
   * Separate from priority so the score formula reads in one unit.
   */
  importance?: number;
  metadata_json?: string;
}

export interface DecayConfig {
  /** Days after which an untouched memory keeps half its decay weight. */
  halfLifeDays: number;
  /**
   * Floor applied to the decay term. mem0 uses 0.3; the point is that a
   * stale-but-relevant record can still be retrieved, only ranked lower.
   */
  floor: number;
  /** Weight of decay in the retention mean. */
  decayWeight: number;
  /** Weight of the usage term. */
  usageWeight: number;
  /** Access count that earns roughly 63% of the usage bonus. */
  usageSaturation: number;
  /** Weight of the importance term. */
  importanceWeight: number;
  /**
   * Minimum share of the corpus carrying access history before decay is allowed to
   * reorder results. 0 disables the gate (decay always on).
   */
  minTrackingCoverage: number;
}

export interface EvictionConfig {
  /** Soft cap on active L1 records. 0 disables quota-driven eviction. */
  quota: number;
  /**
   * Live records are never evicted below this count, whatever the quota says.
   * Mirrors tdai's MIN_RETAIN gate: a guard rail, not a policy.
   */
  minRetain: number;
  /** Records scoring below this move to the archive tier. */
  archiveThreshold: number;
  /** Records scoring below this, and older than minAgeDays, are retired. */
  retireThreshold: number;
  /** Age gate for retire, in days: a burst of new low-score records should not be retired on day one. */
  minAgeDays: number;
}

export interface ForgettingConfig {
  decay: DecayConfig;
  eviction: EvictionConfig;
  /** Optional clock injection for tests. */
  now?: () => Date;
}

export interface ScoredRecord {
  record: MemoryRecord;
  baseScore: number;
  decayFactor: number;
  usageFactor: number;
  importanceFactor: number;
  finalScore: number;
  ageDays: number;
}

export type Decision = "keep" | "archive" | "retire";

export interface EvictionDecision {
  record: MemoryRecord;
  score: number;
  decision: Decision;
  reason: string;
}

export interface ForgettingPlan {
  generatedAt: string;
  total: number;
  pinned: number;
  kept: number;
  archived: number;
  retired: number;
  decisions: EvictionDecision[];
  /** Records that survived every rule. */
  survivors: string[];
}
