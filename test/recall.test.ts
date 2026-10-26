import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_RECALL_LOG, appendRecall, foldAccessLog, reinforce } from "../src/recall.ts";
import { migrate } from "../src/migrate.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function withLog(fn: (logPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tdai-recall-"));
  try {
    fn(join(dir, "access.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readAccess(dbPath: string, id: string): { access_count: number; last_access_time: string | null } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT access_count, last_access_time FROM l1_records WHERE record_id = ?").get(id) as {
      access_count: number;
      last_access_time: string | null;
    };
  } finally {
    db.close();
  }
}

test("appendRecall writes one line per search and skips deep hits", () => {
  withLog((logPath) => {
    assert.equal(
      appendRecall(logPath, [{ record_id: "a", rank: 1 }, { record_id: "b", rank: 2 }], NOW),
      true,
    );
    assert.equal(appendRecall(logPath, [{ record_id: "deep", rank: 99 }], NOW), false);
    assert.equal(appendRecall(logPath, [], NOW), false);

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).hits, ["a", "b"]);
    assert.equal(JSON.parse(lines[0]).at, NOW.toISOString());
  });
});

test("appendRecall honours a custom rank window", () => {
  withLog((logPath) => {
    appendRecall(logPath, [{ record_id: "deep", rank: 5 }], NOW, { maxRankCounted: 3 });
    assert.equal(existsSync(logPath), false);
  });
});

test("an unwritable log path fails quietly instead of killing the search", () => {
  assert.equal(appendRecall("Z:\\nope\\access.jsonl", [{ record_id: "a", rank: 1 }], NOW), false);
});

test("fold accumulates counts and keeps the newest access time", () => {
  const db = createTempDb();
  withLog((logPath) => {
    try {
      migrate(db.path);
      insertRecords(db.path, [makeRecord({ record_id: "a" }), makeRecord({ record_id: "b" })]);
      appendRecall(logPath, [{ record_id: "a", rank: 1 }], new Date("2026-10-01T00:00:00.000Z"));
      appendRecall(logPath, [{ record_id: "a", rank: 1 }], new Date("2026-10-20T00:00:00.000Z"));
      appendRecall(logPath, [{ record_id: "a", rank: 2 }], new Date("2026-10-10T00:00:00.000Z"));

      const result = foldAccessLog(db.path, logPath);
      assert.equal(result.linesRead, 3);
      assert.equal(result.recordsTouched, 1);
      assert.equal(result.rowsUpdated, 1);

      const access = readAccess(db.path, "a");
      assert.equal(access.access_count, 3);
      assert.equal(access.last_access_time, "2026-10-20T00:00:00.000Z", "must not go backwards");
    } finally {
      db.cleanup();
    }
  });
});

test("fold renames the log so it cannot be double-counted", () => {
  const db = createTempDb();
  withLog((logPath) => {
    try {
      migrate(db.path);
      insertRecords(db.path, [makeRecord({ record_id: "a" })]);
      appendRecall(logPath, [{ record_id: "a", rank: 1 }], NOW);
      const result = foldAccessLog(db.path, logPath);
      assert.ok(result.archivePath);
      assert.equal(existsSync(logPath), false);
      assert.equal(existsSync(result.archivePath as string), true);
      assert.equal(foldAccessLog(db.path, logPath).linesRead, 0);
      assert.equal(readAccess(db.path, "a").access_count, 1);
    } finally {
      db.cleanup();
    }
  });
});

test("a folded log with no matching records is archived, not replayed forever", () => {
  const db = createTempDb();
  withLog((logPath) => {
    try {
      migrate(db.path);
      appendRecall(logPath, [{ record_id: "ghost", rank: 1 }], NOW);
      const result = foldAccessLog(db.path, logPath);
      assert.equal(result.recordsTouched, 1);
      assert.equal(result.rowsUpdated, 0);
      assert.equal(existsSync(logPath), false);
    } finally {
      db.cleanup();
    }
  });
});

test("a torn final line from a crash mid-append is skipped", () => {
  const db = createTempDb();
  withLog((logPath) => {
    try {
      migrate(db.path);
      insertRecords(db.path, [makeRecord({ record_id: "a" })]);
      writeFileSync(
        logPath,
        JSON.stringify({ at: NOW.toISOString(), hits: ["a"] }) + "\n" + '{"at":"2026-10-26T12:00:0',
        "utf8",
      );
      const result = foldAccessLog(db.path, logPath);
      assert.equal(result.linesRead, 2);
      assert.equal(readAccess(db.path, "a").access_count, 1);
    } finally {
      db.cleanup();
    }
  });
});

test("folding a missing log is a no-op", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    assert.deepEqual(foldAccessLog(db.path, join(tmpdir(), "definitely-not-here.jsonl")), {
      linesRead: 0,
      recordsTouched: 0,
      rowsUpdated: 0,
    });
  } finally {
    db.cleanup();
  }
});

test("multiple folds accumulate rather than replace", () => {
  const db = createTempDb();
  withLog((logPath) => {
    try {
      migrate(db.path);
      insertRecords(db.path, [makeRecord({ record_id: "a" })]);
      appendRecall(logPath, [{ record_id: "a", rank: 1 }], NOW);
      foldAccessLog(db.path, logPath);
      appendRecall(logPath, [{ record_id: "a", rank: 1 }, { record_id: "a", rank: 3 }], NOW);
      foldAccessLog(db.path, logPath);
      assert.equal(readAccess(db.path, "a").access_count, 3);
    } finally {
      db.cleanup();
    }
  });
});

test("reinforce bumps a cited record directly", () => {
  const db = createTempDb();
  try {
    migrate(db.path);
    insertRecords(db.path, [makeRecord({ record_id: "cited" })]);
    assert.equal(reinforce(db.path, ["cited"], NOW), 1);
    assert.equal(reinforce(db.path, ["missing"], NOW), 0);
    assert.equal(readAccess(db.path, "cited").access_count, 1);
  } finally {
    db.cleanup();
  }
});

test("the default rank window is a documented constant, not a magic number", () => {
  assert.equal(DEFAULT_RECALL_LOG.maxRankCounted, 10);
});
