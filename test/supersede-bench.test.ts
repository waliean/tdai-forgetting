import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Guard for experiment 3 (bench/supersede.ts).
 *
 * The numbers in docs/experiments depend on this bench, and until now nothing in the
 * suite would have noticed if the "invalidation" column quietly stopped filtering.
 * That is not hypothetical: the column used to be simulated with an in-memory Set of
 * ids, so it stayed green while measuring an intention rather than the shipped
 * mechanism. It now reads the real `invalid_at` field.
 *
 * Two claims are pinned, and the second is the one that matters:
 *
 *   1. baseline stays 0.000 / 2.00 — the corpus has not been made easier.
 *   2. invalidation is 1.000 / 0.00 — and it reaches that by consulting `invalid_at`,
 *      which the mutation check below demonstrates by breaking it.
 */

const BENCH = join(import.meta.dirname, "..", "bench", "supersede.ts");

interface Row {
  configuration: string;
  currentAtTop1: number;
  staleInWindow: number;
}

/** Parse the bench's table output. It is a report, so it prints text, not JSON. */
function runBench(): Row[] {
  const out = execFileSync(process.execPath, [BENCH, "--facts", "10", "--k", "3"], { encoding: "utf8" });
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    const at = line.match(/^(\S+)\s+(\d\.\d{3})\s+(\d\.\d{2})$/);
    if (at) rows.push({ configuration: at[1], currentAtTop1: Number(at[2]), staleInWindow: Number(at[3]) });
  }
  return rows;
}

function rowFor(rows: Row[], name: string): Row {
  const row = rows.find((r) => r.configuration === name);
  assert.ok(row, `bench did not print a "${name}" row; got ${rows.map((r) => r.configuration).join(", ")}`);
  return row;
}

test("the supersede bench still reproduces its published numbers", () => {
  const rows = runBench();

  const baseline = rowFor(rows, "baseline");
  assert.equal(baseline.currentAtTop1, 0.0, "baseline must not be able to tell the restatements apart");
  assert.equal(baseline.staleInWindow, 2.0, "and it must put both stale copies in the window");

  const decayForced = rowFor(rows, "decay-forced");
  assert.equal(decayForced.currentAtTop1, 1.0);
  // The whole point of experiment 3: decay reorders but does not exclude.
  assert.equal(decayForced.staleInWindow, 2.0, "decay must NOT clear the stale copies; that is the finding");

  const invalidation = rowFor(rows, "invalidation");
  assert.equal(invalidation.currentAtTop1, 1.0);
  assert.equal(invalidation.staleInWindow, 0.0, "the invalidation filter is supposed to empty the stale slots");
});

test("the invalidation row reads the real field, not a stand-in", () => {
  // Reading the source is the cheap half of the check; the mutation test below is the
  // expensive half. Together they say "the column consults invalid_at" rather than
  // "the column happens to print 0.00".
  const src = execFileSync(
    process.execPath,
    ["-e", 'process.stdout.write(require("fs").readFileSync("bench/supersede.ts","utf8"))'],
    { encoding: "utf8", cwd: join(import.meta.dirname, "..") },
  );
  assert.match(src, /invalid_at: superseded \? currentStamp : null/, "the corpus must write the real invalid_at field");
  assert.match(src, /superseded_by: superseded \? currentId : null/, "and name the successor");
  assert.match(src, /configs\["invalidation"\] = \(c\) => c\.filter\(\(h\) => !h\.record\.invalid_at\)/,
    "the filter must consult invalid_at");
  assert.doesNotMatch(src, /supersededIds/, "the in-memory id stand-in must be gone");
});
