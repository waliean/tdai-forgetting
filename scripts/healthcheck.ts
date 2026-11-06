/**
 * Read-only health check.
 *
 * The worst failure mode of a forgetting policy is silence. Coverage falls back to zero
 * because the tracking wiring broke, the eviction rate jumps because a threshold was
 * mistyped, a pin stops being honoured because the pin rules changed — none of these
 * raise an error. They show up months later as "the memory has gotten worse".
 *
 * This script looks for those three shapes plus one bookkeeping check, prints one line
 * per metric, and exits non-zero if anything is out of bounds. It never writes: a check
 * that "fixes" things is a second incident waiting for an unattended night.
 *
 * Deliberately not a scheduler. Install it in cron or CI yourself; the guide at
 * docs/guides/体检判据-2026-11-06.md has the commands and the reasoning.
 *
 *   node scripts/healthcheck.ts --db data/work.db
 */

import { DatabaseSync } from "node:sqlite";

import { loadRecords } from "../src/adapters/tdai-sqlite.ts";
import { applyPins } from "../src/pin.ts";
import { trackingCoverage } from "../src/scoring.ts";

type Status = "OK" | "WARN" | "FAIL" | "SKIP";

interface Check {
  name: string;
  status: Status;
  value: string;
  detail: string;
}

interface RunRow {
  run_id: string;
  started_at: string;
  total: number;
  archived: number;
  retired: number;
  pinned: number;
  status: string;
}

function parseArgs(argv: string[]): { dbPath: string | null } {
  let dbPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") dbPath = argv[i + 1] ?? null;
    else if (argv[i].startsWith("--db=")) dbPath = argv[i].slice(5);
  }
  return { dbPath };
}

function main(): void {
  const { dbPath } = parseArgs(process.argv.slice(2));
  if (!dbPath) {
    process.stderr.write("usage: node scripts/healthcheck.ts --db <path>\n");
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const migrated = !!db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'forgetting_runs'")
      .get();

    // "Persistent" is judged from the run history, not from one snapshot: a fresh
    // deployment legitimately has zero coverage for a while, and warning on that is how
    // a metric gets muted on day one and never looked at again.
    const runs = migrated
      ? (db
          .prepare(
            "SELECT run_id, started_at, total, archived, retired, pinned, status FROM forgetting_runs ORDER BY started_at DESC LIMIT 10",
          )
          .all() as unknown as RunRow[])
      : [];
    const latest = runs[0];

    const records = loadRecords(dbPath);
    const checks: Check[] = [];

    // 1. Coverage: the share of records carrying any access evidence. Below the gate the
    //    decay term is inert, which is a legitimate cold start — but only for a while.
    const coverage = trackingCoverage(records);
    checks.push({
      name: "coverage",
      status: runs.length < 3 ? "SKIP" : coverage < 0.1 ? "WARN" : "OK",
      value: `${(coverage * 100).toFixed(1)}%`,
      detail:
        runs.length < 3
          ? `only ${runs.length} run(s) recorded; need 3 before judging a trend`
          : `threshold 10%; below it the decay gate stays shut`,
    });

    // 2. Eviction rate of the most recent run. One spike is a WARN; a third of the live
    //    corpus in one pass is a misconfigured threshold, not a busy week.
    const evictionRate =
      latest && latest.total > 0 ? (latest.archived + latest.retired) / latest.total : 0;
    checks.push({
      name: "evictionRate",
      status: !latest ? "SKIP" : evictionRate > 0.3 ? "FAIL" : evictionRate > 0.1 ? "WARN" : "OK",
      value: latest ? `${(evictionRate * 100).toFixed(1)}%` : "n/a",
      detail: latest
        ? `latest run ${latest.run_id}: ${latest.archived} archived + ${latest.retired} retired of ${latest.total}; warn >10%, fail >30%`
        : "no runs recorded",
    });

    // 3. Pin integrity: a hard pin outside `active` is a hard invariant violation. There
    //    is no threshold here — the count must be zero.
    const hardPins = applyPins(records).filter((r) => r.pinned && r.pin_kind === "hard");
    const brokenPins = hardPins.filter((r) => (r.state ?? "active") !== "active");
    checks.push({
      name: "pinIntact",
      status: brokenPins.length > 0 ? "FAIL" : "OK",
      value: String(brokenPins.length),
      detail:
        brokenPins.length > 0
          ? `hard pins outside active: ${brokenPins
              .slice(0, 5)
              .map((r) => `${r.record_id}(${r.state})`)
              .join(", ")}${brokenPins.length > 5 ? " ..." : ""}`
          : `${hardPins.length} hard pin(s), all active`,
    });

    // 4. Audit completeness: the run row claims a count, the audit table must back it up.
    //    A gap means the audit trail is no longer a complete record, and the audit is this
    //    project's only correction mechanism.
    let auditRows = 0;
    if (latest) {
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM forgetting_audit WHERE run_id = ?")
          .get(latest.run_id) as unknown as { c: number } | undefined;
        auditRows = row?.c ?? 0;
      } catch {
        auditRows = -1;
      }
    }
    const expected = latest ? latest.archived + latest.retired : 0;
    checks.push({
      name: "auditGaps",
      status: !latest ? "SKIP" : auditRows !== expected ? "FAIL" : "OK",
      value: latest ? `${auditRows} / ${expected}` : "n/a",
      detail: latest
        ? auditRows === -1
          ? "forgetting_audit table missing"
          : `audit rows for ${latest.run_id} vs archived+retired in forgetting_runs`
        : "no runs recorded",
    });

    // ── Render ──
    const lines = [`healthcheck  ${dbPath}`, `records      ${records.length}`, ""];
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const check of checks) {
      lines.push(`  ${check.name.padEnd(width)}  ${check.value.padStart(8)}  ${check.status.padEnd(4)}  ${check.detail}`);
    }

    const fails = checks.filter((c) => c.status === "FAIL");
    const warns = checks.filter((c) => c.status === "WARN");
    lines.push("");
    if (fails.length > 0) {
      lines.push(`${fails.length} FAIL, ${warns.length} WARN: ${fails.map((c) => c.name).join(", ")}`);
    } else if (warns.length > 0) {
      lines.push(`0 FAIL, ${warns.length} WARN: ${warns.map((c) => c.name).join(", ")}`);
    } else {
      lines.push("all checks OK");
    }
    process.stdout.write(lines.join("\n") + "\n");

    // 0 = healthy (warnings included: a warning is a signal to look, not a failure of the
    // check itself), 1 = at least one FAIL. A scheduler only needs the exit code.
    process.exit(fails.length > 0 ? 1 : 0);
  } finally {
    db.close();
  }
}

main();
