/**
 * Long-text corpus.
 *
 * Why this corpus exists: every other corpus here is made of 40–80 character
 * notes, and the duplicate detector was tuned on those. `shingles(content, 4)`
 * turns a short note into a set of almost as many shingles as it has characters,
 * so two reworded copies of one fact still share most of their set. A 1200-character
 * document behaves differently: the shared part stays constant while the set grows
 * with length, so Jaccard falls as the text grows and a 0.6 bar stops seeing copies
 * that a human would call the same fact. That is the known defect D5 has to decide
 * about, and measuring it needs a corpus that contains it on purpose.
 *
 * Construction, stated plainly because a synthetic corpus that pretends to be real
 * is worse than no corpus:
 *
 *   - Each fact group is generated twice: a `brief` statement (~500–700 chars) and
 *     a `full` statement that contains the brief text as its prefix (~1200–1400).
 *     The two ARE the same fact, so any duplicate detector should pair them.
 *   - Sentences are assembled from an eight-slot template, not sampled from real
 *     documents. Each slot has 12 base values, and three of the slots also carry one
 *     of 6 modifiers, so the space holds 53,747,712 distinct sentences. They read like
 *     terse technical write-ups — deployment notes, incident reviews — and are meant to
 *     exercise length and prefix structure, not to be linguistically realistic.
 *   - The scale of the space is load-bearing. With few values per slot and many
 *     sentences per group, every group would end up using most values, two unrelated
 *     groups would share whole clauses, and the duplicate count would be measuring the
 *     generator rather than the detector. Here a group draws 5–11 sentences out of
 *     53 million, so unrelated groups share almost no wording.
 *
 * The consequence to keep in mind when reading any number measured on this corpus:
 * because `full` extends `brief`, the correct duplicate count is `facts`, and any
 * lower number is the dilution defect rather than a corpus mistake.
 */

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

function pick<T>(rand: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rand() * pool.length)];
}

/** Scene names, so `buildQueries` can derive queries the same way it does elsewhere. */
const TOPICS = ["部署手册", "接口文档", "架构决策记录", "事故复盘", "会议纪要", "迁移方案"] as const;

const SUBJECTS = [
  "网关",
  "索引",
  "调度器",
  "缓存层",
  "审计日志",
  "迁移脚本",
  "健康检查",
  "配额服务",
  "消息队列",
  "配置中心",
  "鉴权模块",
  "备份任务",
];

const SYMPTOMS = [
  "出现间歇性超时",
  "返回了空结果",
  "重复写入同一条",
  "丢失最后一段",
  "在高峰期排队",
  "静默跳过了校验",
  "把旧值当成新值",
  "触发了两次清理",
  "在重连后失效",
  "抛出了未捕获的异常",
  "把部分请求转到了旧版本",
  "在没有告警的情况下停摆",
];

const CAUSES = [
  "配置里的保留天数没有真正生效，上游读到的仍是默认值",
  "并发写入路径上没有加锁，两个请求同时改了同一条记录",
  "时钟回拨让时间戳落到未来，排序时被当成了最新",
  "过滤条件写在了聚合之后，中间结果把不该留的留下了",
  "重试没有幂等键，一次失败变成了三次写入",
  "分页游标在并发更新后错位，第二页漏掉了前几条",
  "连接池上限被别的任务占满，新请求只能排队等释放",
  "下游返回的错误码被当成成功，脏数据一路写到了归档层",
  "索引重建期间的写入被丢进了临时表，切换时没有回放",
  "老的兼容分支没有随字段删除，读到的是上一版结构",
  "熔断阈值按平均值算而不是按分位，尖峰被平滑掉了",
  "缓存与数据库的失效顺序反了，短窗口内返回旧值",
];

const CAUSE_MODS = [
  "影响面比预想的大",
  "在高峰期更明显",
  "只在小数据量下复现",
  "换了机器就消失",
  "和上一版的行为不一致",
  "只在多实例部署时出现",
];

const ACTIONS = [
  "先冻结写入再按日期重放，确认对齐后才恢复服务",
  "把索引重建与数据修复拆成两步，各自有独立的回滚点",
  "加一层幂等键并补齐回归用例，再用影子流量验证",
  "改成先写临时表再原子切换，失败时保留旧表可查",
  "把阈值调高一档并观察一周，同时补上分位的采集",
  "补上缺失的监控与告警，让下次同类问题在一小时内可见",
  "用影子流量并行跑新链路，比对结果一致后再切主",
  "退回上一版并保留现场，把异常样本完整导出留档",
  "把重试逻辑收进统一的封装，所有调用方共享同一份",
  "手工核对最近三天的写入，逐条标注是保留还是作废",
  "把并发路径改成串行队列，用单写者换取可解释性",
  "给关键字段加上唯一约束，让冲突在写入时就暴露",
];

const ACTION_MODS = [
  "这一步用了一整天",
  "需要两个人同时在场",
  "做了两轮才通过评审",
  "留下了完整的变更记录",
  "顺带清掉了三个旧开关",
  "在演练环境先走了一遍",
];

const OUTCOMES = [
  "耗时比预估多了半天，但没有产生二次损坏",
  "结果与预期相反但可解释，说明前提假设本身有问题",
  "复现步骤已经整理成脚本，换台机器也能重演",
  "结论只对当前数据分布成立，换语料要重新测",
  "改完之后索引重建花了十分钟，落在可接受窗口内",
  "这次没有改动线上数据，只在副本上验证",
  "仍有两条记录无法归因，标记为待复查",
  "误差落在可接受范围内，但余量已经不多",
  "修复后同一类告警再没出现过，观察期两周",
  "代价是查询延迟上升了不到一秒，换来的是可审计",
  "回滚演练在下一次变更前完成，耗时四十分钟",
  "结论写进了文档，包括被否决的两个备选方案",
];

const OUTCOME_MODS = [
  "后续观察没有反复",
  "同类问题又出现了一次",
  "指标回到基线上方一点",
  "两周后复测结论仍然成立",
  "这条结论已交付给运维",
  "目前仍挂在待办清单里",
];

const SENTENCE_SPACE =
  SUBJECTS.length *
  SYMPTOMS.length *
  CAUSES.length *
  CAUSE_MODS.length *
  ACTIONS.length *
  ACTION_MODS.length *
  OUTCOMES.length *
  OUTCOME_MODS.length;

/**
 * Spreads consecutive counters across the index space.
 *
 * A linear stride is not enough. Walked through mixed-radix slots, a fixed step lands
 * on the same value in several small-radix slots over and over, so two groups' sentences
 * end up sharing whole clauses. Measured on an earlier version, that pushed unrelated
 * full statements to 0.62 Jaccard — above the duplicate threshold, i.e. three fake
 * duplicate groups in a corpus that is supposed to have none. A 32-bit avalanche mix
 * makes the slots independent, at the cost of a collision probability around 1e-5 for
 * the few thousand sentences a corpus draws.
 */
function mix32(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/** One sentence, roughly 100–130 characters, assembled from the pools. */
function makeSentence(index: number): string {
  let rest = index;
  const take = <T>(pool: readonly T[]): T => {
    const value = pool[rest % pool.length];
    rest = Math.floor(rest / pool.length);
    return value;
  };
  const subject = take(SUBJECTS);
  const symptom = take(SYMPTOMS);
  const cause = take(CAUSES);
  const causeMod = take(CAUSE_MODS);
  const action = take(ACTIONS);
  const actionMod = take(ACTION_MODS);
  const outcome = take(OUTCOMES);
  const outcomeMod = take(OUTCOME_MODS);
  return `${subject}${symptom}，${cause}，${causeMod}。${action}，${actionMod}。${outcome}，${outcomeMod}。`;
}

export interface LongtextOptions {
  /** Number of fact groups. Each produces a brief and a full record. */
  facts?: number;
  seed?: number;
  /** Sentences in the brief statement. 5 lands in the 500–700 character band. */
  briefSentences?: number;
  /** Sentences in the full statement, brief included. 11 lands in the 1200–1500 band. */
  fullSentences?: number;
}

/**
 * Build the long-text corpus.
 *
 * Returns `2 * facts` records: one brief and one full per fact, with the full text
 * starting with the brief text verbatim.
 */
export function longtextCorpus(opts: LongtextOptions = {}): MemoryRecord[] {
  const facts = opts.facts ?? 60;
  const seed = opts.seed ?? 20261106;
  const briefSentences = opts.briefSentences ?? 5;
  const fullSentences = opts.fullSentences ?? 11;
  const rand = mulberry32(seed);
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const records: MemoryRecord[] = [];
  let sentenceCursor = 0;

  for (let g = 0; g < facts; g++) {
    const topic = pick(rand, TOPICS);
    const sentences: string[] = [];
    for (let i = 0; i < fullSentences; i++) {
      sentences.push(makeSentence(mix32(sentenceCursor++) % SENTENCE_SPACE));
    }

    // Prefix, not paraphrase: the brief is literally the opening of the full text.
    // Any similarity measure that cannot see that relationship is measuring length.
    const briefBody = sentences.slice(0, briefSentences).join("");
    const fullBody = sentences.join("");

    const ageDays = Math.floor(rand() * 120);
    const stamp = new Date(now - ageDays * 86_400_000).toISOString();
    // Roughly 5% carry tdai's global-instruction marker, which makes them hard pins.
    const priority = rand() < 0.05 ? -1 : 55 + Math.floor(rand() * 40);
    // Then ~40% of records have been recalled at least once. Enough for the decay
    // gate to open on this corpus, unlike the real snapshot, which has no access data.
    const recalled = rand() < 0.4;
    const accessCount = recalled ? 1 + Math.floor(rand() * 12) : 0;
    const lastAccess = recalled ? new Date(now - Math.floor(rand() * 30) * 86_400_000).toISOString() : null;
    const type = priority === -1 ? "instruction" : rand() < 0.25 ? "instruction" : "episodic";

    const base = {
      type,
      priority,
      scene_name: topic,
      team_id: "bench",
      user_id: "bench",
      agent_id: "bench",
      created_time: stamp,
      updated_time: stamp,
      access_count: accessCount,
      last_access_time: lastAccess,
      state: "active" as const,
      metadata_json: "{}",
    };

    records.push({ ...base, record_id: `long_${g}_brief`, content: briefBody });
    records.push({ ...base, record_id: `long_${g}_full`, content: fullBody });
  }

  return records;
}
