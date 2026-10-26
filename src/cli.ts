#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Three commands, all read-only by default:
 *   stats  - corpus shape, so a reviewer sees what is being forgotten before choosing thresholds
 *   plan   - build a forgetting plan and print/save it (never touches the database)
 *   apply  - execute a saved plan, or a fresh one with --dry-run for a rehearsal
 *
 * Usage:
 *   node src/cli.ts stats --db ./data/snapshot.db
 *   node src/cli.ts plan  --db ./data/snapshot.db --quota 600 --out plan.json
 *   node src/cli.ts apply --db ./data/snapshot.db --plan plan.json --dry-run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { corpusStats, loadRecords } from "./adapters/tdai-sqlite.ts";
import { buildForgettingPlan, type ForgettingPlanReport } from "./planner.ts";
import { applyPlan, auditSummary } from "./applier.ts";
import { DEFAULT_DECAY } from "./scoring.ts";

const USAGE = `tdai-forget <command> [options]

Commands:
  stats   Summarise the L1 corpus (records, types, states, months, pins)
  plan    Build a forgetting plan (no writes)
  apply   Apply a plan, or build + apply in one step
  audit   Show current states and recent runs

Options:
  --db <path>            Path to vectors.db (required)
  --quota <n>            Target active-record count; 0 disables (default 0)
  --min-retain <n>       Hard floor on live records (default 100)
  --half-life <days>     Decay half-life (default ${DEFAULT_DECAY.halfLifeDays})
  --floor <0..1>         Decay floor (default ${DEFAULT_DECAY.floor})
  --archive <0..1>       Archive threshold (default 0.45)
  --retire <0..1>        Retire threshold (default 0.25)
  --min-age <days>       Age gate before retire (default 14)
  --min-coverage <0..1>  Access-tracking coverage required before decay reorders results
                         (default ${DEFAULT_DECAY.minTrackingCoverage}; 0 = always on)
  --team <id>            Filter to one team_id
  --agent <id>           Filter to one agent_id
  --user <id>            Filter to one user_id
  --out <path>           Write JSON output to a file
  --plan <path>          Read a previously saved plan (apply only)
  --dry-run              Compute but do not write (apply only)
  --notes <text>         Note stored on the run row (apply only)
  --json                 Emit machine-readable JSON instead of a summary
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      quota: { type: "string" },
      "min-retain": { type: "string" },
      "half-life": { type: "string" },
      floor: { type: "string" },
      archive: { type: "string" },
      retire: { type: "string" },
      "min-age": { type: "string" },
      "min-coverage": { type: "string" },
      team: { type: "string" },
      agent: { type: "string" },
      user: { type: "string" },
      out: { type: "string" },
      plan: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      notes: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const dbPath = values.db;
  if (!dbPath) {
    process.stderr.write("error: --db is required\n");
    return 1;
  }

  if (command === "stats") {
    const records = loadRecords(dbPath, { team_id: values.team, agent_id: values.agent, user_id: values.user });
    const stats = corpusStats(records);
    if (values.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    } else {
      process.stdout.write(
        [
          `records        ${stats.total}`,
          `oldest / newest ${stats.oldest} / ${stats.newest}`,
          `by type        ${JSON.stringify(stats.byType)}`,
          `by state       ${JSON.stringify(stats.byState)}`,
          `by month       ${JSON.stringify(stats.byMonth)}`,
          `priority = -1  ${stats.pinnedByPriority}`,
          "",
        ].join("\n"),
      );
    }
    return 0;
  }

  const num = (raw: string | undefined, fallback: number): number =>
    raw === undefined ? fallback : Number(raw);

  const config = {
    decay: {
      halfLifeDays: num(values["half-life"], DEFAULT_DECAY.halfLifeDays),
      floor: num(values.floor, DEFAULT_DECAY.floor),
      usageWeight: DEFAULT_DECAY.usageWeight,
      importanceWeight: DEFAULT_DECAY.importanceWeight,
      decayWeight: DEFAULT_DECAY.decayWeight,
      usageSaturation: DEFAULT_DECAY.usageSaturation,
      minTrackingCoverage: num(values["min-coverage"], DEFAULT_DECAY.minTrackingCoverage),
    },
    eviction: {
      quota: num(values.quota, 0),
      minRetain: num(values["min-retain"], 100),
      archiveThreshold: num(values.archive, 0.45),
      retireThreshold: num(values.retire, 0.25),
      minAgeDays: num(values["min-age"], 14),
    },
  };

  if (command === "plan") {
    const records = loadRecords(dbPath, { team_id: values.team, agent_id: values.agent, user_id: values.user });
    const plan = buildForgettingPlan(records, config);
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(plan, null, 2), "utf8");
      process.stdout.write(`plan written to ${values.out}\n`);
    }
    if (values.json) {
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    } else {
      process.stdout.write(renderPlan(plan));
    }
    return 0;
  }

  if (command === "apply") {
    let plan: ForgettingPlanReport;
    if (values.plan) {
      plan = JSON.parse(readFileSync(values.plan, "utf8")) as ForgettingPlanReport;
    } else {
      const records = loadRecords(dbPath, { team_id: values.team, agent_id: values.agent, user_id: values.user });
      plan = buildForgettingPlan(records, config);
    }
    const result = applyPlan(dbPath, plan, {
      dryRun: values["dry-run"],
      notes: values.notes,
      actor: "cli",
    });
    process.stdout.write(
      [
        `run        ${result.runId}`,
        `dry-run    ${result.dryRun}`,
        `archived   ${result.archived}`,
        `retired    ${result.retired}`,
        `pinned     ${result.skippedPinned} skipped`,
        `audit rows ${result.auditRows}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (command === "audit") {
    const summary = auditSummary(dbPath);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  process.stderr.write(`error: unknown command "${command}"\n`);
  return 1;
}

function renderPlan(plan: ForgettingPlanReport): string {
  const lines: string[] = [];
  lines.push(`plan        ${plan.generatedAt}`);
  lines.push(`records     ${plan.total}`);
  lines.push(`pinned      ${plan.pinned}`);
  lines.push(`kept        ${plan.kept}`);
  lines.push(`archived    ${plan.archived}`);
  lines.push(`retired     ${plan.retired}`);
  lines.push(`clusters    ${plan.clusters.length} (redundant groups)`);
  lines.push(`review      ${plan.reviewCandidates.length} permanence-worded non-instructions`);
  lines.push("");
  const byReason = new Map<string, number>();
  for (const d of plan.decisions) {
    if (d.decision === "keep") continue;
    const key = d.reason.replace(/\d+(\.\d+)?/g, "#");
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  lines.push("eviction reasons:");
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(5)}  ${reason}`);
  }
  return lines.join("\n") + "\n";
}

process.exitCode = main(process.argv.slice(2));
