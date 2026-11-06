/**
 * Tests for bench/sweep.ts.
 *
 * The script is spawned rather than imported for the same reason `cli-fold` spawns
 * the CLI: its contract is a CSV on disk plus an exit code, and stderr, and only a
 * real process exercises all three.
 *
 * The load-bearing test is the last one. A sweep is only useful if its numbers mean
 * what the published benchmark's numbers mean; the moment the two drivers disagree
 * about precision, every historical figure becomes incomparable and nobody notices
 * because both still print plausible decimals. So the default grid point is required
 * to reproduce `run-bench.ts`'s `forgetting` row, computed by a separately spawned
 * process against the same corpus.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLUSTER_OPTIONS } from "../src/redundancy.ts";

const SWEEP = fileURLToPath(new URL("../bench/sweep.ts", import.meta.url));
const BENCH = fileURLToPath(new URL("../bench/run-bench.ts", import.meta.url));

interface SweepRun {
  status: number;
  stderr: string;
  csv: string;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tdai-sweep-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the sweep into `<dir>/out.csv` and return what the caller can actually observe. */
function sweepInto(dir: string, args: string[]): SweepRun {
  const out = join(dir, "out.csv");
  const result = spawnSync(process.execPath, [SWEEP, ...args, "--out", out], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? "",
    csv: existsSync(out) ? readFileSync(out, "utf8") : "",
  };
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  return {
    header: lines[0].split(","),
    rows: lines.slice(1).map((line) => line.split(",")),
  };
}

const EXPECTED_HEADER = [
  "halfLifeDays",
  "floor",
  "minTrackingCoverage",
  "clusterThreshold",
  "archiveThreshold",
  "retireThreshold",
  "decayActive",
  "precisionAtK",
  "pinRecall",
  "dupShare",
  "evictedShare",
];

test("the default point writes the header plus one row carrying the shipped defaults", () => {
  withTmp((dir) => {
    const { status, csv } = sweepInto(dir, []);
    assert.equal(status, 0);

    const { header, rows } = parseCsv(csv);
    assert.deepEqual(header, EXPECTED_HEADER);
    assert.equal(rows.length, 1, "no --grid means exactly one combination");
    // Read from DEFAULT_DECAY / DEFAULT_CLUSTER_OPTIONS / DEFAULT_EVICTION, not typed
    // into the sweep: D4 revises a default, and a stale copy here would keep
    // calibrating a value the system no longer uses.
    assert.deepEqual(rows[0].slice(0, 6), ["10", "0.2", "0.1", "0.7", "0.45", "0.25"]);
    assert.equal(rows[0][6], "true", "synthetic corpus carries access history, so the gate opens");
  });
});

test("two --grid flags expand to their Cartesian product", () => {
  withTmp((dir) => {
    const { status, csv } = sweepInto(dir, ["--grid", "halfLifeDays=7,14,30", "--grid", "floor=0.2,0.3"]);
    assert.equal(status, 0);

    const { rows } = parseCsv(csv);
    assert.equal(rows.length, 6, "3 half-lives x 2 floors");
    // Cartesian order: the first flag varies slowest.
    assert.deepEqual(rows[0].slice(0, 2), ["7", "0.2"]);
    assert.deepEqual(rows[1].slice(0, 2), ["7", "0.3"]);
    assert.deepEqual(rows[5].slice(0, 2), ["30", "0.3"]);
  });
});

test("a value outside its domain is skipped with a reason, and the exit code stays 0", () => {
  withTmp((dir) => {
    const { status, stderr, csv } = sweepInto(dir, ["--grid", "floor=0.3,1.5"]);
    assert.equal(status, 0, "a bad point in a grid is data about the grid, not a failed run");
    assert.match(stderr, /skipped combination: floor=1\.5 must be in \[0, 1\]/);

    const { rows } = parseCsv(csv);
    assert.equal(rows.length, 1, "the legal point is still written");
    assert.equal(rows[0][1], "0.3");
  });
});

test("a malformed --grid is a command-line error, not a skipped combination", () => {
  withTmp((dir) => {
    const unknownKey = sweepInto(dir, ["--grid", "nonsense=1"]);
    assert.equal(unknownKey.status, 2);
    assert.match(unknownKey.stderr, /unknown grid key "nonsense"/);

    const notANumber = sweepInto(dir, ["--grid", "floor=abc"]);
    assert.equal(notANumber.status, 2);
    assert.match(notANumber.stderr, /"abc" is not a number/);
  });
});

test("the same grid run twice produces the same rows", () => {
  withTmp((dir) => {
    const first = sweepInto(dir, ["--grid", "halfLifeDays=14,60", "--grid", "clusterThreshold=0.5,0.7"]);
    const second = sweepInto(dir, ["--grid", "halfLifeDays=14,60", "--grid", "clusterThreshold=0.5,0.7"]);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.deepEqual(parseCsv(first.csv).rows, parseCsv(second.csv).rows);
  });
});

test("the default point reproduces run-bench's forgetting row", () => {
  // The whole point of extracting the harness: one definition of precision, so a
  // sweep row and the published benchmark describe the same measurement. If this
  // fails, the two drivers have drifted and no historical number is comparable.
  withTmp((dir) => {
    const { rows } = parseCsv(sweepInto(dir, []).csv);
    assert.equal(rows.length, 1);

    const bench = spawnSync(process.execPath, [BENCH, "--queries", "24", "--k", "10", "--no-embeddings"], {
      encoding: "utf8",
    });
    assert.equal(bench.status, 0, bench.stderr);
    const line = (bench.stdout ?? "").split("\n").find((l) => l.startsWith("forgetting"));
    assert.ok(line, "run-bench must print a forgetting row");

    // Columns: configuration precision@k top1 dupShare pinRecall avgScore
    const cells = line.trim().split(/\s+/).slice(1).map(Number);
    const [benchPrecision, , benchDupShare, benchPinRecall] = cells;

    const close = (actual: string, expected: number, label: string): void => {
      // sweep prints 4 decimals, run-bench 3: compare at the coarser resolution.
      assert.ok(
        Math.abs(Number(actual) - expected) <= 0.001,
        `${label}: sweep ${actual} vs run-bench ${expected.toFixed(3)}`,
      );
    };
    close(rows[0][7], benchPrecision, "precisionAtK");
    close(rows[0][8], benchPinRecall, "pinRecall");
    close(rows[0][9], benchDupShare, "dupShare");
  });
});

test("--corpus longtext runs and writes a row", () => {
  withTmp((dir) => {
    const { status, csv } = sweepInto(dir, ["--corpus", "longtext"]);
    assert.equal(status, 0, "the third corpus must run, not just be parsed");
    const { rows } = parseCsv(csv);
    assert.equal(rows.length, 1);
  });
});

test("--describe writes the corpus profile to stderr and leaves the CSV alone", () => {
  withTmp((dir) => {
    const { status, stderr, csv } = sweepInto(dir, ["--corpus", "longtext", "--describe"]);
    assert.equal(status, 0);
    assert.match(stderr, /corpus longtext: 120 records/);
    assert.match(stderr, /length \(chars\): min \d+, p50 \d+, p90 \d+, max \d+/);
    assert.match(stderr, new RegExp(`duplicate groups at ${DEFAULT_CLUSTER_OPTIONS.threshold}: \\d+`));
    // A corpus profile describes the input; a CSV row describes an output. Mixing
    // them would produce one table whose columns mean two different things.
    assert.deepEqual(parseCsv(csv).header, EXPECTED_HEADER);
  });
});
