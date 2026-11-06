import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "../src/migrate.ts";
import {
  LLM_APPLY_MAX_FALSE_SUPERSEDE,
  LLM_SUGGEST_ACTION,
  PROMPT_VERSION,
  checkApplyGate,
  judgePair,
  parseVerdict,
  renderPrompt,
  runCriteria,
  type JudgeProvider,
} from "../src/llm-criteria.ts";
import { evaluate, samplePairs } from "../src/criteria-eval.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

/**
 * The LLM criteria, with an injected fake provider. No test here touches a network.
 *
 * The tests are organised around the asymmetry the feature exists for: a wrong
 * `supersede` silently deletes a correct memory. So the interesting assertions are all
 * about what the system does NOT write — under shadow, on a failed call, on a
 * non-supersede verdict, and when the gate has no measurement to stand on.
 */

/** A provider that returns whatever it is told, so outcomes are deterministic. */
function fakeProvider(reply: string | (() => Promise<string>), modelId = "fake-model"): JudgeProvider {
  return {
    modelId,
    complete: async () => (typeof reply === "function" ? await reply() : reply),
  };
}

const SUPRESEDE_REPLY = '{"verdict":"supersede","confidence":0.9,"why":"the project was cancelled"}';

/** A scratch directory, so a run report never lands in the repository root. */
function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "tdai-criteria-"));
}

function seededDb(): ReturnType<typeof createTempDb> {
  const db = createTempDb();
  migrate(db.path);
  insertRecords(db.path, [
    makeRecord({ record_id: "old", content: "项目 A 下周三交付第一版。" }),
    makeRecord({ record_id: "new", content: "项目 A 已取消，不再交付。" }),
  ]);
  return db;
}

function snapshot(dbPath: string): { invalid: number; audit: number; invalidIds: string[] } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const invalidIds = (
      db.prepare("SELECT record_id FROM l1_records WHERE invalid_at IS NOT NULL").all() as Array<{ record_id: string }>
    ).map((r) => r.record_id);
    return {
      invalid: invalidIds.length,
      invalidIds,
      audit: (db.prepare("SELECT COUNT(*) AS c FROM forgetting_audit").get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

function actions(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT action FROM forgetting_audit ORDER BY rowid").all() as Array<{ action: string }>).map(
      (r) => r.action,
    );
  } finally {
    db.close();
  }
}

const PAIRS = [{ pairId: "p1", oldId: "old", newId: "new" }];

async function run(dbPath: string, mode: "shadow" | "apply", rate: number | null = null, provider?: JudgeProvider) {
  return runCriteria({
    dbPath,
    pairs: PAIRS,
    mode,
    judge: { provider: provider ?? fakeProvider(SUPRESEDE_REPLY) },
    measuredFalseSupersedeRate: rate,
    reportPath: join(scratchDir(), "report.json"),
  });
}

// ─────────────────────────── shadow isolation ───────────────────────────

test("shadow records the suggestion and writes no invalid_at", async () => {
  const db = seededDb();
  try {
    const before = snapshot(db.path);
    const result = await run(db.path, "shadow");
    const after = snapshot(db.path);

    assert.equal(result.mode, "shadow");
    assert.equal(result.applied, false);
    assert.deepEqual(result.invalidated, []);
    assert.equal(after.invalid, before.invalid, "shadow must leave invalid_at alone");
    assert.deepEqual(after.invalidIds, []);
    assert.equal(after.audit, before.audit + 1, "exactly one suggestion row");
    assert.deepEqual(actions(db.path), [LLM_SUGGEST_ACTION]);
    assert.equal(result.outcomes[0].verdict, "supersede", "the verdict is still reported to the operator");
    assert.equal(result.outcomes[0].applied, false);
  } finally {
    db.cleanup();
  }
});

test("shadow leaves superseded_by NULL too, not just invalid_at", async () => {
  const db = seededDb();
  try {
    await run(db.path, "shadow");
    const conn = new DatabaseSync(db.path, { readOnly: true });
    const row = conn.prepare("SELECT invalid_at, superseded_by, state FROM l1_records WHERE record_id = 'old'").get() as {
      invalid_at: string | null;
      superseded_by: string | null;
      state: string;
    };
    conn.close();
    assert.equal(row.invalid_at, null);
    assert.equal(row.superseded_by, null);
    assert.equal(row.state, "active", "shadow does not touch state either");
  } finally {
    db.cleanup();
  }
});

test("the suggestion row carries the model, the prompt version and the verdict", async () => {
  const db = seededDb();
  try {
    await run(db.path, "shadow", null, fakeProvider(SUPRESEDE_REPLY, "test-model-7"));
    const conn = new DatabaseSync(db.path, { readOnly: true });
    const row = conn.prepare("SELECT reason, action FROM forgetting_audit").get() as { reason: string; action: string };
    conn.close();
    assert.match(row.reason, /verdict=supersede/);
    assert.match(row.reason, /model=test-model-7/);
    assert.ok(row.reason.includes("prompt=" + PROMPT_VERSION), "the prompt version must be on the audit row");
  } finally {
    db.cleanup();
  }
});

// ─────────────────────────── the gate ───────────────────────────

test("apply with no measurement is refused and writes nothing", async () => {
  const db = seededDb();
  try {
    const before = snapshot(db.path);
    const result = await run(db.path, "apply", null);
    assert.equal(result.rejection, "no-measurement");
    assert.equal(result.auditRows, 0);
    assert.deepEqual(snapshot(db.path), before, "a refused apply must not even write audit rows");
  } finally {
    db.cleanup();
  }
});

test("apply is refused when the measured rate reaches the threshold", async () => {
  const db = seededDb();
  try {
    const before = snapshot(db.path);
    const result = await run(db.path, "apply", LLM_APPLY_MAX_FALSE_SUPERSEDE);
    assert.equal(result.rejection, "rate-above-threshold", "the threshold is inclusive: >= fails");
    assert.deepEqual(snapshot(db.path), before);
  } finally {
    db.cleanup();
  }
});

test("apply writes invalid_at only when the rate is below the threshold", async () => {
  const db = seededDb();
  try {
    const result = await run(db.path, "apply", 0.01);
    assert.equal(result.rejection, null);
    assert.deepEqual(result.invalidated, ["old"]);

    const conn = new DatabaseSync(db.path, { readOnly: true });
    const row = conn.prepare("SELECT invalid_at, superseded_by, state FROM l1_records WHERE record_id = 'old'").get() as {
      invalid_at: string | null;
      superseded_by: string | null;
      state: string;
    };
    conn.close();
    assert.ok(row.invalid_at);
    assert.equal(row.superseded_by, "new");
    assert.equal(row.state, "active", "invalidation is still not eviction");

    // Both audit kinds, distinguishable by action.
    const acts = actions(db.path);
    assert.equal(acts.filter((a) => a === LLM_SUGGEST_ACTION).length, 1);
    assert.equal(acts.filter((a) => a === "invalidate").length, 1, "the write gets its own, human-recognisable action");
  } finally {
    db.cleanup();
  }
});

test("checkApplyGate refuses on a missing rate rather than assuming zero", () => {
  const g = checkApplyGate(null, "report.json");
  assert.equal(g.allowed, false);
  assert.match(g.message, /no false-supersede measurement/);
  assert.match(g.message, /report\.json/, "the operator is told where it looked");
});

test("checkApplyGate quotes the rate and the threshold in the rejection", () => {
  const g = checkApplyGate(0.2, "r.json");
  assert.equal(g.allowed, false);
  assert.match(g.message, /20\.0%/);
  assert.match(g.message, /5\.0%/);
});

test("checkApplyGate refuses a rate outside 0..1 instead of reading it as small", () => {
  // -0.5 is below the threshold, so a naive comparison lets it through. It is not a rate.
  for (const bad of [-0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const g = checkApplyGate(bad, "r.json");
    assert.equal(g.allowed, false, `rate ${bad} must not open the gate`);
    assert.equal(g.rejection, "no-measurement");
  }
});

test("a re-run over an already-invalidated record writes no second audit row", async () => {
  const db = seededDb();
  try {
    const first = await run(db.path, "apply", 0.01);
    assert.deepEqual(first.invalidated, ["old"]);
    const afterFirst = snapshot(db.path);

    // Same pair, same verdict, same gate: nothing left for the UPDATE to match.
    const second = await run(db.path, "apply", 0.01);
    const afterSecond = snapshot(db.path);

    assert.deepEqual(second.invalidated, [], "the second run wrote nothing, so it must claim nothing");
    assert.equal(second.outcomes[0].alreadyInvalid, true);
    assert.equal(second.outcomes[0].applied, false, "and must not report itself as applied");
    assert.equal(second.outcomes[0].verdict, "supersede", "the judge's verdict is unchanged");
    // The second run DOES add an llm-suggest row — the judge was consulted again, and a
    // suggestion is information even when it changes nothing. What it must not add is an
    // invalidate row: that would claim a write the UPDATE did not make.
    assert.deepEqual(afterSecond.invalidIds, afterFirst.invalidIds);
    assert.equal(afterSecond.invalid, 1, "invalid_at is untouched by the re-run");
    const acts = actions(db.path);
    assert.equal(acts.filter((a) => a === "invalidate").length, 1, "one invalidation happened, one row may exist");
    assert.equal(acts.filter((a) => a === LLM_SUGGEST_ACTION).length, 2, "but the judge was still asked, twice");
  } finally {
    db.cleanup();
  }
});

test("a record text containing $& or $' reaches the prompt verbatim", async () => {
  // String.prototype.replace treats these as replacement patterns, so a record containing
  // them would splice template fragments into the prompt.
  const template = "OLD:\n{old}\n\nNEW:\n{new}\n\nAnswer.";
  const nasty = "price is $& and $' and $` and $$1";
  const rendered = renderPrompt(
    {
      oldRecord: {
        record_id: "a",
        type: "episodic",
        created_time: "2026-01-01T00:00:00.000Z",
        content: nasty,
      },
      newRecord: {
        record_id: "b",
        type: "episodic",
        created_time: "2026-01-02T00:00:00.000Z",
        content: "new body",
      },
    },
    template,
  );
  assert.ok(rendered.includes(nasty), "the old record must appear byte for byte");
  assert.ok(rendered.includes("new body"));
  assert.equal(rendered.includes("{old}"), false, "no placeholder may survive");
  assert.equal(rendered.includes("{new}"), false);
});

// ─────────────────────────── non-supersede verdicts ───────────────────────────

test("keep-both and unrelated never write invalid_at, even in apply past the gate", async () => {
  for (const verdict of ["keep-both", "unrelated"]) {
    const db = seededDb();
    try {
      const reply = '{"verdict":"' + verdict + '","confidence":0.8}';
      const result = await run(db.path, "apply", 0.0, fakeProvider(reply));
      assert.equal(result.rejection, null, "the gate passed; the verdict is what stops the write");
      assert.deepEqual(result.invalidated, [], verdict + " must not invalidate anything");
      assert.deepEqual(snapshot(db.path).invalidIds, []);
    } finally {
      db.cleanup();
    }
  }
});

// ─────────────────────────── failure degrades to no-opinion ───────────────────────────

test("a provider that throws yields no verdict and writes nothing", async () => {
  const db = seededDb();
  try {
    const before = snapshot(db.path);
    const result = await run(db.path, "apply", 0.0, fakeProvider(async () => {
      throw new Error("network down");
    }));
    assert.equal(result.outcomes[0].verdict, null);
    assert.match(result.outcomes[0].error ?? "", /network down/);
    // The refusal is recorded, not skipped: a persistently broken judge must not look
    // like a working one that simply had nothing to say.
    assert.equal(snapshot(db.path).audit, before.audit + 1);
    assert.deepEqual(snapshot(db.path).invalidIds, []);
  } finally {
    db.cleanup();
  }
});

test("a timeout yields no verdict, not a supersede", async () => {
  const db = seededDb();
  try {
    const never = new Promise<string>(() => {});
    const result = await runCriteria({
      dbPath: db.path,
      pairs: PAIRS,
      mode: "apply",
      judge: { provider: fakeProvider(() => never), timeoutMs: 30 },
      measuredFalseSupersedeRate: 0.0,
    });
    assert.equal(result.outcomes[0].verdict, null);
    assert.match(result.outcomes[0].error ?? "", /timed out/);
    assert.deepEqual(result.invalidated, []);
  } finally {
    db.cleanup();
  }
});

test("an unparseable reply is a no-verdict, not a default", async () => {
  const db = seededDb();
  try {
    for (const junk of ["I think it supersedes", '{"verdict":"maybe"}', "{not json}", ""]) {
      const r = await judgePair(
        {
          oldRecord: { record_id: "o", content: "a", type: "episodic", created_time: "" },
          newRecord: { record_id: "n", content: "b", type: "episodic", created_time: "" },
        },
        { provider: fakeProvider(junk) },
      );
      assert.equal(r.verdict, null, "junk reply " + JSON.stringify(junk) + " must not produce a verdict");
      assert.ok(r.error, "and it must say why");
    }
  } finally {
    db.cleanup();
  }
});

test("parseVerdict accepts a fenced or chatty reply but still validates the verdict", () => {
  const ok = parseVerdict('Sure! Here you go:\n' + '```json\n' + '{"verdict":"keep-both","confidence":0.5}' + '\n```');
  assert.equal(ok.verdict, "keep-both");
  assert.equal(ok.confidence, 0.5);
  const bad = parseVerdict('{"verdict":"SUPERSEDE","confidence":0.9}');
  assert.equal(bad.verdict, null, "case matters; an unrecognised verdict is not coerced");
});

test("judgePair has no branch that invents a supersede", async () => {
  // Enumerate the ways a call can go wrong and assert none of them yields a verdict.
  const failures: Array<[string, JudgeProvider]> = [
    ["throws", fakeProvider(async () => { throw new Error("boom"); })],
    ["empty", fakeProvider("")],
    ["prose", fakeProvider("the second one replaces the first")],
    ["wrong enum", fakeProvider('{"verdict":"yes","confidence":1}')],
    ["null verdict", fakeProvider('{"verdict":null,"confidence":1}')],
  ];
  for (const [label, provider] of failures) {
    const r = await judgePair(
      {
        oldRecord: { record_id: "o", content: "a", type: "episodic", created_time: "" },
        newRecord: { record_id: "n", content: "b", type: "episodic", created_time: "" },
      },
      { provider },
    );
    assert.notEqual(r.verdict, "supersede", "failure path " + label + " must not produce supersede");
    assert.equal(r.verdict, null, "failure path " + label + " must produce no verdict at all");
  }
});

// ─────────────────────────── prompt construction ───────────────────────────

test("the prompt carries both records in full, not a similarity score", () => {
  const prompt = renderPrompt({
    oldRecord: { record_id: "o", content: "完整正文甲".repeat(50), type: "episodic", created_time: "2026-01-01" },
    newRecord: { record_id: "n", content: "完整正文乙".repeat(50), type: "episodic", created_time: "2026-02-01" },
  });
  assert.ok(prompt.includes("完整正文甲".repeat(50)), "old content must be present verbatim");
  assert.ok(prompt.includes("完整正文乙".repeat(50)), "new content must be present verbatim");
  assert.match(prompt, /keep-both/, "the safe answer must be in the instructions");
  assert.match(prompt, /When unsure/i);
});

// ─────────────────────────── sampling and measurement ───────────────────────────

test("sampling is deterministic for a fixed seed and database", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    const records = Array.from({ length: 40 }, (_, i) =>
      makeRecord({
        record_id: `r${String(i).padStart(2, "0")}`,
        // Two scenes, near-identical neighbours, so pairs survive the similarity band.
        scene_name: "scene-" + (i % 2),
        content: `第 ${i} 条：这条记忆记录检索与访问追踪的实测结论，正文足够长以便参与相关性判断。`,
        created_time: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 3_600_000).toISOString(),
      }),
    );
    insertRecords(db.path, records);
    const a = samplePairs(db.path, { size: 10 }).map((p) => p.pairId);
    const b = samplePairs(db.path, { size: 10 }).map((p) => p.pairId);
    assert.deepEqual(a, b, "same database and seed must give the same review set");
  } finally {
    db.cleanup();
  }
});

test("the false-supersede rate is computed over supersede calls only", () => {
  const pairs = [
    { pairId: "a", oldId: "1", newId: "2", humanVerdict: "supersede" as const },
    { pairId: "b", oldId: "3", newId: "4", humanVerdict: "keep-both" as const },
    { pairId: "c", oldId: "5", newId: "6", humanVerdict: "keep-both" as const },
  ];
  const judged = new Map([
    ["a", "supersede" as const],
    ["b", "supersede" as const], // false supersede
    ["c", "keep-both" as const],
  ]);
  const m = evaluate(pairs, judged);
  assert.equal(m.trueSupersede, 1);
  assert.equal(m.falseSupersede, 1);
  assert.equal(m.falseSupersedeRate, 0.5, "1 false out of 2 supersede calls");
  assert.equal(m.labelled, 3);
});

test("a judge that never says supersede gets a null rate, not 0%", () => {
  const pairs = [{ pairId: "a", oldId: "1", newId: "2", humanVerdict: "supersede" as const }];
  const m = evaluate(pairs, new Map([["a", "keep-both" as const]]));
  assert.equal(m.falseSupersedeRate, null, "no supersede calls means there is nothing to be wrong about");
  assert.equal(m.missedSupersede, 1, "but the miss is still counted");
});

test("unlabelled pairs are excluded from the rate", () => {
  const pairs = [
    { pairId: "a", oldId: "1", newId: "2", humanVerdict: "supersede" as const },
    { pairId: "b", oldId: "3", newId: "4" }, // not labelled yet
  ];
  const m = evaluate(pairs, new Map([
    ["a", "supersede" as const],
    ["b", "supersede" as const],
  ]));
  assert.equal(m.labelled, 1);
  assert.equal(m.falseSupersedeRate, 0, "the unlabelled one is not evidence either way");
});

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

/** Run the CLI and return status/stdout/stderr instead of throwing on non-zero. */
function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
test("the CLI refuses --mode=apply without a measurement, exit code 5", () => {
  const db = seededDb();
  try {
    const setPath = join(db.dir, "set.json");
    writeFileSync(
      setPath,
      JSON.stringify({ version: "t", sampling: "manual", source: "test", createdAt: "x", pairs: PAIRS }),
      "utf8",
    );
    const r = cli([
      CLI, "criteria", "--db", db.path, "--pairs", setPath, "--mode", "apply",
      "--judge-url", "http://127.0.0.1:9/v1/chat/completions", "--judge-model", "m",
    ]);
    assert.equal(r.status, 5, "the gate rejection has its own exit code");
    assert.match(r.stderr, /--mode=apply refused/);
    assert.match(r.stderr, /no false-supersede measurement/);
    assert.deepEqual(snapshot(db.path).invalidIds, [], "and nothing was written");
  } finally {
    db.cleanup();
  }
});

test("an EMPTY --false-supersede-rate is no measurement, not a perfect zero", () => {
  // "--false-supersede-rate=" happens whenever a shell variable is unset, and
  // Number("") is 0 — which reads as "measured 0%, gate open" and lets every supersede
  // through. That is the fail-open the gate exists to prevent, arriving through the
  // argument parser instead of through checkApplyGate.
  const db = seededDb();
  try {
    const setPath = join(db.dir, "set.json");
    writeFileSync(
      setPath,
      JSON.stringify({ version: "t", sampling: "manual", source: "test", createdAt: "x", pairs: PAIRS }),
      "utf8",
    );
    for (const raw of ["", "   "]) {
      const r = cli([
        CLI, "criteria", "--db", db.path, "--pairs", setPath, "--mode", "apply",
        "--judge-url", "http://127.0.0.1:9/v1/chat/completions", "--judge-model", "m",
        "--false-supersede-rate=" + raw,
      ]);
      assert.equal(r.status, 5, "blank rate must not open the gate");
      assert.match(r.stderr, /no false-supersede measurement/);
      assert.deepEqual(snapshot(db.path).invalidIds, [], "and nothing may be written");
    }
  } finally {
    db.cleanup();
  }
});

test("audit --suggestions exposes what the judge has been saying", async () => {
  // Before this, llm-suggest rows existed only as table rows: nothing in the CLI read them
  // back, so "what has the judge been saying" needed hand-written SQL.
  const db = seededDb();
  try {
    const read = () =>
      execFileSync(process.execPath, [CLI, "audit", "--db", db.path, "--suggestions", "--json"], {
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });

    // The table does not exist until migrate() runs, and the CLI is reached before that.
    // "No table" means "no suggestions yet", not a raw SQLite error out of the command.
    assert.deepEqual(JSON.parse(read()), [], "no judge has run yet, so there is nothing to show");

    await run(db.path, "shadow");
    const rows = JSON.parse(read()) as Array<{ record_id: string; reason: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].record_id, "old");
    assert.match(rows[0].reason, /verdict=supersede/);
  } finally {
    db.cleanup();
  }
});

test("audit --suggestions on a never-migrated database says none, instead of erroring", () => {
  // The audit table only exists after migrate(). A CLI asked "what has the judge been
  // saying" against a pristine database should answer "nothing", not surface a raw
  // sqlite "no such table" and exit 1 — that reads as a broken command, not an empty one.
  const db = createTempDb();
  try {
    const r = cli([CLI, "audit", "--db", db.path, "--suggestions", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);
  } finally {
    db.cleanup();
  }
});

// ─────────────────────────── the run report ───────────────────────────

test("a shadow run writes a report that carries the gate's own input", async () => {
  const db = seededDb();
  const dir = scratchDir();
  const path = join(dir, "report.json");
  try {
    await runCriteria({
      dbPath: db.path,
      pairs: PAIRS,
      mode: "shadow",
      judge: { provider: fakeProvider(SUPRESEDE_REPLY) },
      measuredFalseSupersedeRate: null,
      reportPath: path,
    });

    const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(report.report, "criteria-run/1");
    assert.equal(report.mode, "shadow");
    assert.equal(report.promptVersion, PROMPT_VERSION);
    assert.equal(report.measuredFalseSupersedeRate, null, "the gate's input is recorded even when absent");
    assert.equal(report.pairs, 1);
    assert.equal(report.judged, 1);
    assert.equal((report.verdicts as Record<string, number>).supersede, 1);
    // A shadow report must not read as if something had been invalidated.
    assert.deepEqual(report.invalidated, []);
    assert.equal(report.gateAllowed, null, "shadow has no gate outcome to claim");
  } finally {
    db.cleanup();
  }
});

test("the report a run writes is enough to recompute the rate it is asked to justify", async () => {
  // The gate's input comes from outside the run, so the run's own report has to carry
  // enough to reproduce the number. This walks the whole chain: judge -> report ->
  // verdicts -> evaluate, and checks the rate is the same at both ends.
  const db = seededDb();
  const dir = scratchDir();
  const reportPath = join(dir, "run.json");
  try {
    const pairs = [
      { pairId: "old__new", oldId: "old", newId: "new", humanVerdict: "keep-both" as const },
    ];
    const result = await runCriteria({
      dbPath: db.path,
      pairs,
      mode: "shadow",
      judge: { provider: fakeProvider(SUPRESEDE_REPLY) },
      measuredFalseSupersedeRate: null,
      reportPath,
    });

    // Step 1: the report holds the machine verdicts, keyed by pair.
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      outcomes: Array<{ pairId: string; verdict: string | null }>;
    };
    const verdicts = new Map(report.outcomes.map((o) => [o.pairId, o.verdict as "supersede" | null]));
    assert.equal(verdicts.get("old__new"), "supersede");
    assert.deepEqual(verdicts, new Map(result.outcomes.map((o) => [o.pairId, o.verdict])));

    // Step 2: a third party replays the set through evaluate and gets the same verdict.
    const m = evaluate(pairs, verdicts as Map<string, "supersede">);
    assert.equal(m.falseSupersede, 1, "the judge said supersede where the human said keep-both");
    assert.equal(m.falseSupersedeRate, 1, "one supersede call, one of them wrong");
    // The number that would be pasted into the gate is above the threshold, so apply
    // would be refused — which is the entire point of measuring before acting.
    assert.ok(m.falseSupersedeRate! >= LLM_APPLY_MAX_FALSE_SUPERSEDE);
  } finally {
    db.cleanup();
  }
});

test("an unlabelled set produces a null rate, so it cannot open the gate", async () => {
  const db = seededDb();
  try {
    // No humanVerdict anywhere: this is a freshly sampled set, which is the normal state
    // of the world before somebody sits down and labels it.
    const pairs = [{ pairId: "old__new", oldId: "old", newId: "new" }];
    const result = await runCriteria({
      dbPath: db.path,
      pairs,
      mode: "shadow",
      judge: { provider: fakeProvider(SUPRESEDE_REPLY) },
      measuredFalseSupersedeRate: null,
    });
    const verdicts = new Map(result.outcomes.map((o) => [o.pairId, o.verdict as "supersede"]));
    const m = evaluate(pairs, verdicts);
    assert.equal(m.labelled, 0);
    assert.equal(m.falseSupersedeRate, null, "no labels means no rate, and no rate means no apply");
    assert.equal(m.falseSupersede, 0, "and it must not be reported as a clean 0% either");
  } finally {
    db.cleanup();
  }
});

test("no --report means no file is written", async () => {
  const db = seededDb();
  const dir = scratchDir();
  try {
    await runCriteria({
      dbPath: db.path,
      pairs: PAIRS,
      mode: "shadow",
      judge: { provider: fakeProvider(SUPRESEDE_REPLY) },
      measuredFalseSupersedeRate: null,
    });
    // The directory was created but nothing asked for a report, so it must stay empty.
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    db.cleanup();
  }
});
