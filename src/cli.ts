#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Commands. Read-only except apply, fold, supersede --apply, and invalidated --restore:
 *   stats  - corpus shape, so a reviewer sees what is being forgotten before choosing thresholds
 *   plan   - build a forgetting plan and print/save it (never touches the database)
 *   apply  - execute a saved plan, or a fresh one with --dry-run for a rehearsal
 *   audit  - show current states and recent runs
 *   fold   - fold the recall access log into access_count / last_access_time
 *   coverage - report access-tracking coverage, the decay gate, and how much decay would move
 *   supersede - mark a record as contradicted by a newer one (dry-run unless --apply)
 *   invalidated - list every record currently marked invalid, so a mistake stays findable
 *
 * Usage:
 *   node src/cli.ts stats --db ./data/snapshot.db
 *   node src/cli.ts plan  --db ./data/snapshot.db --quota 600 --out plan.json
 *   node src/cli.ts apply --db ./data/snapshot.db --plan plan.json --dry-run
 *   node src/cli.ts fold  --db ./data/snapshot.db --log ./data/recall-access.jsonl
 *   node src/cli.ts coverage --db ./data/snapshot.db
 *   node src/cli.ts coverage --db ./data/warm.db --fold-synthetic 200 --vectors l1_vec
 *   node src/cli.ts supersede --db ./data/snapshot.db --old m_1 --new m_2 --reason "project cancelled"
 *   node src/cli.ts invalidated --db ./data/snapshot.db --restore m_1
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { corpusStats, loadRecords } from "./adapters/tdai-sqlite.ts";
import { buildForgettingPlan, type ForgettingPlanReport } from "./planner.ts";
import { applyPlan, auditSummary } from "./applier.ts";
import { foldAccessLog, type FoldResult } from "./recall.ts";
import { DEFAULT_DECAY } from "./scoring.ts";
import { coverageClimb, coverageReport, type CoverageReport } from "./coverage.ts";
import {
  LLM_APPLY_MAX_FALSE_SUPERSEDE,
  PROMPT_VERSION,
  checkApplyGate,
  httpProvider,
  listSuggestions,
  runCriteria,
  type CriteriaMode,
  type JudgeProvider,
  type ReviewSet,
  type SupersedeVerdict,
} from "./llm-criteria.ts";
import { evaluate, renderEvaluation, samplePairs } from "./criteria-eval.ts";
import {
  applySupersede,
  listInvalidated,
  planSupersede,
  restoreRecord,
  type SupersedeRejection,
  type SupersedeResult,
} from "./invalidation.ts";

/**
 * The rename is the only thing that stops a second fold from double-counting, and
 * Windows refuses a rename whenever anything still holds the file. The counters are
 * already committed at that point, so this is a real failure, not a warning.
 */
const FOLD_NOT_ARCHIVED = "(rename failed — log NOT archived, next fold would double-count)";
const FOLD_RENAME_FAILURE_MESSAGE =
  "error: the log could not be archived after the counters were committed — " +
  "the access counts are already written, but the log is still in place and a second " +
  "fold WILL double-count it. Move it aside by hand before folding again.";
const FOLD_OUTPUT_WARNING = "warning: log NOT archived — counters committed; do not fold again";
const FOLD_SNAPSHOT_WARNING =
  "warning: --db looks like a snapshot copy — folding a copy only moves counters in the copy";

/**
 * Exit code 4 for a rejected supersede. Distinct from 1 (bad invocation) and 3 (the
 * fold could not archive), because the three mean different things to a script: this
 * one is "the database said no", and retrying without a change will fail the same way.
 */
const SUPERSEDE_REJECTED = 4;

/** One line per rejection reason, so the operator is told what to fix, not just that it failed. */
const SUPERSEDE_REJECTION_MESSAGES: Record<SupersedeRejection, string> = {
  "empty-reason":
    "error: --reason is required and must not be blank. It is the only record of why this " +
    "record was invalidated, so a placeholder would be worse than nothing.",
  "old-not-found": "error: --old does not name a record in this database; nothing was written.",
  "new-not-found": "error: --new does not name a record in this database; nothing was written.",
  "old-already-invalid":
    "error: that record is already invalidated (invalid_at is set). Nothing was written; clear " +
    "it first if you meant to change the reason. Use \`invalidated\` to see it.",
};

const USAGE = `tdai-forget <command> [options]

Commands:
  stats   Summarise the L1 corpus (records, types, states, months, pins)
  plan    Build a forgetting plan (no writes)
  apply   Apply a plan, or build + apply in one step
  audit   Show current states and recent runs
  fold    Fold the recall access log into access_count / last_access_time
  coverage Report the access-tracking coverage, the decay gate, and what decay would move
  supersede Mark a record as contradicted by a newer one (dry-run unless --apply)
  invalidated List records currently marked invalid; --restore clears one
  criteria Ask an LLM judge about candidate pairs (shadow unless --mode=apply)
  criteria-eval Build a sampled review set, or score a labelled one

Options:
  --db <path>            Path to vectors.db (required)
  --log <path>           Path to the recall access log (fold only)
  --fold-synthetic <n>   Replay n synthetic log lines, re-reading coverage after each
                         (coverage only; writes counters, so point it at a COPY)
  --vectors <table>      vec0 table to read for the probe's third channel (coverage only;
                         default l1_vec; pass an empty string to skip it)
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

Supersede:
  --old <record_id>      The record being contradicted (required)
  --new <record_id>      The record that replaces it (optional: a cancelled project has none)
  --reason <text>        Why it is being invalidated (required, must not be blank)
  --apply                Actually write. Without it nothing is written.

Invalidated:
  --restore <record_id>  Clear invalid_at / superseded_by, putting the record back on recall

Criteria:
  --judge-url <url>      OpenAI-compatible chat endpoint (required unless --sample-from)
  --judge-model <name>   Model to ask (required with --judge-url)
  --pairs <path>         Review set to judge (required)
  --mode <shadow|apply>  "shadow" records suggestions only; "apply" may also write the
                         invalidation. Default "shadow".
  --false-supersede-rate <0..1>
                         The measured rate the gate stands on. Taken from outside this
                         run, so a judge cannot certify itself. Missing = gate refuses.
  --report <path>        Where to write the run report

Criteria eval:
  --set <path>           Labelled review set (with --verdicts)
  --verdicts <path>      Human verdicts for that set, by pair id
  --sample-from <path>   Draw pairs out of an UNLABELLED review set instead of scoring one;
                         needs no --db and no endpoint, so a review set builds offline
  --sample-size <n>      How many pairs --sample-from should draw (default 50)
  --sample-out <path>    Where --sample-from writes the drawn pairs

The judge endpoint is deliberately not defaulted: which model reads your memories is a
deployment decision, and a silent default would make it someone else's.
`;

async function main(argv: string[]): Promise<number> {
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
      log: { type: "string" },
      "fold-synthetic": { type: "string" },
      vectors: { type: "string" },
      old: { type: "string" },
      new: { type: "string" },
      reason: { type: "string" },
      apply: { type: "boolean", default: false },
      restore: { type: "string" },
      pairs: { type: "string" },
      mode: { type: "string", default: "shadow" },
      set: { type: "string" },
      verdicts: { type: "string" },
      "sample-from": { type: "string" },
      "sample-size": { type: "string" },
      "sample-out": { type: "string" },
      "false-supersede-rate": { type: "string" },
      suggestions: { type: "boolean", default: false },
      limit: { type: "string" },
      report: { type: "string" },
      "judge-url": { type: "string" },
      "judge-model": { type: "string" },
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
  // Sampling a review set needs no database: it reads one review set and writes another.
  if (command === "criteria" && values["sample-from"]) {
    return runSampleCommand(values["sample-from"], values as unknown as Record<string, unknown>);
  }

  // `criteria-eval` reads two JSON files and never opens a database, so requiring --db
  // there was a constraint with nothing behind it. Every other command does open one.
  // The empty-string default keeps the type a plain string for the commands that do use
  // it; reaching them with no --db is still an error, two lines down.
  const dbPath = values.db ?? "";
  if (!dbPath && command !== "criteria-eval") {
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
    // `--suggestions` answers "what has the judge been saying?", which otherwise had no
    // access path at all: the rows were in the table but nothing read them back.
    if (values.suggestions) {
      const rows = listSuggestions(dbPath, num(values.limit, 200));
      if (values.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } else if (rows.length === 0) {
        process.stdout.write("no llm-suggest rows\n");
      } else {
        const lines = [`llm-suggest rows: ${rows.length}`, ""];
        for (const r of rows) lines.push(`${r.record_id}  ${r.decided_at}`, `    ${r.reason}`);
        process.stdout.write(lines.join("\n") + "\n");
      }
      return 0;
    }
    const summary = auditSummary(dbPath);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  if (command === "coverage") {
    // The default is "no vectors", not "l1_vec": reading vec0's shadow tables is a
    // layout assumption (see src/coverage.ts), and a watch command that throws on an
    // unfamiliar layout is useless exactly when it is needed. Pass --vectors l1_vec
    // to include the third channel.
    const vectorTable = values.vectors === "" ? undefined : (values.vectors ?? undefined);
    const report = values["fold-synthetic"]
      ? runSyntheticClimb(dbPath, num(values["fold-synthetic"], 0), config.decay, vectorTable)
      : coverageReport(dbPath, config.decay, new Date(), vectorTable);
    if (values.json) {
      process.stdout.write(JSON.stringify(report, null, 0) + "\n");
    } else {
      process.stdout.write(renderCoverage(report));
    }
    return 0;
  }

  if (command === "fold") {
    const logPath = values.log;
    if (!logPath) {
      process.stderr.write("error: --log is required for fold\n");
      return 1;
    }
    const result = foldAccessLog(dbPath, logPath);
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(renderFold(result, dbPath));
    }
    // Success is "the log was archived", not "no exception was thrown": the counters
    // commit before the rename, so a failed rename leaves the log on disk and the next
    // fold would count every line twice. An empty or missing log archives nothing and
    // is a legitimate no-op — reporting that as failure would break the documented
    // "folding a missing log is a no-op" contract.
    if (isRenameFailure(result)) {
      process.stderr.write(FOLD_RENAME_FAILURE_MESSAGE + "\n");
      return 3;
    }
    return 0;
  }

  if (command === "supersede") {
    if (!values.old) {
      process.stderr.write("error: --old is required for supersede\n");
      return 1;
    }
    const opts = {
      oldId: values.old,
      newId: values.new,
      reason: values.reason ?? "",
      apply: values.apply,
    };
    // Planning first even when --apply is set: the same function produces the dry-run
    // report and the write, so the preview cannot describe something the write would
    // not do. A rejection is reported before anything is opened for writing.
    const preview = planSupersede(dbPath, opts);
    if (preview.rejection) {
      process.stderr.write(SUPERSEDE_REJECTION_MESSAGES[preview.rejection] + "\n");
      return SUPERSEDE_REJECTED;
    }

    const result: SupersedeResult = values.apply ? applySupersede(dbPath, opts) : preview;
    if (result.rejection) {
      process.stderr.write(SUPERSEDE_REJECTION_MESSAGES[result.rejection] + "\n");
      return SUPERSEDE_REJECTED;
    }
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(renderSupersede(result, values.apply));
    }
    return 0;
  }

  if (command === "invalidated") {
    if (values.restore) {
      const restored = restoreRecord(dbPath, values.restore);
      process.stdout.write(
        restored
          ? `restored ${values.restore}: invalid_at cleared, the record is recallable again\n`
          : `no change: ${values.restore} is not invalidated (or does not exist)\n`,
      );
      return restored ? 0 : 1;
    }
    const rows = listInvalidated(dbPath);
    if (values.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      process.stdout.write(renderInvalidated(rows));
    }
    return 0;
  }

  if (command === "criteria") {
    const mode = (values.mode ?? "shadow") as CriteriaMode;
    if (mode !== "shadow" && mode !== "apply") {
      process.stderr.write(`error: --mode must be shadow or apply, got "${values.mode}"\n`);
      return 1;
    }
    // The judge is pluggable because tests must not touch a network, and because a
    // deployment should not be welded to one vendor.
    let provider: JudgeProvider | null = null;
    if (values["judge-url"]) {
      provider = httpProvider({
        url: values["judge-url"],
        model: values["judge-model"] ?? "unknown",
        apiKey: process.env.JUDGE_API_KEY,
      });
    }
    if (!provider) {
      process.stderr.write(
        "error: no judge provider. Pass --judge-url <chat-completions endpoint> and --judge-model <id>.\n" +
          "       The judge is deliberately not wired to a default endpoint: which model reads your\n" +
          "       memories is a deployment decision, and a silent default would make it someone else's.\n",
      );
      return 1;
    }

    let pairs: ReviewSet;
    try {
      pairs = JSON.parse(readFileSync(values.pairs ?? "", "utf8")) as ReviewSet;
    } catch (err) {
      process.stderr.write(`error: --pairs must be readable JSON: ${(err as Error).message}\n`);
      return 1;
    }

    // The gate needs a number from OUTSIDE this run. Taking it as an argument means a
    // judge cannot certify itself by being confident.
    //
    // "Not supplied" and "supplied as empty" are the same thing here, and both are null,
    // not 0. `Number("")` is 0, so the naive version of this line turned
    // `--false-supersede-rate=` (an unset shell variable, a typo) into "measured 0%,
    // gate open" and let every supersede through. Refusing to measure is not a pass.
    const rate = parseOptionalRate(values["false-supersede-rate"]);
    const gate = checkApplyGate(rate, values.report);
    if (mode === "apply" && !gate.allowed) {
      process.stderr.write(gate.message + "\n");
      return 5;
    }
    return await runCriteriaCommand(dbPath, pairs, mode, provider, rate, values.report, values.json);
  }

  if (command === "criteria-eval") {
    let set: ReviewSet;
    let verdicts: Record<string, SupersedeVerdict | null>;
    try {
      set = JSON.parse(readFileSync(values.set ?? "", "utf8")) as ReviewSet;
      verdicts = JSON.parse(readFileSync(values.verdicts ?? "", "utf8")) as Record<string, SupersedeVerdict | null>;
    } catch (err) {
      process.stderr.write(`error: --set and --verdicts must be readable JSON: ${(err as Error).message}\n`);
      return 1;
    }
    const judged = new Map(Object.entries(verdicts));
    const matrix = evaluate(set.pairs, judged);
    // This number is what opens the apply gate, so it has to outlive the terminal it was
    // printed in. Written before the summary so a report on disk always accompanies the
    // rate an operator is about to paste into --false-supersede-rate.
    if (values.report) {
      writeFileSync(
        values.report,
        JSON.stringify(
          {
            report: "criteria-eval/1",
            reviewSet: set.version,
            sampling: set.sampling,
            labelledBy: set.labelledBy ?? null,
            labelledAt: set.labelledAt ?? null,
            pairs: set.pairs.length,
            matrix,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    if (values.json) {
      process.stdout.write(JSON.stringify(matrix, null, 2) + "\n");
    } else {
      process.stdout.write(renderEvaluation(matrix, set, judged, "see the verdicts file"));
      if (values.report) process.stdout.write("\nwrote the evaluation to " + values.report + "\n");
    }
    return 0;
  }

  process.stderr.write(`error: unknown command "${command}"\n`);
  return 1;
}

/** A fold that read lines but has no archive path lost the rename; a no-op fold has neither. */
function isRenameFailure(result: FoldResult): boolean {
  return result.archivePath === undefined && result.linesRead > 0;
}

function renderFold(result: FoldResult, dbPath: string): string {
  // "archived to" has three states, and only one of them is a problem. Collapsing
  // "nothing was folded" into "the rename failed" would put the alarming text in
  // front of an operator whose log simply had nothing left to fold.
  const archived = result.archivePath
    ? result.archivePath
    : result.linesRead > 0
      ? FOLD_NOT_ARCHIVED
      : "(nothing to fold)";
  const lines = [
    `log lines     ${result.linesRead}`,
    `records       ${result.recordsTouched}`,
    `rows updated  ${result.rowsUpdated}`,
    `archived to   ${archived}`,
  ];
  // Folding a read-only snapshot is meaningless: the counters land in a throwaway copy
  // and the archived log is no longer on the operator's live path. Do not block it —
  // a rehearsal on a copy is a legitimate thing to run — but say so.
  if (isSelfOrWritableSnapshot(dbPath)) lines.push(FOLD_SNAPSHOT_WARNING);
  if (isRenameFailure(result)) lines.push(FOLD_OUTPUT_WARNING);
  return lines.join("\n") + "\n";
}

/** Warn when --db looks like a copy: the original snapshot name, or a path inside data/. */
function isSelfOrWritableSnapshot(dbPath: string): boolean {
  return /(^|[\\/])snapshot-[^\\/]*\.db$/i.test(dbPath) || /(^|[\\/])data[\\/]/i.test(dbPath);
}

/**
 * Render the coverage report.
 *
 * Fixed key order, and every key present on every run: the operator is comparing two
 * of these side by side a week apart, and a line that appears only sometimes cannot
 * be compared.
 */
function renderCoverage(report: CoverageReport): string {
  const lines = [
    `records            ${report.records}`,
    `with access        ${report.withAccess}`,
    `coverage           ${report.coverage.toFixed(4)}`,
    `decay active       ${report.decayActive}   (threshold ${report.threshold.toFixed(2)})`,
    `if decay on, reordered  top-${report.window}   ${report.reordered}`,
  ];
  // Without this qualifier "0" reads as "decay would change nothing", which is a
  // different claim from "the probe ranked nothing to change".
  if (report.emptyRanking) lines.push("note               the probe ranked no candidates; reordered is trivially 0");
  lines.push(
    `probe              query "${report.query}"  channels lexical/${report.channels.lexical} fts/${report.channels.fts} vector/${report.channels.vector}  candidates ${report.candidates}`,
  );
  if (report.climb) {
    // The one non-read-only mode. Saying so is not a courtesy: --fold-synthetic on a
    // live database writes access counters into production, and the whole point of the
    // watch command is that an operator can run it without thinking about that.
    if (isSelfOrWritableSnapshot(report.dbPath)) lines.push(FOLD_SNAPSHOT_WARNING);
    lines.push("");
    lines.push("coverage climb (SYNTHETIC log: the lines are generated, the folds are real)");
    lines.push(`  ${"folds".padStart(5)}  ${"coverage".padStart(8)}  ${"withAccess".padStart(10)}  ${"decayActive".padStart(11)}  ${"reordered".padStart(9)}`);
    for (const s of report.climb) {
      lines.push(
        `  ${String(s.folds).padStart(5)}  ${s.coverage.toFixed(4).padStart(8)}  ${String(s.withAccess).padStart(10)}  ${String(s.decayActive).padStart(11)}  ${String(s.reordered).padStart(9)}`,
      );
    }
  }
  if (report.climbSkipped) lines.push(`climb skipped      ${report.climbSkipped}`);
  return lines.join("\n") + "\n";
}

/**
 * Replay a synthetic access log and re-read coverage after every fold.
 *
 * The log lines are generated; the folding is not. Each step appends one line to a
 * real file and hands it to `foldAccessLog`, so the counters move through the same
 * code a cron job would run. Writing counters means this is the one coverage mode
 * that is not read-only — hence the snapshot warning in the output, and hence the
 * instruction to point it at a copy.
 *
 * The target selection is deterministic on purpose — a whole-corpus stride with
 * `PER_LINE` hits per line, where PER_LINE matches the mean hit count the container
 * measured in B1 §5.1 (91 hits over 15 searches = 6.07; the replay uses 4 so the
 * sequence is reproducible without a random source). A replay that randomly picked
 * records would produce a different table on every run, and a table nobody can
 * reproduce is not evidence.
 *
 * Each step writes ONE line to a fresh file, folds it, and deletes the archive: the
 * point is to move the counters through the real `foldAccessLog`, not to leave a
 * thousand `.folded-` files behind on the operator's disk.
 */
function runSyntheticClimb(
  dbPath: string,
  folds: number,
  cfg: typeof DEFAULT_DECAY,
  vectorTable: string | undefined,
): CoverageReport {
  if (!Number.isFinite(folds) || folds <= 0) throw new Error("--fold-synthetic must be a positive number");
  if (!hasForgettingColumnsForCli(dbPath)) {
    throw new Error(`${dbPath} has no forgetting columns: run src/migrate.ts (or the apply path) first`);
  }

  const ids = probeIds(dbPath);
  if (ids.length === 0) throw new Error("the probe found no l1_records to touch");

  const logPath = join(dirname(dbPath), `coverage-synthetic-${process.pid}.jsonl`);

  let cursor = 0;
  const step = (): boolean => {
    const hits: string[] = [];
    for (let i = 0; i < SYNTHETIC_HITS_PER_FOLD && cursor < ids.length; i++, cursor++) hits.push(ids[cursor]);
    if (hits.length === 0) return false;
    // Timestamps walk backwards from now as extra lines are appended, the way a log
    // written by a running deployment would: the earliest line is the oldest access.
    const at = new Date(Date.now() - (folds - cursor) * 60_000).toISOString();
    writeFileSync(logPath, JSON.stringify({ at, hits }) + "\n", "utf8");
    const folded = foldAccessLog(dbPath, logPath);
    // The archive is the fold's only durable output here, and a thousand of them would
    // be litter. Removing it is safe: the counters are already committed.
    if (folded.archivePath) rmSync(folded.archivePath, { recursive: true, force: true });
    return true;
  };

  const climb = coverageClimb(dbPath, step, cfg, new Date(), folds);
  const final = coverageReport(dbPath, cfg, new Date(), vectorTable);
  return { ...final, climb };
}

/**
 * Hits per synthetic line. The container logged 91 recall hits over 15 searches
 * (B1 §5.1), i.e. 6.07 per search; the replay uses 4 because the point is the shape of
 * the climb, and a smaller number makes the crossing land in more places on the table.
 */
const SYNTHETIC_HITS_PER_FOLD = 4;

/** Record ids in a stable order; the adapter sorts by created_time but that alone is not total. */
function probeIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT record_id FROM l1_records ORDER BY record_id ASC").all() as unknown as Array<{
      record_id: string;
    }>;
    return rows.map((r) => r.record_id);
  } finally {
    db.close();
  }
}

/** Kept as a CLI-local probe so the sqlite import stays in one place. */
function hasForgettingColumnsForCli(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(l1_records)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    return cols.has("state") && cols.has("access_count") && cols.has("last_access_time");
  } finally {
    db.close();
  }
}

/**
 * Render a supersede result. The dry run and the write share this, and the header line
 * is the only difference — which is the point: an operator comparing a rehearsal with
 * the real thing should not have to diff two formats in their head.
 */
function renderSupersede(result: SupersedeResult, applied: boolean): string {
  const plan = result.plan!;
  const lines = [
    applied ? "INVALIDATED (written)" : "DRY RUN — nothing written",
    `  record        ${plan.record!.record_id}`,
    `  type          ${plan.record!.type}`,
    `  state         ${plan.record!.state}   (unchanged: invalidation is not eviction)`,
    `  invalid_at    ${plan.record!.invalid_at ?? "(none)"}  ->  ${plan.audit!.decided_at}`,
    `  superseded_by ${plan.record!.superseded_by ?? "(none)"}  ->  ${plan.newId ?? "(none: no successor)"}`,
    `  excerpt       ${plan.record!.excerpt}`,
    `  reason        ${plan.reason}`,
    "",
    `  audit row     action=${plan.audit!.action} from_state=${plan.audit!.from_state} to_state=${plan.audit!.to_state}`,
  ];
  if (!applied) lines.push("", "  Re-run with --apply to write this.");
  return lines.join("\n") + "\n";
}

/** Fixed column order so two listings a week apart can be compared line by line. */
function renderInvalidated(rows: ReturnType<typeof listInvalidated>): string {
  if (rows.length === 0) {
    return "no invalidated records\n";
  }
  const lines = [`invalidated records: ${rows.length}`, ""];
  for (const r of rows) {
    lines.push(`${r.record_id}  ${r.invalid_at}`);
    lines.push(`    type=${r.type}  state=${r.state}  superseded_by=${r.superseded_by ?? "(none)"}`);
    lines.push(`    ${r.excerpt}`);
  }
  lines.push("", "clear one with: node src/cli.ts invalidated --db <path> --restore <record_id>");
  return lines.join("\n") + "\n";
}

/**
 * Run the judge and print what it decided.
 *
 * Shadow prints suggestions and says plainly that nothing was written. Apply prints what
 * it changed. The two share one renderer so the difference between a rehearsal and a
 * real run is a header line rather than two formats to compare by eye.
 */
async function runCriteriaCommand(
  dbPath: string,
  set: ReviewSet,
  mode: CriteriaMode,
  provider: JudgeProvider,
  rate: number | null,
  reportPath: string | undefined,
  json: boolean | undefined,
): Promise<number> {
  const result = await runCriteria({
    dbPath,
    pairs: set.pairs,
    mode,
    judge: { provider },
    measuredFalseSupersedeRate: rate,
    reportPath,
  });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  const lines: string[] = [];
  lines.push(mode === "apply" ? "CRITERIA (apply) — supersede verdicts were written" : "CRITERIA (shadow) — nothing was written to invalid_at");
  lines.push(`  review set   ${set.version}  (${set.pairs.length} pairs)`);
  lines.push(`  model        ${provider.modelId}`);
  lines.push(`  prompt       ${PROMPT_VERSION}`);
  lines.push(`  gate         ${rate === null ? "no measurement" : (rate * 100).toFixed(1) + "% false-supersede"}  threshold ${(LLM_APPLY_MAX_FALSE_SUPERSEDE * 100).toFixed(0)}%`);
  lines.push("");
  for (const o of result.outcomes) {
    const verdict = o.verdict ?? `NOT JUDGED (${o.error})`;
    lines.push(`  ${o.pairId}`);
    const mark = o.applied ? "  [invalid_at WRITTEN]" : o.alreadyInvalid ? "  [already invalid, nothing written]" : "";
    lines.push(`    -> ${verdict}${o.verdict ? `  confidence ${o.confidence.toFixed(2)}` : ""}${mark}`);
  }
  lines.push("");
  lines.push(`audit rows written: ${result.auditRows}  (action='llm-suggest'${mode === "apply" ? " plus action='invalidate' for applied verdicts" : ""})`);
  if (mode === "shadow") {
    lines.push("shadow mode never writes invalid_at / superseded_by, and never touches state.");
    lines.push("to act on these suggestions, first produce a false-supersede report and pass it with --false-supersede-rate.");
  } else {
    lines.push(`records invalidated by this run: ${result.invalidated.length}`);
    // On a re-run over an already-invalidated set the count above is 0 while the judge
    // still said "supersede". Saying so avoids the reading "the judge changed its mind".
    const repeats = result.outcomes.filter((o) => o.alreadyInvalid).length;
    if (repeats > 0) lines.push(`already invalid before this run: ${repeats}  (nothing written for those)`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

/**
 * Draw a candidate review set from a database copy.
 *
 * Deterministic on purpose: same database + same seed = same pairs, so the review set in
 * the report can be regenerated and checked instead of trusted.
 */
function runSampleCommand(dbPath: string, values: Record<string, unknown>): number {
  const rawSize = values["sample-size"];
  const parsed = typeof rawSize === "string" ? Number(rawSize) : NaN;
  const size = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
  const pairs = samplePairs(dbPath, { size, seed: 20261026 });
  const set: ReviewSet = {
    version: `review-set/${new Date().toISOString().slice(0, 10)}`,
    sampling:
      "adjacent-in-time pairs within one scene, content jaccard(3-gram) in [0.10, 0.90], " +
      "sorted by seeded FNV-1a of pairId with seed 20261026, first N",
    source: dbPath,
    createdAt: new Date().toISOString(),
    pairs,
  };
  const out = values["sample-out"];
  if (typeof out === "string" && out.length > 0) {
    writeFileSync(out, JSON.stringify(set, null, 2), "utf8");
    process.stdout.write(`wrote ${pairs.length} pairs to ${out}\n`);
    process.stdout.write(`sampling rule: ${set.sampling}\n`);
    return 0;
  }
  process.stdout.write(JSON.stringify(set, null, 2) + "\n");
  return 0;
}

/**
 * Parse `--false-supersede-rate`. Absent, blank, and unparseable all mean "no measurement".
 *
 * Returning null for a blank string is the whole point: `Number("")` is 0, which would
 * read as a perfect score and open the apply gate on no evidence at all.
 */
function parseOptionalRate(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderPlan(plan: ForgettingPlanReport): string {
  const lines: string[] = [];
  lines.push(`plan        ${plan.generatedAt}`);
  lines.push(`records     ${plan.total}`);
  lines.push(`pinned      ${plan.pinned}`);
  lines.push(`kept        ${plan.kept}`);
  lines.push(`archived    ${plan.archived}`);
  // A subset of "archived", printed under it so the reader sees the split without
  // grepping the decisions. The conflict block below appears only when there IS a
  // conflict: a permanent "0" would train the reader to skip the line that matters.
  lines.push(`  invalidated ${plan.invalidated}`);
  lines.push(`retired     ${plan.retired}`);
  lines.push(`clusters    ${plan.clusters.length} (redundant groups)`);
  lines.push(`review      ${plan.reviewCandidates.length} permanence-worded non-instructions`);
  if (plan.pinInvalidConflicts.length > 0) {
    lines.push("");
    lines.push(`pin/invalid conflicts: ${plan.pinInvalidConflicts.length} (pin wins, nothing evicted)`);
    for (const c of plan.pinInvalidConflicts) {
      lines.push(`  ${c.record_id}  invalid since ${c.invalid_at}  but pinned: ${c.pin_reason}`);
    }
    lines.push("  a person has to decide which instruction they meant.");
  }
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
