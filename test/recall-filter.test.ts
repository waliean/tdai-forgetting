import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Regression guard for the defect found while landing the patches.
 *
 * Archiving a record only sets `l1_records.state`. It does NOT remove the row from
 * `l1_fts`, and it does not touch `l1_vec`. So the obvious fix — point the recall
 * queries at the `l1_recallable` view — changes nothing, because none of the actual
 * queries read that view. The record stays retrievable by BM25 and by vector
 * similarity, and the metadata lookup on the archived row still succeeds.
 *
 * These tests pin down both halves: that the naive view alone leaks, and that the
 * JOIN form closes it without leaving a hole in the window.
 */

/**
 * A minimal stand-in for the two tables that matter, built from scratch: the shared
 * fixture already defines l1_records without a state column, and the point here is
 * the interaction between an FTS index and a lifecycle column.
 */
function buildCorpus(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "tdai-recall-filter-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "vectors.db"));
  db.exec(`
    CREATE TABLE l1_records (
      record_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active'
    );
    CREATE VIRTUAL TABLE l1_fts USING fts5(content, record_id UNINDEXED);
  `);
  const insertRecord = db.prepare("INSERT INTO l1_records (record_id, content) VALUES (?, ?)");
  const insertFts = db.prepare("INSERT INTO l1_fts (content, record_id) VALUES (?, ?)");
  for (let i = 0; i < 30; i++) {
    // The FTS column holds space-separated tokens, which is what tdai actually
    // stores (tokenizeForFts runs jieba before insert). Feeding raw Chinese here
    // would make the default unicode61 tokenizer treat each run as one token and
    // the MATCH would hit only the row where the word happens to stand alone —
    // an artefact of the fixture, not of the code under test.
    // r0 repeats the token so it ranks first: a leak that only affects records
    // ranked outside the window is a coincidence, not a defect, and this test has
    // to exercise the case that reaches the caller.
    const content = i === 0 ? "记忆 记忆 记忆 这一条 被 反复 强调 编号 0" : `记录 的 正文 包含 记忆 这个 词 编号 ${i}`;
    insertRecord.run(`r${i}`, content);
    insertFts.run(content, `r${i}`);
  }
  db.exec("CREATE VIEW l1_recallable AS SELECT * FROM l1_records WHERE state = 'active'");
  return db;
}

test("archiving does not remove the row from the FTS index", () => {
  const db = buildCorpus();
  try {
    db.prepare("UPDATE l1_records SET state = 'archived' WHERE record_id = ?").run("r0");
    const stillIndexed = db.prepare("SELECT COUNT(*) AS c FROM l1_fts WHERE record_id = ?").get("r0") as { c: number };
    assert.equal(stillIndexed.c, 1, "l1_fts is a separate table; state lives in l1_records");
  } finally {
    db.close();
  }
});

test("the view alone does not hide an archived record from the FTS query", () => {
  const db = buildCorpus();
  try {
    db.prepare("UPDATE l1_records SET state = 'archived' WHERE record_id = ?").run("r0");
    // The query as originally written: straight from l1_fts, no join.
    const rows = db
      .prepare("SELECT record_id FROM l1_fts WHERE l1_fts MATCH ? ORDER BY bm25(l1_fts) LIMIT 5")
      .all('"记忆"') as Array<{ record_id: string }>;
    assert.equal(rows.some((r) => r.record_id === "r0"), true, "this is the leak: the view is not consulted");
  } finally {
    db.close();
  }
});

test("the view does hide it from a metadata lookup", () => {
  const db = buildCorpus();
  try {
    db.prepare("UPDATE l1_records SET state = 'archived' WHERE record_id = ?").run("r0");
    const viaTable = db.prepare("SELECT record_id FROM l1_records WHERE record_id = ?").get("r0");
    const viaView = db.prepare("SELECT record_id FROM l1_recallable WHERE record_id = ?").get("r0");
    assert.ok(viaTable, "the table still has it");
    assert.equal(viaView, undefined, "the view is the one place that filters");
  } finally {
    db.close();
  }
});

test("joining the metadata table closes the leak and keeps the window full", () => {
  const db = buildCorpus();
  try {
    const patched = db.prepare(`
      SELECT f.record_id FROM l1_fts f
      JOIN l1_records m ON m.record_id = f.record_id
      WHERE l1_fts MATCH ? AND m.state = 'active'
      ORDER BY bm25(l1_fts) LIMIT 5
    `);
    const plain = db.prepare(
      "SELECT record_id FROM l1_fts WHERE l1_fts MATCH ? ORDER BY bm25(l1_fts) LIMIT 5",
    );

    const before = (plain.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);
    assert.equal(before.includes("r0"), true);

    db.prepare("UPDATE l1_records SET state = 'archived' WHERE record_id = ?").run("r0");

    const afterPlain = (plain.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);
    const afterPatched = (patched.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);

    assert.equal(afterPlain.includes("r0"), true, "unpatched query still leaks");
    assert.equal(afterPatched.includes("r0"), false, "patched query must not return it");
    // The window backfills from the next-ranked row rather than shrinking: a caller
    // asking for 5 still gets 5.
    assert.equal(afterPatched.length, 5, "no hole left in the candidate window");
  } finally {
    db.close();
  }
});

test("an archived record's vector produces a skipped hit, not a half-filled result", () => {
  const db = buildCorpus();
  try {
    db.prepare("UPDATE l1_records SET state = 'archived' WHERE record_id = ?").run("r0");
    // searchL1Vector looks the metadata up and continues on a miss; this asserts the
    // lookup semantics that make that skip path reachable.
    const meta = db
      .prepare("SELECT record_id, content FROM l1_recallable WHERE record_id = ?")
      .get("r0") as { record_id: string; content: string } | undefined;
    assert.equal(meta, undefined);
  } finally {
    db.close();
  }
});
