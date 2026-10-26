import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PIN_OPTIONS, PERMANENCE_PATTERN, applyPins, resolvePin, unprotectedPermanence } from "../src/pin.ts";
import type { MemoryRecord } from "../src/types.ts";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: "r1",
    content: "用户偏好中文回答",
    type: "episodic",
    priority: 90,
    scene_name: "",
    team_id: "t",
    user_id: "u",
    agent_id: "a",
    created_time: "2026-10-01T00:00:00.000Z",
    updated_time: "2026-10-01T00:00:00.000Z",
    metadata_json: "{}",
    ...overrides,
  };
}

test("priority -1 is a hard pin", () => {
  const r = resolvePin(record({ priority: -1 }));
  assert.equal(r.pinned, true);
  assert.equal(r.kind, "hard");
  assert.match(r.reason ?? "", /priority/);
});

test("an instruction that asserts permanence is a hard pin", () => {
  for (const phrase of ["永久记住这个配置", "此结论不得遗忘", "请不要删除该记录", "never forget this token"]) {
    const r = resolvePin(record({ type: "instruction", content: phrase }));
    assert.equal(r.pinned, true, phrase);
    assert.equal(r.kind, "hard", phrase);
  }
});

test("the same wording inside an episodic record is only an extended pin", () => {
  // A record of a request is not the request. Treating the quote as a command
  // would freeze every research dump that happened to mention "remember forever".
  const r = resolvePin(record({ type: "episodic", content: "用户要求 AI 永久记住 key 为 x 的研究记忆" }));
  assert.equal(r.pinned, true);
  assert.equal(r.kind, "extended");
  assert.match(r.reason ?? "", /half-life/);
});

test("merely important records are not pinned", () => {
  const r = resolvePin(record({ type: "instruction", content: "这是很重要的项目背景，请优先考虑" }));
  assert.equal(r.pinned, false);
});

test("metadata can pin explicitly, and malformed metadata is ignored rather than fatal", () => {
  assert.equal(resolvePin(record({ metadata_json: '{"pin":true}' })).kind, "hard");
  assert.equal(resolvePin(record({ metadata_json: '{"pin_kind":"extended"}' })).kind, "extended");
  assert.equal(resolvePin(record({ metadata_json: "{not json" })).pinned, false);
  assert.equal(resolvePin(record({ metadata_json: "" })).pinned, false);
});

test("persona pins are off by default and can be enabled", () => {
  assert.equal(resolvePin(record({ type: "persona" })).pinned, false);
  assert.equal(resolvePin(record({ type: "persona" }), { ...DEFAULT_PIN_OPTIONS, pinPersona: true }).kind, "hard");
});

test("disabling permanence pins leaves the record unprotected and it shows up for review", () => {
  const records = applyPins(
    [record({ type: "instruction", content: "永久记住这个地址" })],
    { ...DEFAULT_PIN_OPTIONS, pinInstructionPermanence: false },
  );
  assert.equal(records[0].pinned, false);
  // The review list is the safety net for exactly this configuration.
  assert.equal(unprotectedPermanence(records).length, 1);
});

test("with default rules nothing permanence-worded is left unprotected", () => {
  const records = applyPins([
    record({ type: "instruction", content: "永久记住 A" }),
    record({ type: "episodic", content: "用户说永久记住 B" }),
    record({ type: "persona", content: "不得遗忘 C" }),
    record({ type: "episodic", content: "普通记录" }),
  ]);
  assert.equal(records.filter((r) => r.pinned).length, 3);
  assert.equal(unprotectedPermanence(records).length, 0);
});

test("permanence pattern accepts natural variants and rejects generic emphasis", () => {
  const yes = ["永久保留", "永久存档", "不得覆盖", "永不删除", "禁止删除", "keep forever"];
  const no = ["很重要", "务必重视", "优先级很高", "永久", "不要忘记带上钥匙"];
  for (const phrase of yes) assert.equal(PERMANENCE_PATTERN.test(phrase), true, phrase);
  for (const phrase of no) assert.equal(PERMANENCE_PATTERN.test(phrase), false, phrase);
});

test("applyPins is pure: the input records are unchanged", () => {
  const input = [record({ priority: -1 })];
  const output = applyPins(input);
  assert.equal(input[0].pinned, undefined);
  assert.equal(output[0].pinned, true);
});
