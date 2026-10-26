/**
 * Does promoting pins to the top of the ranking help or hurt?
 *
 * The first version of the re-rank gave a hard pin the ceiling multiplier (1.5),
 * reasoning that a neutral 1.0 would let recently-recalled records slide above it.
 * "Never forget" felt like it should also mean "rank high". That intuition is worth
 * exactly as much as its measurement, so this script measures it.
 *
 * Three pin policies, same corpus, same queries, same embedding ground truth:
 *
 *   neutral    multiplier 1.0 — immune to decay, no bonus
 *   ceiling    multiplier 1.5 — promoted to the top of the multiplier range
 *   excluded   pinned records removed from the candidate pool, the mirror-image
 *              mistake, to show what happens when the protection is too strong
 */

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { loadVectorIndex, embedWithOllama, cosine } from "./vector-index.ts";
import { applyPins } from "../src/pin.ts";
import { DEFAULT_DECAY, rerankHits } from "../src/scoring.ts";
import { jaccard, shingles } from "../src/redundancy.ts";
import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import type { MemoryRecord } from "../src/types.ts";

const RRF_K = 60;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function readScenes(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT scene_name, COUNT(*) AS c FROM l1_records GROUP BY scene_name HAVING c >= 4 ORDER BY c DESC LIMIT 60")
        .all() as unknown as Array<{ scene_name: string }>
    ).map((r) => r.scene_name);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: "string" },
      queries: { type: "string", default: "20" },
      k: { type: "string", default: "10" },
      "truth-budget": { type: "string", default: "30" },
    },
  });
  const dbPath = values.db as string;
  if (!dbPath) throw new Error("--db is required");

  const index = loadVectorIndex(dbPath);
  const records = applyPins(loadRecords(dbPath));
  // Report the two levels separately: only hard pins are subject to the policy being
  // compared here, and a single blended number would overstate the affected share.
  const hardShare = records.filter((r) => r.pin_kind === "hard").length / records.length;
  const extendedShare = records.filter((r) => r.pin_kind === "extended").length / records.length;
  const embedded = new Set(index.ids);
  const pool = records.filter((r) => embedded.has(r.record_id));
  const byId = new Map(records.map((r) => [r.record_id, r]));

  const k = Number(values.k);
  const truthBudget = Number(values["truth-budget"]);
  const scenes = readScenes(dbPath).slice(0, Number(values.queries));

  const policies: Record<string, (hit: { record: MemoryRecord; score: number }, multiplier: number) => number> = {
    neutral: (_hit, multiplier) => multiplier,
    ceiling: (hit, multiplier) => (hit.record.pinned && hit.record.pin_kind === "hard" ? 1.5 : multiplier),
    excluded: (hit, multiplier) => (hit.record.pinned && hit.record.pin_kind === "hard" ? 0 : multiplier),
  };

  const rows: Array<Record<string, number | string>> = [];

  for (const [label, adjust] of Object.entries(policies)) {
    const precision: number[] = [];
    const pinRecall: number[] = [];
    const relevantPins: number[] = [];

    for (const scene of scenes) {
      const embedding = await embedWithOllama(scene);
      const ranked = index.ids
        .map((id, j) => ({ id, score: cosine(index.vectors, embedding, index.dimension, j * index.dimension, 0) }))
        .sort((a, b) => b.score - a.score);
      const truth = new Set(ranked.slice(0, truthBudget).map((h) => h.id));

      const qs = shingles(scene, 2);
      const lex = pool
        .map((record) => ({ record, score: jaccard(qs, shingles(record.content, 2)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k * 4);
      const vec = index.ids
        .map((id, j) => ({ id, score: cosine(index.vectors, embedding, index.dimension, j * index.dimension, 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k * 4)
        .map((h) => ({ record: byId.get(h.id)!, score: h.score }))
        .filter((h) => !!h.record);

      const fused = new Map<string, { record: MemoryRecord; score: number }>();
      for (const list of [lex, vec]) {
        list.forEach((hit, rank) => {
          const weight = 1 / (RRF_K + rank + 1);
          const existing = fused.get(hit.record.record_id);
          if (existing) existing.score += weight;
          else fused.set(hit.record.record_id, { record: hit.record, score: weight });
        });
      }

      // Cold-start snapshot: hold the gate open so the pin policy is what varies.
      const reranked = rerankHits([...fused.values()], { ...DEFAULT_DECAY, minTrackingCoverage: 0 }, new Date(), {
        decay: true,
      });
      const adjusted = reranked
        .map((hit) => ({ record: hit.record, score: adjust(hit, hit.multiplier) * hit.score }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      precision.push(adjusted.filter((h) => truth.has(h.record.record_id)).length / Math.max(adjusted.length, 1));
      pinRecall.push(adjusted.some((h) => h.record.pinned) ? 1 : 0);
      relevantPins.push(adjusted.filter((h) => h.record.pinned && truth.has(h.record.record_id)).length);
    }

    rows.push({
      policy: label,
      "precision@k": mean(precision),
      "pinRecall@k": mean(pinRecall),
      "relevantPins@k": mean(relevantPins),
    });
  }

  process.stdout.write(
    `\nrecords=${records.length}, hard pins=${(hardShare * 100).toFixed(0)}%, extended pins=${(extendedShare * 100).toFixed(0)}%, ` +
      `queries=${scenes.length}, k=${k}, truth budget=${truthBudget}\n\n`,
  );
  process.stdout.write("policy     precision@k  pinRecall@k  relevantPins@k\n");
  for (const row of rows) {
    process.stdout.write(
      String(row.policy).padEnd(11) +
        Number(row["precision@k"]).toFixed(3).padEnd(13) +
        Number(row["pinRecall@k"]).toFixed(3).padEnd(13) +
        Number(row["relevantPins@k"]).toFixed(2) +
        "\n",
    );
  }
}

void main();
