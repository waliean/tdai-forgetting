import { test } from "node:test";
import assert from "node:assert/strict";

import { findRedundancyClusters, jaccard, normalizeForShingles, shingles } from "../src/redundancy.ts";
import type { MemoryRecord } from "../src/types.ts";

function record(id: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 90,
    scene_name: "",
    team_id: "t",
    user_id: "u",
    agent_id: "a",
    created_time: "2026-10-01T00:00:00.000Z",
    updated_time: "2026-10-01T00:00:00.000Z",
    access_count: 0,
    metadata_json: "{}",
    ...overrides,
  };
}

test("normalisation erases whitespace, punctuation and case", () => {
  assert.equal(normalizeForShingles("A, B。C"), "abc");
  assert.equal(normalizeForShingles("  多  空格  "), "多空格");
});

test("jaccard is 1 for identical sets and 0 for disjoint ones", () => {
  const a = shingles("用户要求 AI 从今天起永久改名为 Jindřich");
  const b = shingles("用户要求 AI 从今天起永久改名为 Jindřich");
  assert.equal(jaccard(a, b), 1);
  assert.equal(jaccard(shingles("完全不同的内容在这里"), shingles("另一段没有共同点的话")), 0);
});

test("jaccard is symmetric", () => {
  const a = shingles("用户要求 AI 从 2026-08-29 起永久改名为 Jindřich");
  const b = shingles("用户要求 AI 从 2026-08-29 起将名字永久改为 Jindřich");
  assert.equal(jaccard(a, b), jaccard(b, a));
});

test("near-duplicates cluster and the higher-scoring copy leads", () => {
  const records = [
    record("a", "用户要求 AI 从 2026-08-29 起永久改名为 Jindřich（捷克语的亨利），不再使用旧名 Henry/亨利，旧称与新名指同一身份。"),
    record("b", "用户要求 AI 从 2026-08-29 起将名字永久改为 Jindřich（捷克语的亨利），不再使用旧名 Henry/亨利，旧称与新名指同一身份，需永久记住这一变更。"),
    record("c", "tdai 的记忆目录默认位于 D 盘 ZCodeData 下，容器挂载到 /data/tdai-memory。"),
  ];
  const scores = new Map([
    ["a", 0.4],
    ["b", 0.9],
    ["c", 0.5],
  ]);
  const clusters = findRedundancyClusters(records, { threshold: 0.6, minLength: 20, sameTypeOnly: true }, scores);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].memberIds.sort(), ["a", "b"]);
  assert.equal(clusters[0].leadId, "b", "the best copy must survive");
});

test("single linkage chains transitively", () => {
  const shared = "这是一段用于测试单链接聚类行为的中文文本内容";
  const records = [
    record("a", shared + "甲甲乙乙丙丙丁丁"),
    record("b", shared + "甲甲乙乙丙丙戊戊"),
    record("c", shared + "甲甲乙乙丙丙戊戊己己"),
  ];
  const clusters = findRedundancyClusters(records, { threshold: 0.5, minLength: 10, sameTypeOnly: true });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].memberIds.length, 3);
});

test("different types are not clustered together by default", () => {
  const text = "用户要求 AI 从 2026-08-29 起永久改名为 Jindřich，不再使用旧名 Henry";
  const records = [
    record("a", text, { type: "instruction" }),
    record("b", text, { type: "episodic" }),
  ];
  assert.equal(findRedundancyClusters(records).length, 0);
  assert.equal(findRedundancyClusters(records, { threshold: 0.6, minLength: 20, sameTypeOnly: false }).length, 1);
});

test("short records are skipped: their shingle sets are too noisy to compare", () => {
  const records = [record("a", "好的收到", {}), record("b", "好的收到", {})];
  assert.equal(findRedundancyClusters(records, { threshold: 0.6, minLength: 40, sameTypeOnly: true }).length, 0);
});

test("no duplicate ids leak between clusters", () => {
  const records = [
    record("a", "第一组内容非常相似的一段很长的中文文本用来触发聚类判断逻辑"),
    record("b", "第一组内容非常相似的一段很长的中文文本用来触发聚类判断逻辑"),
    record("c", "第二组完全不同的另一段内容同样足够长以便通过最小长度过滤"),
    record("d", "第二组完全不同的另一段内容同样足够长以便通过最小长度过滤"),
  ];
  const clusters = findRedundancyClusters(records, { threshold: 0.6, minLength: 20, sameTypeOnly: true });
  assert.equal(clusters.length, 2);
  const seen = new Set<string>();
  for (const c of clusters) for (const id of c.memberIds) {
    assert.equal(seen.has(id), false, `duplicate id ${id}`);
    seen.add(id);
  }
});
