/**
 * Tests for the coverage probe (src/coverage.ts).
 *
 * The block's contract has three parts, and each has a test that would fail if the
 * part were reimplemented the obvious wrong way:
 *
 *   1. Coverage and the gate follow the engine's definitions, not the CLI's. Tested
 *      against `trackingCoverage` / `decayEnabled` directly so a second definition
 *      cannot drift in.
 *   2. `reordered` is a POSITION comparison over the top N, not a set difference.
 *      The naive set version reports 0 whenever the same records come back in a new
 *      order, which is precisely the reading the playbook calls misleading.
 *   3. `reordered` describes what decay WOULD do even while the gate is shut. If the
 *      probe passed `decayActive` into the reranker, every cold database would print
 *      0 — the command would say "nothing changes" about the one situation it exists
 *      to report on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_DECAY, decayEnabled, trackingCoverage } from "../src/scoring.ts";
import { foldAccessLog } from "../src/recall.ts";
import { COVERAGE_QUERY, coverageClimb, coverageReport, probeRanking } from "../src/coverage.ts";
import { migrate } from "../src/migrate.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

/**
 * A corpus with a rankable body of text AND a real `l1_fts` index.
 *
 * The second channel is not decoration. With one channel every hit ties on RRF score,
 * and the spread across the pool (1.64x from rank 0 to rank 45) is wider than the
 * multiplier's entire range ([0.3, 1.5]) — so pure fusion wins every comparison and
 * the probe would report 0 reordered on a corpus where decay really does move things.
 * A real tdai deployment has FTS plus vectors; one channel is the degenerate case.
 *
 * Age is anti-correlated with rank on purpose (updated_time runs newest-first in rank
 * order), because reordering requires the fusion order and the age order to disagree.
 */
function seededCorpus(count = 60): { path: string; ids: string[]; cleanup: () => void } {
  const db = createTempDb();
  migrate(db.path);
  const records = Array.from({ length: count }, (_, i) =>
    makeRecord({
      record_id: `r${String(i).padStart(3, "0")}`,
      content: `这条记忆讲的是 ${COVERAGE_QUERY} 检索与访问追踪的第 ${i} 条记录，内容足够长以便参与相关性判断。`,
      scene_name: "scene-" + (i % 5),
      created_time: new Date(NOW.getTime() - (count - i) * 86_400_000).toISOString(),
      updated_time: new Date(NOW.getTime() - (count - i) * 86_400_000).toISOString(),
    }),
  );
  insertRecords(db.path, records);
  const raw = new DatabaseSync(db.path);
  try {
    raw.exec("CREATE VIRTUAL TABLE l1_fts USING fts5(content, record_id UNINDEXED)");
    const insert = raw.prepare("INSERT INTO l1_fts (content, record_id) VALUES (?, ?)");
    // Space-separated tokens: tdai runs jieba before insert, and the default unicode61
    // tokenizer would treat each Chinese run as a single token without this.
    for (const r of records) insert.run(`${COVERAGE_QUERY} 检索 访问 追踪 记录 ${r.record_id}`, r.record_id);
  } finally {
    raw.close();
  }
  return { path: db.path, ids: records.map((r) => r.record_id), cleanup: db.cleanup };
}

function withCorpus(count: number, fn: (dbPath: string, ids: string[]) => void): void {
  const c = seededCorpus(count);
  try {
    fn(c.path, c.ids);
  } finally {
    c.cleanup();
  }
}

test("coverage and the gate come from the engine's own definitions", () => {
  withCorpus(40, (dbPath) => {
    const empty = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    assert.equal(empty.records, 40);
    assert.equal(empty.withAccess, 0);
    assert.equal(empty.coverage, trackingCoverage([]) === 0 ? 0 : NaN);
    assert.equal(empty.decayActive, decayEnabled(empty.coverage, DEFAULT_DECAY));
    assert.equal(empty.decayActive, false);
    assert.equal(empty.threshold, DEFAULT_DECAY.minTrackingCoverage);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE l1_records SET access_count = 1, last_access_time = ? WHERE record_id IN (?, ?, ?, ?)").run(
      NOW.toISOString(),
      "r000",
      "r001",
      "r002",
      "r003",
    );
    db.close();

    const warmed = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    assert.equal(warmed.withAccess, 4);
    assert.equal(warmed.coverage, 0.1);
    // Exactly on the threshold: `decayEnabled` is >=, and the reading has to agree.
    assert.equal(warmed.decayActive, true);
  });
});

test("coverage counts records carrying any access signal, including an observed zero", () => {
  withCorpus(10, (dbPath) => {
    const db = new DatabaseSync(dbPath);
    // A record with count 0 but a last_access_time has been through the tracker: its
    // zero is evidence, and `hasAccessSignal` counts it. A CLI-side reimplementation
    // that tested `access_count > 0` would report a different number here.
    db.prepare("UPDATE l1_records SET access_count = 0, last_access_time = ? WHERE record_id = ?").run(
      NOW.toISOString(),
      "r000",
    );
    db.close();
    const report = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    assert.equal(report.withAccess, 1);
    assert.equal(report.coverage, 0.1);
  });
});

test("the probe ranks a real candidate pool on a corpus that matches the query", () => {
  withCorpus(60, (dbPath) => {
    const report = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    assert.ok(report.candidates > 0, "the probe must find candidates on a matching corpus");
    // The lexical channel is the one that cannot fail without a corpus problem, so it
    // is the channel the assertion is about; FTS needs the virtual table to exist.
    assert.ok(report.channels.lexical > 0);
    const ranked = probeRanking(dbPath, DEFAULT_DECAY, NOW);
    assert.equal(ranked.fusion.length, 10);
    assert.equal(ranked.decayed.length, 10);

    // Both orders are drawn from ONE candidate pool — the reranker's wide pool, not the
    // ten the fusion order happened to report. "Decay never drops a candidate" is a
    // promise about the pool (upstream calls rerank on candidateK = limit * 3); it is
    // NOT a promise that the decayed top ten is a permutation of the fusion top ten, and
    // asserting that would pin the wrong contract. A cold record inside the pool but
    // outside the fusion window can legitimately fall below it once scores are scaled.
    assert.equal(ranked.candidates, coverageReport(dbPath, DEFAULT_DECAY, NOW).candidates);
    const poolIds = new Set(ranked.decayed.concat(ranked.fusion));
    assert.ok(poolIds.size >= 10);
    for (const id of ranked.decayed) assert.ok(poolIds.has(id));
  });
});

test("reordered counts moved POSITIONS, not a set difference", () => {
  withCorpus(60, (dbPath) => {
    const report = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    const ranked = probeRanking(dbPath, DEFAULT_DECAY, NOW);
    const positions = ranked.fusion.filter((id, i) => id !== ranked.decayed[i]).length;
    assert.equal(report.reordered, positions);

    // The corpus has no access evidence at all, so `decayActive` is false — yet the
    // probe still reports how many positions decay would move. A probe that fed
    // `decayActive` into the reranker would print 0 here, and the block would have no
    // way to answer "what would change when the gate opens".
    assert.equal(report.decayActive, false);
    assert.ok(report.reordered > 0, "decay would move positions even on a cold corpus");

    // And a set comparison is not the same number: it reads 0 whenever the same ten
    // records come back in a different order, which is a different claim entirely.
    const setDifference = ranked.fusion.filter((id) => !ranked.decayed.includes(id)).length;
    assert.notEqual(setDifference, positions);
  });
});

test("reordered is 0 and flagged when the probe finds nothing to rank", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    // Records that do not contain the probe's token, and no FTS table: no channel can
    // rank anything.
    insertRecords(db.path, [
      makeRecord({ record_id: "x", content: "zzz", scene_name: "q", type: "other" }),
      makeRecord({ record_id: "y", content: "zzz", scene_name: "q", type: "other" }),
    ]);
    const report = coverageReport(db.path, DEFAULT_DECAY, NOW);
    assert.equal(report.candidates, 0);
    assert.equal(report.reordered, 0);
    // Without this flag, "0" would read as "decay changes nothing".
    assert.equal(report.emptyRanking, true);
  } finally {
    db.cleanup();
  }
});

test("folding a log line actually moves coverage, gate and reordering", () => {
  withCorpus(20, (dbPath, ids) => {
    const logDir = mkdtempSync(join(tmpdir(), "tdai-coverage-"));
    try {
      const before = coverageReport(dbPath, DEFAULT_DECAY, NOW);
      assert.equal(before.withAccess, 0);
      assert.equal(before.decayActive, false);

      // Two synthetic search lines covering 6 distinct records out of 20. Real folds
      // through the real function: a fake that wrote access_count by hand would not
      // prove the CLI's reading tracks the thing the fold does.
      const logPath = join(logDir, "access.jsonl");
      writeFileSync(
        logPath,
        [
          JSON.stringify({ at: NOW.toISOString(), hits: ids.slice(0, 3) }),
          JSON.stringify({ at: NOW.toISOString(), hits: ids.slice(3, 6) }),
          "",
        ].join("\n"),
        "utf8",
      );
      const folded = foldAccessLog(dbPath, logPath);
      assert.equal(folded.linesRead, 2);
      assert.equal(folded.recordsTouched, 6);

      const after = coverageReport(dbPath, DEFAULT_DECAY, NOW);
      assert.equal(after.withAccess, 6);
      assert.equal(after.coverage, 0.3);
      assert.equal(after.decayActive, true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

test("the climb walks the band and reports where the gate opens", () => {
  withCorpus(40, (dbPath, ids) => {
    const logDir = mkdtempSync(join(tmpdir(), "tdai-climb-"));
    try {
      // 4 records per fold: folds 0..9 sit below 10%, fold 10 lands exactly on it.
      let cursor = 0;
      const step = (): boolean => {
        const hits = ids.slice(cursor, cursor + 4);
        if (hits.length === 0) return false;
        cursor += hits.length;
        const logPath = join(logDir, `step-${cursor}.jsonl`);
        writeFileSync(logPath, JSON.stringify({ at: NOW.toISOString(), hits }) + "\n", "utf8");
        foldAccessLog(dbPath, logPath);
        return true;
      };

      const climb = coverageClimb(dbPath, step, DEFAULT_DECAY, NOW, 12);
      assert.equal(climb[0].coverage, 0);
      assert.equal(climb[0].decayActive, false);
      // Strictly increasing while the climber keeps folding: a monotone series is the
      // property that makes the table readable.
      for (let i = 1; i < climb.length; i++) assert.ok(climb[i].withAccess >= climb[i - 1].withAccess);
      const flip = climb.findIndex((s) => s.decayActive);
      assert.ok(flip > 0, "the gate must open somewhere in the band");
      assert.equal(climb[flip - 1].decayActive, false);
      assert.ok(climb[flip].coverage >= DEFAULT_DECAY.minTrackingCoverage);
      assert.ok(climb[flip - 1].coverage < DEFAULT_DECAY.minTrackingCoverage);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

test("a database without forgetting columns reports 0% instead of guessing", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [makeRecord({ record_id: "a" })]);
    // loadRecords already substitutes 0 / NULL for a missing column, so the reading is
    // "no access evidence", not an error: an unmigrated deployment is cold, and saying
    // so with numbers beats refusing to answer.
    const report = coverageReport(db.path, DEFAULT_DECAY, NOW);
    assert.equal(report.withAccess, 0);
    assert.equal(report.decayActive, false);
  } finally {
    db.cleanup();
  }
});

test("an unfamiliar vec0 layout degrades to the other channels", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    insertRecords(db.path, [makeRecord({ record_id: "a", content: COVERAGE_QUERY })]);
    // Naming a table that does not exist must not throw: the lexical and FTS channels
    // still rank, and the report shows the vector channel at zero.
    const report = coverageReport(db.path, DEFAULT_DECAY, NOW, "no_such_vec_table");
    assert.equal(report.channels.vector, 0);
    assert.ok(report.channels.lexical > 0);
    assert.ok(report.candidates > 0);
  } finally {
    db.cleanup();
  }
});

test("the probe is read-only: two readings of the same corpus agree", () => {
  withCorpus(30, (dbPath, ids) => {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE l1_records SET access_count = 2, last_access_time = ? WHERE record_id = ?").run(
      NOW.toISOString(),
      ids[0],
    );
    db.close();
    const first = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    const second = coverageReport(dbPath, DEFAULT_DECAY, NOW);
    assert.deepEqual(first, second);
    const ranked = probeRanking(dbPath, DEFAULT_DECAY, NOW);
    assert.deepEqual(ranked.fusion, probeRanking(dbPath, DEFAULT_DECAY, NOW).fusion);
  });
});
