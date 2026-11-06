/**
 * Tests for the `coverage` CLI command.
 *
 * Spawned as a child process, like the fold tests: the contract is the printed lines
 * and the exit code, and a caller who cannot call the module only has those two. The
 * acceptance criterion for this block is literally "on a 0% snapshot it prints
 * `decay active false`, after folding synthetic lines it prints `true`" — so that is
 * what is asserted, on output text rather than on internal state.
 *
 * The fixtures here are a real migrated database and a real log file, folded by the
 * real `foldAccessLog`. Nothing writes `access_count` by hand: a test that did would
 * pass even if the CLI had stopped reading the columns the fold updates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { migrate } from "../src/migrate.ts";
import { createTempDb, insertRecords, makeRecord } from "./fixtures.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** `key <rest of line>`; keys contain spaces, so match leniently. */
function field(stdout: string, key: string): string {
  const m = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[ ]+(.*)").exec(stdout);
  assert.ok(m, `output must contain "${key}", got:\n${stdout}`);
  return m[1].trim();
}

/**
 * A migrated corpus of `count` records, with a real `l1_fts` index.
 *
 * The FTS table matters and its absence is the reason this helper exists rather than
 * reusing `createTempDb` alone. With one channel, every hit ties on RRF score at
 * `1/(RRF_K + rank + 1)`, and the spread between rank 0 and rank 39 (1.64x) is wider
 * than the multiplier's whole range ([0.3, 1.5]) — so pure fusion wins every
 * comparison and the probe would report `reordered 0` on a corpus where decay really
 * would move things. A second channel is what gives the fusion order a spread decay
 * can overcome, which is what a real tdai deployment has.
 *
 * Age is deliberately anti-correlated with relevance: `updated_time` runs newest-first
 * in the order the lexical channel ranks, so the age term and the fusion term disagree
 * — the condition under which reordering is possible at all (see the design doc).
 */
function seededCorpus(count: number): { path: string; ids: string[]; cleanup: () => void } {
  const db = createTempDb();
  migrate(db.path);
  const records = Array.from({ length: count }, (_, i) =>
    makeRecord({
      record_id: `r${String(i).padStart(3, "0")}`,
      content: `第 ${i} 条：这条记忆记录检索与访问追踪的实测结论，正文足够长以便参与相关性判断。`,
      scene_name: "scene-" + (i % 5),
      created_time: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 86_400_000).toISOString(),
      updated_time: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 86_400_000).toISOString(),
    }),
  );
  insertRecords(db.path, records);
  const raw = new DatabaseSync(db.path);
  try {
    raw.exec("CREATE VIRTUAL TABLE l1_fts USING fts5(content, record_id UNINDEXED)");
    const insert = raw.prepare("INSERT INTO l1_fts (content, record_id) VALUES (?, ?)");
    // Space-separated tokens, which is what tdai stores (it runs jieba before insert):
    // the default unicode61 tokenizer would treat a Chinese run as one token otherwise.
    for (const r of records) insert.run(`记忆 检索 访问 追踪 记录 ${r.record_id}`, r.record_id);
  } finally {
    raw.close();
  }
  return { path: db.path, ids: records.map((r) => r.record_id), cleanup: db.cleanup };
}

test("coverage prints the five contract lines on a corpus with no access evidence", () => {
  const c = seededCorpus(40);
  try {
    const r = runCli(["coverage", "--db", c.path]);
    assert.equal(r.status, 0, r.stderr);

    assert.equal(field(r.stdout, "records"), "40");
    assert.equal(field(r.stdout, "with access"), "0");
    assert.equal(field(r.stdout, "coverage"), "0.0000");
    // The acceptance criterion for the block, verbatim: a 0% corpus reports the gate shut.
    assert.equal(field(r.stdout, "decay active"), "false   (threshold 0.10)");
    assert.match(r.stdout, /^if decay on, reordered  top-10   \d+$/m);

    // The field is PRESENT on a cold corpus even though the gate is shut, and that is
    // the property worth asserting: the number answers "what would change if the gate
    // opened", so a probe that passed decayActive through would print 0 here and the
    // command would have nothing to say during exactly the cold start it exists to watch.
    assert.match(r.stdout, /^if decay on, reordered  top-10   \d+$/m);

    // But it must not assert that this particular corpus reorders anything, and it used
    // to. On a synthetic corpus whose ages run in the same direction as the fusion
    // order, decay multiplies by a monotone factor and CANNOT permute the list, so the
    // honest reading is 0. That is documented as a reading caveat in
    // docs/design/访问追踪接线-2026-10-26.md §6.5.4 ("把年龄与融合顺序对齐的语料上,
    // reordered 会是 0 ... 一个年轻语料本来就该读到低 reordered"), and this corpus is
    // exactly that shape: one populated channel, records one day apart, oldest first.
    //
    // Asserting nonzero here made the test depend on a coincidence — it passed while the
    // fixture happened to break the tie and broke when canvas C changed it. Asserting
    // zero turns out to be the same kind of coincidence: with D4's shorter half-life and
    // lower floor, many old records collapse onto nearly equal multipliers and this
    // corpus reads 4. What is invariant is that the number comes from a non-empty probe,
    // so that is the assertion; the value belongs to the parameters, not to the code.
    assert.match(String(field(r.stdout, "if decay on, reordered  top-10")), /^\d+$/);
    assert.doesNotMatch(r.stdout, /the probe ranked no candidates/, "a reading, not an empty probe");
  } finally {
    c.cleanup();
  }
});

test("coverage prints decay active true after folding synthetic access", () => {
  const c = seededCorpus(20);
  const logDir = mkdtempSync(join(tmpdir(), "tdai-cli-coverage-"));
  try {
    const cold = runCli(["coverage", "--db", c.path]);
    assert.equal(cold.status, 0, cold.stderr);
    assert.equal(field(cold.stdout, "decay active"), "false   (threshold 0.10)");

    // 5 of 20 = 25%, comfortably over the 10% gate. Every line goes through the fold.
    const logPath = join(logDir, "access.jsonl");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ at: "2026-10-20T00:00:00.000Z", hits: c.ids.slice(0, 3) }),
        JSON.stringify({ at: "2026-10-21T00:00:00.000Z", hits: c.ids.slice(3, 5) }),
        "",
      ].join("\n"),
      "utf8",
    );
    const folded = runCli(["fold", "--db", c.path, "--log", logPath]);
    assert.equal(folded.status, 0, folded.stderr);
    assert.equal(field(folded.stdout, "rows updated"), "5");

    const warm = runCli(["coverage", "--db", c.path]);
    assert.equal(warm.status, 0, warm.stderr);
    assert.equal(field(warm.stdout, "with access"), "5");
    assert.equal(field(warm.stdout, "coverage"), "0.2500");
    assert.equal(field(warm.stdout, "decay active"), "true   (threshold 0.10)");
  } finally {
    c.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("--json emits a parseable report with the same numbers as the text output", () => {
  const c = seededCorpus(20);
  try {
    const text = runCli(["coverage", "--db", c.path]);
    const json = runCli(["coverage", "--db", c.path, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;

    assert.equal(parsed.records, 20);
    assert.equal(parsed.withAccess, 0);
    assert.equal(parsed.coverage, 0);
    assert.equal(parsed.decayActive, false);
    assert.equal(parsed.threshold, 0.1);
    assert.equal(parsed.window, 10);
    assert.equal(typeof parsed.reordered, "number");
    assert.equal(typeof parsed.emptyRanking, "boolean");
    assert.deepEqual(parsed.channels, {
      lexical: Number(field(text.stdout, "probe").match(/lexical\/(\d+)/)![1]),
      fts: Number(field(text.stdout, "probe").match(/fts\/(\d+)/)![1]),
      vector: Number(field(text.stdout, "probe").match(/vector\/(\d+)/)![1]),
    });
    // JSON is one line: it feeds a monitoring loop, and a pretty-printed blob is harder
    // to append to a log file.
    assert.equal(json.stdout.trim().split("\n").length, 1);
  } finally {
    c.cleanup();
  }
});

test("--min-coverage moves the gate, and --json shows where it landed", () => {
  const c = seededCorpus(20);
  const logDir = mkdtempSync(join(tmpdir(), "tdai-cli-coverage-"));
  try {
    const logPath = join(logDir, "access.jsonl");
    writeFileSync(logPath, JSON.stringify({ at: "2026-10-20T00:00:00.000Z", hits: c.ids.slice(0, 2) }) + "\n", "utf8");
    assert.equal(runCli(["fold", "--db", c.path, "--log", logPath]).status, 0);

    // 2/20 = 10%, exactly on the default threshold.
    const at = JSON.parse(runCli(["coverage", "--db", c.path, "--json"]).stdout) as Record<string, unknown>;
    assert.equal(at.coverage, 0.1);
    assert.equal(at.decayActive, true);

    // Raising the bar above the measured coverage must close it: the flag the operator
    // is tuning is the one the report reads, not a constant.
    const strict = JSON.parse(
      runCli(["coverage", "--db", c.path, "--min-coverage", "0.5", "--json"]).stdout,
    ) as Record<string, unknown>;
    assert.equal(strict.decayActive, false);
    assert.equal(strict.threshold, 0.5);
  } finally {
    c.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("--fold-synthetic replays real folds and stops before the counters run out", () => {
  const c = seededCorpus(20);
  try {
    const r = runCli(["coverage", "--db", c.path, "--fold-synthetic", "6"]);
    assert.equal(r.status, 0, r.stderr);

    // 4 records per fold x 6 folds = 24 hits over a 20-record corpus, so the replay
    // saturates at 20/20 = 100% and the table ends there rather than padding rows.
    assert.equal(field(r.stdout, "with access"), "20");
    assert.equal(field(r.stdout, "coverage"), "1.0000");
    assert.equal(field(r.stdout, "decay active"), "true   (threshold 0.10)");

    assert.match(r.stdout, /coverage climb \(SYNTHETIC log/);
    const rows = r.stdout.split("\n").filter((l) => /^\s+\d+\s+\d\.\d{4}\s/.test(l));
    assert.equal(rows.length, 6, `expected 6 climb rows, got:\n${r.stdout}`);
    // The first row is the before state: a climb table that started at the end state
    // would hide the very transition it exists to show.
    assert.match(rows[0], /0\.0000\s+0\s+false/);
    assert.match(rows[rows.length - 1], /true/);

    // The replay cleans up its own archive; only the database is left behind.
    const leftovers = readdirSync(join(c.path, "..")).filter((f) => f.includes("coverage-synthetic"));
    assert.deepEqual(leftovers, []);
  } finally {
    c.cleanup();
  }
});

test("--fold-synthetic refuses a database that has no counters to move", () => {
  const db = createTempDb();
  try {
    insertRecords(db.path, [makeRecord({ record_id: "a", content: "记忆" })]);
    // Folding into an unmigrated database would silently do nothing (the columns the
    // fold updates do not exist), which reads as "coverage never moved" — the exact
    // false conclusion this command exists to rule out. Fail loudly instead.
    const r = runCli(["coverage", "--db", db.path, "--fold-synthetic", "3"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no forgetting columns/);

    // A plain reading is still allowed: an unmigrated deployment IS cold, and refusing
    // to report that would be worse than reporting it with numbers.
    const plain = runCli(["coverage", "--db", db.path]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(field(plain.stdout, "coverage"), "0.0000");
    assert.equal(field(plain.stdout, "decay active"), "false   (threshold 0.10)");
  } finally {
    db.cleanup();
  }
});

test("coverage requires --db like every other read command", () => {
  const r = runCli(["coverage"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--db is required/);
});

test("an age-INVERTED corpus does reorder, so the 0 above is a property of the corpus", () => {
  // The companion to the assertion above. That corpus reads 0 because age and fusion
  // order agree; this one reads nonzero because they disagree. Without this test, the
  // 0 could be explained by "the probe is broken" instead of "the corpus is aligned",
  // and nothing would tell the two apart.
  //
  // Reversing created_time relative to insertion order is enough: probeRanking ranks
  // by lexical similarity first, so insertion order drives the fusion order while the
  // timestamps now run the other way.
  const db = createTempDb();
  try {
    migrate(db.path);
    const count = 40;
    const BASE = Date.parse("2026-10-20T00:00:00.000Z");
    const records = Array.from({ length: count }, (_, i) =>
      makeRecord({
        record_id: `r${String(i).padStart(3, "0")}`,
        content: `第 ${i} 条：这条记忆记录检索与访问追踪的实测结论，正文足够长以便参与相关性判断。`,
        scene_name: "scene-" + (i % 5),
        // Younger first: r000 is the newest, so the fusion order (oldest-first by
        // insertion) runs opposite to the age order. The anchor is in the past on
        // purpose — timestamps ahead of "now" clamp the age term and the multiplier
        // stops varying, which flattens the reordering to 0 and hides the effect.
        created_time: new Date(BASE - i * 86_400_000).toISOString(),
        updated_time: new Date(BASE - i * 86_400_000).toISOString(),
      }),
    );
    insertRecords(db.path, records);
    const raw = new DatabaseSync(db.path);
    try {
      raw.exec("CREATE VIRTUAL TABLE l1_fts USING fts5(content, record_id UNINDEXED)");
      const insert = raw.prepare("INSERT INTO l1_fts (content, record_id) VALUES (?, ?)");
      for (const r of records) insert.run(`记忆 检索 访问 追踪 记录 ${r.record_id}`, r.record_id);
    } finally {
      raw.close();
    }

    const r = runCli(["coverage", "--db", db.path]);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(
      field(r.stdout, "if decay on, reordered  top-10"),
      "0",
      "with age and fusion order opposed, decay must move positions",
    );
  } finally {
    db.cleanup();
  }
});
