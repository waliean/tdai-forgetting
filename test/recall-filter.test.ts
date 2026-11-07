import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      state TEXT NOT NULL DEFAULT 'active',
      invalid_at TEXT DEFAULT NULL,
      superseded_by TEXT DEFAULT NULL
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
  // Mirrors the condition 0105 ships. Keeping the fixture's view in sync with the
  // patched one is the point: a test whose schema has drifted from the patch proves
  // nothing about the patch.
  db.exec(
    "CREATE VIEW l1_recallable AS SELECT * FROM l1_records WHERE state = 'active' AND invalid_at IS NULL",
  );
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

/**
 * The patch under test, as shipped.
 *
 * Reading the patch file rather than pasting its SQL is the whole point: a copy
 * typed into a test is a *different* statement, and a test that exercises a copy
 * cannot fail when the shipped one drifts. (A mutation that deleted the JOIN's
 * invalid_at predicate from 0105 survived the first version of this file for
 * exactly that reason.)
 */
const PATCH_0105 = readFileSync(
  join(import.meta.dirname, "..", "patches", "0105-l1-invalid-filter.patch"),
  "utf8",
);

/** Every added line of 0105, so the assertions below run against the shipped text. */
const PATCH_0105_ADDED = PATCH_0105
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");

/** The predicates 0105 puts on the FTS join, extracted from the patch itself. */
const SHIPPED_JOIN_PREDICATES = (() => {
  const line = PATCH_0105_ADDED.split("\n").find((l) => l.includes("WHERE l1_fts MATCH ?"));
  assert.ok(line, "0105 must contain the FTS MATCH clause");
  return line;
})();

/** The view condition 0105 puts in the DDL, extracted from the patch itself. */
const SHIPPED_VIEW_PREDICATES = (() => {
  const line = PATCH_0105_ADDED.split("\n").find((l) => l.includes("CREATE VIEW l1_recallable"));
  assert.ok(line, "0105 must contain the recall view DDL");
  return line;
})();

/** The FTS query as the shipped patch writes it, with LIMIT pinned for the test. */
const PATCHED_FTS = `
  SELECT f.record_id FROM l1_fts f
  JOIN l1_records m ON m.record_id = f.record_id
  ${SHIPPED_JOIN_PREDICATES.trim()}
  ORDER BY bm25(l1_fts) LIMIT 5
`;

/** Invalidate a record the way the supersede command will: a timestamp, nothing else. */
function invalidate(db: DatabaseSync, recordId: string, by?: string): void {
  db.prepare("UPDATE l1_records SET invalid_at = ?, superseded_by = ? WHERE record_id = ?").run(
    "2026-10-01T00:00:00.000Z",
    by ?? null,
    recordId,
  );
}

test("an invalidated record keeps its FTS row, exactly like an archived one", () => {
  const db = buildCorpus();
  try {
    invalidate(db, "r0");
    const indexed = db.prepare("SELECT COUNT(*) AS c FROM l1_fts WHERE record_id = ?").get("r0") as { c: number };
    assert.equal(indexed.c, 1, "the filter is a query concern; the index row stays for restore");
  } finally {
    db.close();
  }
});

test("the widened view hides an invalidated record that is still active", () => {
  const db = buildCorpus();
  try {
    invalidate(db, "r0");
    const viaTable = db.prepare("SELECT state FROM l1_records WHERE record_id = ?").get("r0") as { state: string };
    const viaView = db.prepare("SELECT record_id FROM l1_recallable WHERE record_id = ?").get("r0");
    assert.equal(viaTable.state, "active", "invalidation is not eviction: state is untouched");
    assert.equal(viaView, undefined, "but the view is where recallability is defined");
  } finally {
    db.close();
  }
});

test("an invalidated record ranked FIRST leaves the FTS window, and it backfills", () => {
  const db = buildCorpus();
  try {
    const plain = db.prepare("SELECT record_id FROM l1_fts WHERE l1_fts MATCH ? ORDER BY bm25(l1_fts) LIMIT 5");
    const patched = db.prepare(PATCHED_FTS);

    const before = (plain.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);
    assert.equal(before[0], "r0", "precondition: the record under test must rank first, not outside the window");

    invalidate(db, "r0");

    const afterPlain = (plain.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);
    const afterPatched = (patched.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);

    assert.equal(afterPlain[0], "r0", "unfiltered query still returns it first");
    assert.equal(afterPatched.includes("r0"), false, "filtered query must not return it");
    assert.equal(afterPatched.length, 5, "the window backfills; it does not leave an empty slot");
  } finally {
    db.close();
  }
});

test("clearing invalid_at puts the record back on the recall path", () => {
  const db = buildCorpus();
  try {
    const patched = db.prepare(PATCHED_FTS);
    invalidate(db, "r0");
    assert.equal((patched.all('"记忆"') as Array<{ record_id: string }>).some((r) => r.record_id === "r0"), false);

    db.prepare("UPDATE l1_records SET invalid_at = NULL, superseded_by = NULL WHERE record_id = ?").run("r0");

    const restored = (patched.all('"记忆"') as Array<{ record_id: string }>).map((r) => r.record_id);
    assert.equal(restored.includes("r0"), true, "restore is a one-column update, and it works");
  } finally {
    db.close();
  }
});

test("an invalidated record's vector hit is skipped, not half-filled", () => {
  const db = buildCorpus();
  try {
    invalidate(db, "r0");
    // This is the branch searchL1Vector takes: a vector neighbour whose metadata
    // lookup misses is skipped outright. A half-filled result would be worse than a
    // leak, because the caller cannot tell it apart from a real record.
    const meta = db.prepare("SELECT record_id, content FROM l1_recallable WHERE record_id = ?").get("r0");
    assert.equal(meta, undefined, "no metadata means the hit is skipped, per the 0102 comment chain");
  } finally {
    db.close();
  }
});

test("the shipped patch puts the invalidation predicate in BOTH copies", () => {
  // 0105 ships the condition twice on purpose: once in the view (which stmtGetMeta
  // reads) and once inline in the FTS join (which does not read the view). Neither
  // can be derived from the other at runtime, so the guard is textual: read what the
  // patch actually adds, and require the predicate on both sides of it.
  //
  // Deleting the predicate from either line of the patch makes this test fail.
  assert.match(
    SHIPPED_VIEW_PREDICATES,
    /invalid_at IS NULL/,
    "0105's view DDL must carry the invalidation predicate",
  );
  assert.match(
    SHIPPED_JOIN_PREDICATES,
    /m\.invalid_at IS NULL/,
    "0105's FTS join must carry the invalidation predicate",
  );
  assert.match(
    SHIPPED_JOIN_PREDICATES,
    /m\.state = 'active'/,
    "removing the state filter would trade one leak for another",
  );
});

test("both copies of the recall filter agree", () => {
  const db = buildCorpus();
  try {
    // The text guard above proves both copies exist; this proves they mean the same
    // thing, by running each against identical rows instead of comparing strings.
    const viewSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='l1_recallable'").get() as { sql: string }
    ).sql;
    assert.match(viewSql, /invalid_at IS NULL/, "the view must carry the invalidation predicate");

    // And they must actually agree in behaviour, not just in text: a record each
    // predicate should hide is hidden by both.
    invalidate(db, "r0");
    const ids = ["r0", "r1", "r2"];
    for (const id of ids) {
      const inFts =
        (db.prepare(PATCHED_FTS).all('"记忆"') as Array<{ record_id: string }>).some((r) => r.record_id === id);
      const inView = db.prepare("SELECT record_id FROM l1_recallable WHERE record_id = ?").get(id) !== undefined;
      assert.equal(inFts, inView, `${id}: FTS says ${inFts}, view says ${inView}`);
    }
  } finally {
    db.close();
  }
});

test("0106 creates the invalidation columns before 0105's index needs them", () => {
  // The deployment bug this patch exists for: 0105 creates an index on `invalid_at`, and
  // no earlier patch adds that column — only src/migrate.ts does, which the container
  // never runs. On a stock database the unguarded index throws "no such column", and
  // initSchema's caller turns that into degraded mode: every store operation becomes a
  // silent no-op while the process reports healthy.
  //
  // The patch text is the assertion, because this repo cannot run the container's
  // initSchema. What can be checked is that 0106 adds both columns, guards them, and
  // lands before the index — and that the index is no longer bare.
  const patch = readFileSync(join(import.meta.dirname, "..", "patches", "0106-l1-invalidate-columns.patch"), "utf8");
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  assert.match(added, /ALTER TABLE l1_records ADD COLUMN invalid_at TEXT DEFAULT NULL/, "the column 0105 needs");
  assert.match(added, /ALTER TABLE l1_records ADD COLUMN superseded_by TEXT DEFAULT NULL/, "and its companion");
  // Both ALTERs must be guarded, exactly like 0101's: an unguarded ALTER on a migrated
  // database throws, and a throw here degrades the store. The patch preserves the file's
  // indentation, so match with leading whitespace allowed.
  for (const column of ["invalid_at", "superseded_by"]) {
    const line = added.split("\n").find((l) => l.includes(`ADD COLUMN ${column}`));
    assert.ok(line, `missing ALTER for ${column}`);
    assert.match(line.trim(), /^try \{.*\} catch \{ \/\* exists \*\/ \}$/, `${column} ALTER must be wrapped in try/catch`);
  }

  // And the index line that used to be bare must now be guarded too.
  const indexLine = added.split("\n").find((l) => l.includes("CREATE INDEX IF NOT EXISTS idx_l1_invalid_at"));
  assert.ok(indexLine, "0106 must also touch the index line");
  assert.match(indexLine.trim(), /^try \{.*\} catch/, "the index must not be able to take the store down");

  // Ordering: the ALTERs have to come before the index, or the guard is pointless.
  const alterAt = added.indexOf("ADD COLUMN invalid_at");
  const indexAt = added.indexOf("idx_l1_invalid_at");
  assert.ok(alterAt >= 0 && indexAt >= 0 && alterAt < indexAt, "columns first, then the index that uses them");
});
