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
  // A path whose parent is a regular file fails on every platform. A
  // platform-specific absolute path does not: on Linux the same string is a legal
  // relative filename, so the append succeeds there and the assertion flips. This
  // test originally used one, and CI caught it on ubuntu-latest.
  const dir = mkdtempSync(join(tmpdir(), "tdai-recall-bad-"));
  try {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "x");
    assert.equal(appendRecall(join(blocker, "access.jsonl"), [{ record_id: "a", rank: 1 }], NOW), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ── Wiring evidence (b2-wire-append) ──
//
// The tests above cover appendRecall in isolation. These cover the shape the
// search path actually uses: the hit list built from the returned records, the
// path handed in by config, and the failure that must stay quiet.

test("appendRecall round-trips record ids and rank order for a search's hits", () => {
  // Mirrors executeMemorySearch: trimmed.map((r, i) => ({ record_id: r.id, rank: i + 1 })).
  // These ids stand in for SearchItem.id — the field toSearchItem renamed from
  // record_id. Getting that rename wrong writes undefined and still returns true.
  const returnedIds = ["m_a", "m_b", "m_c"];
  withLog((logPath) => {
    const hits = returnedIds.map((id, i) => ({ record_id: id, rank: i + 1 }));
    assert.equal(appendRecall(logPath, hits, NOW), true);

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "one search writes one line, not one per hit");
    const parsed = JSON.parse(lines[0]) as { at: string; hits: string[] };
    assert.equal(parsed.at, NOW.toISOString());
    assert.deepEqual(parsed.hits, returnedIds, "order is rank, and ids are the record ids");
    assert.deepEqual(Object.keys(parsed).sort(), ["at", "hits"]);
    assert.ok(parsed.hits.every((id) => typeof id === "string" && id.length > 0));
  });
});

test("one search appends one line rather than one per hit", () => {
  withLog((logPath) => {
    const hits = Array.from({ length: 10 }, (_, i) => ({ record_id: "m_" + i, rank: i + 1 }));
    appendRecall(logPath, hits, NOW);
    assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1);
  });
});

test("rank 11 is not counted: the rank window is enforced, not assumed", () => {
  // The manifest requires proof that the cutoff is real. A hit at rank 11 and
  // deeper is "appeared in the candidate pool", not "was returned".
  withLog((logPath) => {
    appendRecall(logPath, [{ record_id: "m_11", rank: 11 }], NOW);
    assert.equal(existsSync(logPath), false, "rank 11 alone must write nothing");

    appendRecall(
      logPath,
      [
        { record_id: "m_10", rank: 10 },
        { record_id: "m_11", rank: 11 },
        { record_id: "m_12", rank: 12 },
      ],
      NOW,
    );
    const parsed = JSON.parse(readFileSync(logPath, "utf8").trim()) as { hits: string[] };
    assert.deepEqual(parsed.hits, ["m_10"], "rank 10 counts, rank 11 and 12 do not");
  });
});

test("a failed write returns false without throwing, leaving the search intact", () => {
  // Mirrors a deployment whose log parent was never created (or was replaced by
  // a file). appendFileSync does not create directories, so this is the
  // realistic failure — and it must not surface to the caller.
  const dir = mkdtempSync(join(tmpdir(), "tdai-recall-unwritable-"));
  try {
    const blocker = join(dir, "access-parent");
    writeFileSync(blocker, "not a directory");
    const logPath = join(blocker, "recall-access.jsonl");

    let threw = false;
    let result: boolean | undefined;
    try {
      result = appendRecall(logPath, [{ record_id: "m_a", rank: 1 }], NOW);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "appendRecall must never throw: a lost record is not a failed search");
    assert.equal(result, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the patch ships a copy of this exact module, not a divergent one", () => {
  // The repo does not contain MemoryCore/src/forgetting/recall.ts — it only
  // exists after the patch is applied. What must hold is that the patch adds
  // the same code tested above, not a second implementation that drifts.
  const patch = readFileSync(join(import.meta.dirname, "..", "patches", "0104-l1-recall-telemetry.patch"), "utf8");
  const marker = "diff --git a/MemoryCore/src/forgetting/recall.ts b/MemoryCore/src/forgetting/recall.ts";
  const at = patch.indexOf(marker);
  assert.notEqual(at, -1, "0104 must add the shipped module");
  // Bound the slice at the next file header: the patch contains several files,
  // and everything after this marker would otherwise be read as this file's body.
  const next = patch.indexOf("\ndiff --git ", at + marker.length);
  const body = next < 0 ? patch.slice(at) : patch.slice(at, next);
  const added = body
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  const shipped = readFileSync(join(import.meta.dirname, "..", "src", "recall.ts"), "utf8");
  // Two differences here are checkout artefacts, not divergence: a file ends with
  // a newline and a patch body does not, and *.patch is marked -text while
  // src/*.ts is not, so core.autocrlf=true hands this file back as CRLF on Windows
  // while the patch body stays LF. Compare the code, not the transport.
  const asWritten = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
  assert.equal(asWritten(added), asWritten(shipped), "the shipped copy must be this file");
});
// ── The configured rank window reaches the log (FE-001 P1-a) ──
//
// REV-001 found `memory.recall.accessLog.maxRankCounted` declared, parsed, and
// read by nobody: executeMemorySearch hardcoded DEFAULT_RECALL_LOG, so an
// operator who set 3 still got rank 1–10 on disk. The fix threads the configured
// value through executeMemorySearch({ maxRankCounted }) instead of re-hardcoding
// the constant at the sink.
//
// These tests run in the harness repo, which mirrors only src/recall.ts and its
// peers — MemoryCore/src/config.ts and core/tools/memory-search.ts are not on
// this module graph. So they prove the two halves they can reach: the window
// semantics on real bytes, and that the shipped patch no longer hardcodes the
// constant at the call site while it does forward the parameter.

test("with maxRankCounted: 3 the rank=4 hit is not written — the configured window is real", () => {
  // The end-to-end shape of the bug: four hits, a window of 3, one line whose
  // hits array stops at rank 3. Under the old hardcoded DEFAULT_RECALL_LOG the
  // same input wrote all four, which is the silent no-op REV-001 reported.
  withLog((logPath) => {
    const hits = ["m_1", "m_2", "m_3", "m_4"].map((id, i) => ({ record_id: id, rank: i + 1 }));
    // Exactly what executeMemorySearch does now: path and window both come from
    // the caller's config rather than from the module constant.
    assert.equal(appendRecall(logPath, hits, NOW, { maxRankCounted: 3 }), true);

    const parsed = JSON.parse(readFileSync(logPath, "utf8").trim()) as { hits: string[] };
    assert.deepEqual(parsed.hits, ["m_1", "m_2", "m_3"], "rank 4 must not be written");
    assert.ok(!parsed.hits.includes("m_4"), "the configured window must exclude rank 4");

    // And the default window still writes all four — the two cases must differ,
    // otherwise the assertion above would pass even with the window ignored.
    const defaultPath = logPath + ".default";
    appendRecall(defaultPath, hits, NOW, DEFAULT_RECALL_LOG);
    const wide = JSON.parse(readFileSync(defaultPath, "utf8").trim()) as { hits: string[] };
    assert.deepEqual(wide.hits, ["m_1", "m_2", "m_3", "m_4"]);
  });
});

test("the shipped patch forwards maxRankCounted instead of hardcoding the default", () => {
  // Guards the exact regression REV-001 found: the sink calling appendRecall with
  // DEFAULT_RECALL_LOG while the config key existed and parsed. Reading the patch
  // is the only vantage point available here (see the comment block above).
  const patch = readFileSync(
    join(import.meta.dirname, "..", "patches", "0104-l1-recall-telemetry.patch"),
    "utf8",
  );

  // 1. executeMemorySearch declares the parameter and destructures it.
  assert.match(
    patch,
    /^\+\s+maxRankCounted\?: number;$/m,
    "executeMemorySearch must accept the configured window",
  );
  assert.match(patch, /^\+\s+maxRankCounted,$/m, "the parameter must be destructured");

  // 2. The sink passes it — and no longer reaches for the constant there.
  assert.match(
    patch,
    /^\+\s+maxRankCounted === undefined \? undefined : \{ maxRankCounted \},$/m,
    "appendRecall must receive the forwarded window",
  );
  assert.match(
    patch,
    /^\+\s+appendRecall\($/m,
    "the call must be the multi-line form that carries opts",
  );

  // 3. Every caller that resolves the log path also resolves the window, so the
  //    key has a consumer on both wired entry points (MCP tool + HTTP).
  const windowReads = patch.match(/^\+.*recallMaxRankCounted\(/gm) ?? [];
  assert.ok(
    windowReads.length >= 3,
    `expected the resolver at the definition plus both call sites, saw ${windowReads.length}`,
  );

  // 4. The dead-config shape would be a bare DEFAULT_RECALL_LOG at the sink.
  assert.doesNotMatch(
    patch,
    /^\+.*appendRecall\(accessLogPath, hits, new Date\(\), DEFAULT_RECALL_LOG\)/m,
    "the hardcoded constant at the sink is the defect; it must not come back",
  );
});

test("a search that returns nothing writes no line", () => {
  // The search path guards on trimmed.length > 0; empty results mean no record
  // ids to record, and appendRecall would return false without a line anyway.
  withLog((logPath) => {
    assert.equal(appendRecall(logPath, [], NOW), false);
    assert.equal(existsSync(logPath), false);
  });
});
