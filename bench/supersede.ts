/**
 * Controlled test: does decay help when the corpus actually contains superseded
 * facts?
 *
 * The snapshot experiment found no staleness to fix: its near-duplicates are
 * same-day migration copies, not an old conclusion replaced by a new one. So decay
 * neither helped nor hurt much there, and reporting only that would leave the
 * obvious question open.
 *
 * This experiment builds the case decay is designed for. Each fact exists in three
 * restatements made 90, 60 and 30 days ago with near-identical wording (the way a
 * conclusion gets rewritten as the project moves), differing only in a version
 * marker. The question asked of retrieval is "what is the current statement", so
 * exactly one record per fact is the right answer and the other two are stale.
 *
 * Without age information, a similarity-ranked system has no way to prefer the
 * newest copy — the three are equally similar. That is the theoretical gap decay
 * fills, and this measures how much of it actually gets filled.
 */

import { parseArgs } from "node:util";

import { applyPins } from "../src/pin.ts";
import { DEFAULT_DECAY, decayEnabled, rerankHits, trackingCoverage } from "../src/scoring.ts";
import { jaccard, shingles } from "../src/redundancy.ts";
import type { MemoryRecord } from "../src/types.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACT_STEMS = [
  "课题三的三架构收口结论是采用统一编排层",
  "JFPE 论文的图表统一改为 Origin 导出",
  "tdai 的记忆目录从 C 盘迁到 D 盘",
  "研究记忆的备份节奏定为每周一次",
  "CodeGraph 的索引目录随仓库一起提交",
  "AutoMM 的恢复路径改走事件驱动",
  "查重报告的口径统一按连续十三个字",
  "评委偏好实证数据而非模型复杂度",
  "容器挂载路径统一走 environment 变量",
  "嵌入模型固定为 bge-m3 不随版本漂移",
];

const VARIANTS = [
  (stem: string) => `${stem}，此为初版判断，后续可能调整。`,
  (stem: string) => `${stem}，复评后维持原判断，补充了两条实测依据。`,
  (stem: string) => `${stem}，第三次复核确认，结论与复评一致。`,
];

interface Case {
  query: string;
  /** The single record that states the fact as of today. */
  currentId: string;
  records: MemoryRecord[];
}

function buildCorpus(factCount: number, seed = 20261026): Case[] {
  const rand = mulberry32(seed);
  const cases: Case[] = [];
  for (let f = 0; f < factCount; f++) {
    const stem = FACT_STEMS[f % FACT_STEMS.length];
    const records: MemoryRecord[] = [];
    let currentId = "";
    VARIANTS.forEach((render, v) => {
      const ageDays = [90, 60, 30][v];
      const stamp = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
      const id = `fact${f}_v${v + 1}`;
      if (v === VARIANTS.length - 1) currentId = id;
      records.push({
        record_id: id,
        content: render(stem),
        type: "episodic",
        priority: 85 + Math.floor(rand() * 10),
        scene_name: stem,
        team_id: "bench",
        user_id: "bench",
        agent_id: "bench",
        created_time: stamp,
        updated_time: stamp,
        access_count: 0,
        last_access_time: null,
        state: "active",
        metadata_json: "{}",
      });
    });
    cases.push({ query: stem, currentId, records });
  }
  return cases;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { facts: { type: "string", default: "10" }, k: { type: "string", default: "3" } },
  });
  const cases = buildCorpus(Number(values.facts));
  const all = applyPins(cases.flatMap((c) => c.records));
  const k = Number(values.k);

  // Note: this corpus has timestamps but no access history, so the shipped gate stays
  // closed. That is the honest outcome and it is the point of the experiment — a
  // freshness signal alone does not earn the right to reorder results, even when the
  // corpus is full of genuinely stale facts.
  const coverage = trackingCoverage(all);
  const decayOn = decayEnabled(coverage, DEFAULT_DECAY);

  const configs: Record<string, (candidates: Array<{ record: MemoryRecord; score: number }>) => Array<{ record: MemoryRecord; score: number }>> = {
    baseline: (c) => c.slice(0, k),
    // Timestamps exist here, so the age term is also tested with the gate forced on;
    // this isolates "does the formula help" from "does the gate open".
    "decay-forced": (c) =>
      rerankHits(c, DEFAULT_DECAY, NOW, { limit: k, decay: true }).map((h) => ({ record: h.record, score: h.multipliedScore })),
    decay: (c) =>
      rerankHits(c, DEFAULT_DECAY, NOW, { limit: k, decay: decayOn }).map((h) => ({ record: h.record, score: h.multipliedScore })),
    "decay+dedupe": (c) => {
      const window = rerankHits(c, DEFAULT_DECAY, NOW, { limit: k, decay: true }).map((h) => ({
        record: h.record,
        score: h.multipliedScore,
      }));
      const kept: Array<{ record: MemoryRecord; score: number }> = [];
      for (const hit of window) {
        const at = kept.findIndex((x) => jaccard(shingles(x.record.content), shingles(hit.record.content)) >= 0.6);
        if (at === -1) kept.push(hit);
        else if ((hit.record.updated_time || "") > (kept[at].record.updated_time || "")) kept[at] = hit;
      }
      return kept;
    },
  };

  // Control: what an explicit supersession flag buys. Instead of inferring "old" from
  // a timestamp, mark the two superseded restatements invalid and let the ranking see
  // only valid facts. If this reaches 1.0, then decay is a proxy for a mechanism the
  // schema could express exactly, and the recommendation is to add the flag rather
  // than to calibrate the proxy.
  const supersededIds = new Set(cases.flatMap((c) => c.records.filter((r) => r.record_id !== c.currentId).map((r) => r.record_id)));
  configs["explicit-supersession"] = (c) => c.filter((h) => !supersededIds.has(h.record.record_id)).slice(0, k);

  const results: Array<{ configuration: string; currentAtTop1: number; staleInWindow: number; coverage: number }> = [];

  for (const [label, apply] of Object.entries(configs)) {
    let top1 = 0;
    let stale = 0;
    for (const testCase of cases) {
      const queryShingles = shingles(testCase.query, 2);
      const candidates = all
        .map((record) => ({ record, score: jaccard(queryShingles, shingles(record.content, 2)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k * 3);
      const window = apply(candidates);
      if (window[0]?.record.record_id === testCase.currentId) top1++;
      // Stale copies in the window are the failure this experiment is looking for.
      stale += window.filter((h) => h.record.record_id !== testCase.currentId && h.record.scene_name === testCase.query).length;
    }
    results.push({
      configuration: label,
      currentAtTop1: top1 / cases.length,
      staleInWindow: stale / cases.length,
      coverage,
    });
  }

  process.stdout.write(
    `\nfacts=${cases.length}, restatements per fact=${VARIANTS.length}, k=${k}, gate=${decayOn ? "open" : "closed"}\n\n`,
  );
  process.stdout.write("configuration   current@top1  stale-in-window\n");
  for (const row of results) {
    process.stdout.write(
      row.configuration.padEnd(16) + row.currentAtTop1.toFixed(3).padEnd(14) + row.staleInWindow.toFixed(2) + "\n",
    );
  }
  process.stdout.write("\ncurrent@top1: share of facts whose newest restatement ranks first\n");
  process.stdout.write("stale-in-window: mean count of superseded copies occupying a slot\n");
}

void main();
