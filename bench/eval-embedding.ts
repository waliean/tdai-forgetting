/**
 * Independent relevance check.
 *
 * The main benchmark scores relevance by scene label, which is a proxy: it says
 * "same topic", not "actually answers the query". This script measures the same
 * three configurations against a ground truth that does not share machinery with
 * either retrieval path: cosine similarity between the query and each record's
 * stored bge-m3 embedding, computed offline.
 *
 * If a configuration looks better here and worse under the scene proxy, the
 * difference is a real trade-off, not an artefact of the proxy.
 */

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { loadVectorIndex, embedWithOllama, cosine } from "./vector-index.ts";
import { applyPins } from "../src/pin.ts";
import { DEFAULT_DECAY, rerankHits } from "../src/scoring.ts";
import { jaccard, shingles } from "../src/redundancy.ts";
import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import type { MemoryRecord } from "../src/types.ts";

const DUPLICATE_THRESHOLD = 0.6;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

interface Scored {
  record: MemoryRecord;
  score: number;
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
  const byId = new Map(loadRecords(dbPath).map((r) => [r.record_id, r]));
  const records = applyPins([...byId.values()]);

  // Ground truth: only records with a stored vector, i.e. those with an embedding
  // to agree or disagree with. Records without one are excluded from precision so
  // the denominator is stable across configurations.
  const embedded = new Set(index.ids);
  const pool = records.filter((r) => embedded.has(r.record_id));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const scenes = db
    .prepare("SELECT scene_name, COUNT(*) AS c FROM l1_records GROUP BY scene_name HAVING c >= 4 ORDER BY c DESC LIMIT 40")
    .all() as unknown as Array<{ scene_name: string; c: number }>;
  db.close();

  const truthBudget = Number(values["truth-budget"]);
  const k = Number(values.k);
  const queryCount = Math.min(Number(values.queries), scenes.length);
  const truthSizes: Array<{ scene: string; size: number; floor: number }> = [];

  const results: Record<string, { precision: number; recall: number; dupShare: number; pinRecall: number }> = {
    baseline: { precision: 0, recall: 0, dupShare: 0, pinRecall: 0 },
    decay: { precision: 0, recall: 0, dupShare: 0, pinRecall: 0 },
    forgetting: { precision: 0, recall: 0, dupShare: 0, pinRecall: 0 },
  };
  const perConfig: Record<string, Array<{ p: number; r: number; d: number; pin: number }>> = {
    baseline: [],
    decay: [],
    forgetting: [],
  };

  for (let qi = 0; qi < queryCount; qi++) {
    const query = scenes[qi].scene_name;
    const embedding = await embedWithOllama(query);

    // Ground truth: top-N by embedding similarity. An absolute cosine threshold is
    // tempting but unstable across providers and query lengths; a fixed budget is
    // the same convention IR benchmarks use for a "relevant set" and it keeps the
    // recall denominator constant while the configurations vary.
    const ranked = index.ids
      .map((id, i) => ({ id, score: cosine(index.vectors, embedding, index.dimension, i * index.dimension, 0) }))
      .sort((a, b) => b.score - a.score);
    const truthSize = Math.min(truthBudget, ranked.length);
    const truth = new Set(ranked.slice(0, truthSize).map((h) => h.id));
    truthSizes.push({ scene: query, size: truthSize, floor: ranked[truthSize - 1]?.score ?? 0 });

    // Candidate pool: lexical overlap over all records, as the FTS path would give.
    const queryShingles = shingles(query, 2);
    const lex: Scored[] = pool
      .map((record) => ({ record, score: jaccard(queryShingles, shingles(record.content, 2)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k * 4);

    const vec: Scored[] = index.ids
      .map((id, i) => ({ id, score: cosine(index.vectors, embedding, index.dimension, i * index.dimension, 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k * 4)
      .map((h) => ({ record: byId.get(h.id)!, score: h.score }))
      .filter((h) => !!h.record);

    const fused = new Map<string, Scored>();
    for (const list of [lex, vec]) {
      list.forEach((hit, rank) => {
        const weight = 1 / (60 + rank + 1);
        const existing = fused.get(hit.record.record_id);
        if (existing) existing.score += weight;
        else fused.set(hit.record.record_id, { record: hit.record, score: weight });
      });
    }
    const candidates = [...fused.values()].sort((a, b) => b.score - a.score);

    for (const label of ["baseline", "decay", "forgetting"]) {
      let window: Scored[];
      if (label === "baseline") {
        window = candidates.slice(0, k);
      } else {
        window = rerankHits(candidates, DEFAULT_DECAY, new Date(), { limit: k }).map((h) => ({
          record: h.record,
          score: h.multipliedScore,
        }));
      }
      if (label === "forgetting") {
        const kept: Scored[] = [];
        for (const hit of window) {
          const at = kept.findIndex(
            (x) => x.record.type === hit.record.type && jaccard(shingles(x.record.content), shingles(hit.record.content)) >= DUPLICATE_THRESHOLD,
          );
          if (at === -1) kept.push(hit);
          else if (hit.record.pinned && !kept[at].record.pinned) kept[at] = hit;
        }
        window = kept;
      }

      const hits = window.filter((h) => truth.has(h.record.record_id)).length;
      let dup = 0;
      for (let i = 1; i < window.length; i++) {
        if (window.slice(0, i).some((e) => jaccard(shingles(e.record.content), shingles(window[i].record.content)) >= DUPLICATE_THRESHOLD)) dup++;
      }
      perConfig[label].push({
        p: window.length > 0 ? hits / window.length : 0,
        r: truth.size > 0 ? hits / Math.min(truth.size, k) : 0,
        d: window.length > 0 ? dup / window.length : 0,
        pin: window.some((h) => h.record.pinned) ? 1 : 0,
      });
    }
  }

  for (const label of Object.keys(results)) {
    const rows = perConfig[label];
    results[label] = {
      precision: mean(rows.map((r) => r.p)),
      recall: mean(rows.map((r) => r.r)),
      dupShare: mean(rows.map((r) => r.d)),
      pinRecall: mean(rows.map((r) => r.pin)),
    };
  }

  const floorAvg = mean(truthSizes.map((t) => t.floor));
  process.stdout.write(
    `\nqueries=${queryCount}, k=${k}, truth budget=${truthBudget}, embedded records=${index.ids.length}` +
      `, mean similarity at the truth boundary=${floorAvg.toFixed(3)}\n\n`,
  );
  process.stdout.write("configuration precision@k recall@k  dupShare  pinRecall\n");
  for (const [label, m] of Object.entries(results)) {
    process.stdout.write(
      label.padEnd(14) +
        m.precision.toFixed(3).padEnd(12) +
        m.recall.toFixed(3).padEnd(11) +
        m.dupShare.toFixed(3).padEnd(10) +
        m.pinRecall.toFixed(3) +
        "\n",
    );
  }
}

void main();
