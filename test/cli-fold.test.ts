/**
 * Tests for the `fold` CLI command.
 *
 * The command is spawned as a child process rather than imported: its contract is the
 * exit code and the printed lines, and a caller that cannot see stderr only has those
 * two. A test that called an exported helper would leave "does a failed rename actually
 * exit non-zero" unverified, which is the whole point of this block.
 *
 * The rename-failure case needs care. The obvious construction — point --log under a
 * path whose parent is a regular file — never reaches renameSync at all: foldAccessLog
 * returns early on `!existsSync(logPath)` with all-zero counters, which is a no-op, not
 * a failure. Asserting "exit non-zero" against that would be asserting the CLI reports
 * failure for an empty log, the exact opposite of the contract. So this test builds a
 * collision that foldAccessLog really does trip: the archive name is
 * `<logPath>.folded-<iso timestamp>`, and renameSync refuses to replace a non-empty
 * directory. Pre-creating those directories across a few seconds of wall clock makes the
 * rename fail with the log still readable, which is the Windows "file is held open"
 * shape the command exists to surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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

/** `key <n>` anywhere on the line; the keys contain spaces, so match leniently. */
function field(stdout: string, key: string): string {
  const m = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[ ]+(.*)").exec(stdout);
  assert.ok(m, `output must contain "${key}", got:\n${stdout}`);
  return m[1].trim();
}

/** A seeded db plus a log directory, both torn down by the caller's finally block. */
function withCorpus(
  seedLog: (logPath: string) => void,
  fn: (dbPath: string, logPath: string, logDir: string) => void,
): void {
  const db = createTempDb();
  const logDir = mkdtempSync(join(tmpdir(), "tdai-cli-fold-"));
  try {
    migrate(db.path);
    insertRecords(db.path, [makeRecord({ record_id: "a" }), makeRecord({ record_id: "b" })]);
    const logPath = join(logDir, "access.jsonl");
    seedLog(logPath);
    fn(db.path, logPath, logDir);
  } finally {
    db.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
}

/**
 * Make the archive rename fail: pre-create a non-empty directory for every timestamp the
 * fold could stamp within a window around now. renameSync will not replace a directory,
 * so whichever millisecond it lands on, the target is occupied.
 *
 * The window has to cover the whole child process spawn (measured at ~95 ms locally, but
 * node --test runs files in parallel and the suite can stretch that). A window that is
 * too small makes this test flaky in the worst way — it would pass only by accident when
 * the fold happens to land inside it — so the caller asserts the collision really landed
 * by checking that the fold's own archive name was one of the directories we created.
 */
function occupyArchiveNames(logPath: string, windowMs = 3000): { created: Set<string>; base: number } {
  // Anchor to the real instant, not to the start of the current second. Quantizing to the
  // second made the effective forward reach as short as windowMs - 999 ms, which is what let
  // this test pass locally and fail under `node --test`'s parallel file scheduling.
  const base = Date.now();
  const created = new Set<string>();
  for (let ms = -1000; ms <= windowMs; ms += 1) {
    const name = logPath + ".folded-" + new Date(base + ms).toISOString().replace(/[:.]/g, "-");
    try {
      mkdirSync(name);
      writeFileSync(join(name, "occupant"), "held open by another process");
      created.add(name);
    } catch {
      /* already created by an earlier iteration */
    }
  }
  return { created, base };
}

/** Reconstruct the archive path for a wall-clock instant, the way recall.ts names it. */
function archiveNameFor(logPath: string, at: number): string {
  return logPath + ".folded-" + new Date(at).toISOString().replace(/[:.]/g, "-");
}

test("fold accumulates counts, takes the newest access time, and archives the log", () => {
  withCorpus(
    (logPath) => {
      writeFileSync(
        logPath,
        [
          JSON.stringify({ at: "2026-10-01T00:00:00.000Z", hits: ["a"] }),
          JSON.stringify({ at: "2026-10-20T00:00:00.000Z", hits: ["a", "b"] }),
          JSON.stringify({ at: "2026-10-10T00:00:00.000Z", hits: ["a"] }),
          "",
        ].join("\n"),
      );
    },
    (dbPath, logPath, logDir) => {
      const r = runCli(["fold", "--db", dbPath, "--log", logPath]);
      assert.equal(r.status, 0, r.stderr);

      // Hard-coded: three lines, two distinct records, two rows updated. Reading these
      // back out of the implementation would let a wrong implementation agree with itself.
      assert.equal(field(r.stdout, "log lines"), "3");
      assert.equal(field(r.stdout, "records"), "2");
      assert.equal(field(r.stdout, "rows updated"), "2");

      // The newest "at" wins even though it is not the last line written -- the log is
      // append-ordered, not time-ordered, and last_access_time must not go backwards.
      // DatabaseSync.get() returns a null-prototype object, which deepEqual rejects on
      // prototype; spread it so the assertion is about the values, not the prototype.
      assert.deepEqual({ ...readAccess(dbPath, "a") }, {
        access_count: 3,
        last_access_time: "2026-10-20T00:00:00.000Z",
      });
      assert.deepEqual({ ...readAccess(dbPath, "b") }, {
        access_count: 1,
        last_access_time: "2026-10-20T00:00:00.000Z",
      });

      // The rename is what makes "folded" mean folded.
      const archives = readdirSync(logDir);
      assert.equal(existsSync(logPath), false, "the log must be gone after a successful fold");
      assert.equal(archives.length, 1);
      assert.match(archives[0], /^access\.jsonl\.folded-/);
      assert.equal(field(r.stdout, "archived to"), join(logDir, archives[0]));
    },
  );
});

test("a second fold reads nothing and double-counts nothing", () => {
  withCorpus(
    (logPath) => {
      writeFileSync(logPath, JSON.stringify({ at: "2026-10-26T12:00:00.000Z", hits: ["a"] }) + "\n");
    },
    (dbPath, logPath) => {
      const first = runCli(["fold", "--db", dbPath, "--log", logPath]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(readAccess(dbPath, "a").access_count, 1);

      const second = runCli(["fold", "--db", dbPath, "--log", logPath]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(field(second.stdout, "log lines"), "0");
      assert.equal(field(second.stdout, "records"), "0");
      assert.equal(field(second.stdout, "rows updated"), "0");
      // The counter is the assertion that matters: the rename removed the input, so the
      // replay has nothing to add. If it moved, "folded" is a lie.
      assert.equal(readAccess(dbPath, "a").access_count, 1);
    },
  );
});

test("a fold whose log cannot be renamed exits non-zero and says so on stderr", () => {
  withCorpus(
    (logPath) => {
      writeFileSync(logPath, JSON.stringify({ at: "2026-10-26T12:00:00.000Z", hits: ["a"] }) + "\n");
    },
    (dbPath, logPath) => {
      const { created: occupied, base } = occupyArchiveNames(logPath, 15000);
      assert.ok(occupied.size > 0, "the collision window must actually create candidate directories");

      const r = runCli(["fold", "--db", dbPath, "--log", logPath]);
      const after = Date.now();
      const before = base;

      // Prove the collision really landed instead of trusting that this run fell inside
      // the window. The fold stamps its archive name from its own clock, which lies at or
      // after `base` (the instant the occupancy was laid down) and before `after`, so if
      // every candidate in that range was ours the rename was guaranteed to hit one.
      // Without this check a too-narrow window would show up as a silent pass ("rename
      // succeeded"), which is the opposite of the behaviour under test.
      const collides = [];
      for (let t = before; t <= after; t++) collides.push(occupied.has(archiveNameFor(logPath, t)));
      assert.ok(
        collides.some(Boolean),
        `no pre-created directory covered the fold's archive name (${before}..${after}); widen windowMs`,
      );

      // Not 0: the counters are committed but the log survived, so a second fold would
      // double-count. Silent success here is the defect this command exists to prevent.
      assert.notEqual(r.status, 0, "a failed rename must not exit 0");
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stderr, /could not be archived/, "stderr must name the failure");
      assert.match(r.stderr, /double-count/, "stderr must say what the consequence is");
      assert.match(r.stdout, /\(rename failed — log NOT archived, next fold would double-count\)/);
      assert.match(r.stdout, /warning: log NOT archived/);

      // The work landed: this is why the exit code is a failure and not a no-op.
      assert.equal(readAccess(dbPath, "a").access_count, 1);
      assert.equal(existsSync(logPath), true, "the un-archived log is still there to replay by hand");

      // And the hazard is real, not theoretical: folding again replays the same line,
      // so the count goes 1 -> 2 for one access. Both folds also exit non-zero, because
      // the log still cannot be archived.
      const again = runCli(["fold", "--db", dbPath, "--log", logPath]);
      assert.equal(readAccess(dbPath, "a").access_count, 2, "the still-present log is replayed: 1 -> 2");
      assert.equal(again.status, 3, again.stdout + again.stderr);
    },
  );
});

test("--json emits a FoldResult that JSON.parse accepts, and a no-op fold still exits 0", () => {
  withCorpus(
    (logPath) => {
      writeFileSync(logPath, JSON.stringify({ at: "2026-10-26T12:00:00.000Z", hits: ["a"] }) + "\n");
    },
    (dbPath, logPath) => {
      const r = runCli(["fold", "--db", dbPath, "--log", logPath, "--json"]);
      assert.equal(r.status, 0, r.stderr);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      assert.equal(parsed.linesRead, 1);
      assert.equal(parsed.recordsTouched, 1);
      assert.equal(parsed.rowsUpdated, 1);
      assert.equal(typeof parsed.archivePath, "string");

      // A missing log folds nothing, so there is nothing that could have failed to archive.
      // Reporting this as an error would break the documented no-op contract.
      const missing = runCli(["fold", "--db", dbPath, "--log", join(logPath, "..", "nope.jsonl"), "--json"]);
      assert.equal(missing.status, 0, missing.stderr);
      assert.deepEqual(JSON.parse(missing.stdout), { linesRead: 0, recordsTouched: 0, rowsUpdated: 0 });
    },
  );
});
