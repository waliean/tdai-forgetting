/**
 * Benchmark corpora.
 *
 * Two sources, one shape:
 *
 *   - `synthetic`: generated in memory from a fixed seed, so results are
 *     reproducible and the corpus is safe to publish. It reproduces the failure
 *     modes that motivated the engine — duplicate research notes, a long tail that
 *     nothing ever recalled, and a handful of pins — rather than pretending to be a
 *     realistic workload.
 *   - `snapshot`: a real tdai database read through the adapter. Aggregate results
 *     only; the harness never prints record content, because a memory corpus is
 *     personal data even when the schema is public.
 */

import { DatabaseSync } from "node:sqlite";
import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import type { MemoryRecord } from "../src/types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  "三架构编排收口",
  "JFPE 盲审意见",
  "C 盘清理",
  "tdai 复刻部署",
  "CodeGraph 替换",
  "AutoMM 恢复机制",
  "论文降重",
  "Origin 绘图",
  "记忆库备份",
  "窗口函数评级",
];

/**
 * Sentence pools. Records draw from different pools per category so that two
 * unrelated memories share vocabulary but not phrasing — the same property real
 * corpora have, and the property that makes a 0.6 Jaccard bar meaningful.
 */
const CLAUSES = {
  finding: [
    "实测三项门槛只有一项通过",
    "抽样复算发现两个数字对不上",
    "前一轮的结论在本轮被推翻",
    "同一参数两次运行的结果不一致",
    "文档宣称的行为在代码里找不到对应实现",
    "分母口径与上游定义存在差异",
  ],
  action: [
    "决定先补一份可复算的记录",
    "下一步改为分阶段验证",
    "把结论写回研究文档并标注日期",
    "把脚本收回本地不再外发",
    "暂缓上线，等对照实验跑完",
    "把这条列进待办并约定复查时间",
  ],
  context: [
    "背景是容器挂载路径写错导致数据读空",
    "起因是网关配置里的保留天数没打开",
    "问题出在评分只看排名融合",
    "触发条件是同一主题连续写入三次",
    "前提是本地 Ollama 已加载嵌入模型",
    "限制在于现有检索不记录访问痕迹",
  ],
  outcome: [
    "最终耗时比预估多了半天",
    "结果与预期相反但可解释",
    "复现步骤已整理成脚本",
    "结论只对当前数据分布成立",
    "改完之后索引重建花了十分钟",
    "这次没有动线上数据",
  ],
};

function pick<T>(rand: () => number, pool: T[]): T {
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * Build a corpus with the pathologies that matter for this engine:
 *   - duplicated research notes written by separate migration runs;
 *   - a long tail of one-off records nothing ever recalled;
 *   - a small set of pins carrying an explicit permanence instruction.
 */
/**
 * How often each topic gets queried, per 100 recall episodes.
 *
 * Access history is not uniform in practice: a handful of topics are asked about
 * constantly and the long tail is never touched. Generating it as "random records
 * get remembered" would make the usage term measure noise, and the benchmark would
 * report that decay hurts for a reason that cannot occur in a real deployment.
 */
const TOPIC_DEMAND = [34, 26, 18, 12, 8, 6, 4, 3, 2, 1];

export function syntheticCorpus(count = 600, seed = 20261026): MemoryRecord[] {
  const rand = mulberry32(seed);
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const records: MemoryRecord[] = [];

  for (let i = 0; i < count; i++) {
    const topic = pick(rand, TOPICS);
    const ageDays = Math.floor(rand() * 120);
    const stamp = new Date(now - ageDays * 86_400_000).toISOString();
    // One topic in eight was captured two or three times by separate migration
    // runs. Higher rates make the duplicate metric dominate every other number.
    const copies = rand() < 0.12 ? Math.floor(rand() * 2) + 2 : 1;
    // Access follows topic demand, not a coin flip: a record is recalled when its
    // topic comes up, and topics come up at very different rates.
    const demand = TOPIC_DEMAND[TOPICS.indexOf(topic)] ?? 1;
    const recalled = rand() < Math.min(1, demand / 40);
    const accessCount = recalled ? 1 + Math.floor(rand() * demand) : 0;
    const pinned = rand() < 0.06;
    const type = pinned || rand() < 0.3 ? "instruction" : "episodic";
    // tdai extracts priority from the record's own importance, not from usage. Keep
    // them independent so the benchmark does not accidentally reward a proxy.
    const priority = pinned ? -1 : 55 + Math.floor(rand() * 40);

    const body = [
      `${topic}：${pick(rand, CLAUSES.context)}，${pick(rand, CLAUSES.finding)}。`,
      `处理方式是${pick(rand, CLAUSES.action)}，${pick(rand, CLAUSES.outcome)}。`,
    ].join("");

    for (let copy = 0; copy < copies; copy++) {
      records.push({
        record_id: `syn_${i}_${copy}`,
        // Copies differ by a suffix, the way re-run migrations rewrite the same
        // note with a slightly different header rather than byte-identically.
        content: copy === 0 ? body : `副本 ${copy}：${body}`,
        type,
        priority,
        scene_name: topic,
        team_id: "bench",
        user_id: "bench",
        agent_id: "bench",
        created_time: stamp,
        updated_time: stamp,
        access_count: accessCount,
        // Popular topics were touched recently; rare ones were touched, then left.
        last_access_time: accessCount > 0 ? new Date(now - Math.floor(rand() * (demand > 10 ? 7 : 60)) * 86_400_000).toISOString() : null,
        state: "active",
        metadata_json: "{}",
      });
    }
  }
  return records;
}

/** Load a real database. Aggregate-only reporting is the caller's responsibility. */
export function snapshotCorpus(dbPath: string, limit = 0): MemoryRecord[] {
  return loadRecords(dbPath, { limit });
}

/** Sanity check that a path really is a tdai store, so the harness fails loudly. */
export function isTdaiDatabase(dbPath: string): boolean {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'l1_records'").get();
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
