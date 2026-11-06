/**
 * LLM supersede criteria: shadow by default, gated before it can act.
 *
 * The asymmetry this module is built around: marking a still-true record invalid removes
 * a correct memory silently — nobody is told, nothing errors. Missing one leaves an extra
 * record a reader can see and discount. So every uncertain path here resolves to
 * "do not act", and the only way the module is allowed to write `invalid_at` is after a
 * measured false-supersede rate clears the gate.
 *
 * Two mechanisms, not one:
 *
 *   1. A JUDGE that classifies a pair. Provider-agnostic, failure-tolerant, and it never
 *      returns `supersede` when the call failed.
 *   2. A MODE that decides what the classification is allowed to touch. `shadow` writes
 *      an audit row and nothing else. The isolation is physical: in shadow the UPDATE
 *      statements are not issued at all, rather than issued and rolled back. A rollback
 *      would still have taken the write lock and still be one bug away from committing.
 *
 * `judgePair` does not read or write the database. `runCriteria` owns persistence, so the
 * judging logic stays testable without a store and the store stays testable without a
 * model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrate.ts";

/** The three-way classification. Deliberately not a boolean: see the prompt. */
export type SupersedeVerdict = "supersede" | "keep-both" | "unrelated";

/** Audit action for a machine suggestion. Never the same string as a human's. */
export const LLM_SUGGEST_ACTION = "llm-suggest";

/** Prompt version, recorded on every audit row so a verdict can be reproduced. */
export const PROMPT_VERSION = "supersede-judge/v1";

/**
 * The gate. One constant in one place, per the block's requirement, and named so a
 * reader sees what it measures rather than a bare 0.05.
 */
export const LLM_APPLY_MAX_FALSE_SUPERSEDE = 0.05;

export interface JudgeInput {
  oldRecord: { record_id: string; content: string; type: string; created_time: string; scene_name?: string };
  newRecord: { record_id: string; content: string; type: string; created_time: string; scene_name?: string };
  /** Optional surrounding facts, so the judge sees context the pair alone does not carry. */
  context?: string;
}

export interface JudgeResult {
  /** null means "could not judge". Callers must treat it as no-opinion, never as a verdict. */
  verdict: SupersedeVerdict | null;
  confidence: number;
  modelId: string;
  promptVersion: string;
  /** Raw model output, kept for the audit trail and for debugging a parse failure. */
  raw: string;
  /** Set when verdict is null. Absence of this with a null verdict is a bug. */
  error?: string;
}

/** A provider turns a rendered prompt into text. Injected, so tests never touch a network. */
export interface JudgeProvider {
  readonly modelId: string;
  complete(prompt: string): Promise<string>;
}

export interface JudgeOptions {
  provider: JudgeProvider;
  /** Override for tests; defaults to the file next to this module. */
  promptTemplate?: string;
  timeoutMs?: number;
}

/**
 * Render the prompt with both records in full.
 *
 * Full text, not a similarity score. A score cannot tell "same subject, both still true"
 * from "same subject, one refutes the other" — the two cases that need opposite answers
 * look identical to it. Measured in this repo's own experiments: the decay proxy that
 * ranked on age and similarity got the ranking right and the exclusion wrong.
 */
export function renderPrompt(
  input: JudgeInput,
  template?: string,
  promptVersion = PROMPT_VERSION,
): string {
  const tpl = template ?? defaultTemplate();
  const fmt = (r: JudgeInput["oldRecord"]): string =>
    [
      `record_id: ${r.record_id}`,
      `type: ${r.type}`,
      `created: ${r.created_time}`,
      r.scene_name ? `scene: ${r.scene_name}` : null,
      "content:",
      r.content,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  // Function replacers, not strings: a record whose text contains $& or $' would
  // otherwise be interpreted as a replacement pattern and splice template fragments into
  // the prompt — i.e. hand the model our instructions as if they were its data. One row
  // of the 822-record corpus already contains $'.
  const body = tpl
    .replace("{old}", () => fmt(input.oldRecord))
    .replace("{new}", () => fmt(input.newRecord));
  const ctx = input.context ? `\n\nContext for both records:\n${input.context}` : "";
  return `${body}${ctx}\n\nPrompt version: ${promptVersion}`;
}

function defaultTemplate(): string {
  return readFileSync(join(import.meta.dirname, "prompts", "supersede-judge.md"), "utf8");
}

/**
 * Parse the model's reply.
 *
 * Tolerant about framing (models like to wrap JSON in prose or fences) and strict about
 * substance: anything that is not one of the three verdicts becomes a `null` verdict with
 * an error, NOT a default. Defaulting to `keep-both` here would be tempting and wrong —
 * it would hide a broken parser behind plausible-looking output.
 */
export function parseVerdict(raw: string): { verdict: SupersedeVerdict | null; confidence: number; error?: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: null, confidence: 0, error: "no JSON object in the reply" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    return { verdict: null, confidence: 0, error: `reply was not valid JSON: ${(err as Error).message}` };
  }
  const obj = parsed as { verdict?: unknown; confidence?: unknown };
  const verdict = obj.verdict;
  if (verdict !== "supersede" && verdict !== "keep-both" && verdict !== "unrelated") {
    return { verdict: null, confidence: 0, error: `verdict was ${JSON.stringify(verdict)}, not one of the three` };
  }
  const confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : 0;
  return { verdict, confidence: Math.min(1, Math.max(0, confidence)) };
}

/**
 * Classify one pair.
 *
 * Every failure path — timeout, network error, unparseable reply, unrecognised verdict —
 * returns `verdict: null`. There is no branch in this function that returns `supersede`
 * without the model having said so. That is a deliberate structural property, not a
 * convention: a test enumerates the failure paths and asserts none of them yields a
 * verdict at all.
 */
export async function judgePair(input: JudgeInput, opts: JudgeOptions): Promise<JudgeResult> {
  const base = { modelId: opts.provider.modelId, promptVersion: PROMPT_VERSION, raw: "", confidence: 0 };
  const prompt = renderPrompt(input, opts.promptTemplate);

  let raw: string;
  try {
    raw = await withTimeout(opts.provider.complete(prompt), opts.timeoutMs ?? 30_000);
  } catch (err) {
    return { ...base, verdict: null, error: `provider failed: ${(err as Error).message}` };
  }

  const parsed = parseVerdict(raw);
  if (parsed.verdict === null) {
    return { ...base, raw, verdict: null, error: parsed.error };
  }
  return { ...base, raw, verdict: parsed.verdict, confidence: parsed.confidence };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** An HTTP provider for a real model. Not used by tests, which inject a fake. */
export function httpProvider(opts: { url: string; model: string; apiKey?: string; timeoutMs?: number }): JudgeProvider {
  return {
    modelId: opts.model,
    async complete(prompt: string): Promise<string> {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          // Deterministic decoding, so the same pair yields the same verdict and the
          // accuracy report can be recomputed by a third party.
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; response?: string };
      const text = body.choices?.[0]?.message?.content ?? body.response;
      if (typeof text !== "string") throw new Error("response had no text");
      return text;
    },
  };
}

// ─────────────────────────── persistence and the mode gate ───────────────────────────

export type CriteriaMode = "shadow" | "apply";

/** One candidate pair to judge, as listed in the review set. */
export interface CandidatePair {
  pairId: string;
  oldId: string;
  newId: string;
  /** Human ground truth, once someone has labelled it. Absent until then. */
  humanVerdict?: SupersedeVerdict | null;
  labelledBy?: string;
  labelledAt?: string;
}

export interface ReviewSet {
  version: string;
  /** How the sample was drawn. Required: a set nobody can regenerate is not evidence. */
  sampling: string;
  source: string;
  createdAt: string;
  /**
   * Who labelled the pairs, when, and by what rule.
   *
   * The per-pair fields are authoritative; these are the set-level summary. Both exist
   * because a set can be labelled in one sitting (summary) and later corrected pair by
   * pair (per-pair), and a reviewer needs to see both. A rate whose provenance is unknown
   * is not something to paste into an apply gate.
   */
  labelledBy?: string;
  labelledAt?: string;
  labelMethod?: string;
  pairs: CandidatePair[];
}

export interface RunCriteriaOptions {
  dbPath: string;
  pairs: CandidatePair[];
  mode: CriteriaMode;
  judge: JudgeOptions;
  /**
   * False-supersede rate measured from the review set. Required for `apply`; ignored in
   * shadow. `null` means "no measurement", which the gate treats as failure — not as 0.
   */
  measuredFalseSupersedeRate: number | null;
  /** Where the rate came from, quoted in the rejection message. */
  reportPath?: string;
  actor?: string;
  now?: () => Date;
}

export interface CriteriaOutcome {
  pairId: string;
  oldId: string;
  newId: string;
  verdict: SupersedeVerdict | null;
  confidence: number;
  /** True when this run wrote `invalid_at`. Only possible in apply mode, past the gate. */
  applied: boolean;
  /**
   * Set when the judge said `supersede` but the record was already invalid, so the UPDATE
   * matched no row. Distinct from `applied: false` on its own, which is also what a
   * keep-both verdict looks like — an operator re-running an apply needs to be able to tell
   * "nothing to do" from "the judge declined".
   */
  alreadyInvalid?: boolean;
  error?: string;
}

export interface CriteriaRunResult {
  mode: CriteriaMode;
  applied: boolean;
  rejection: string | null;
  outcomes: CriteriaOutcome[];
  auditRows: number;
  /** Records whose invalid_at this run set. Empty unless the gate passed. */
  invalidated: string[];
}

/** Why an apply run was refused. Each maps to a CLI exit code. */
export type GateRejection = "no-measurement" | "rate-above-threshold";

export interface GateDecision {
  allowed: boolean;
  rejection: GateRejection | null;
  message: string;
}

/**
 * The apply gate.
 *
 * A missing measurement fails the gate. That direction matters: treating "no report" as
 * "rate 0, looks great" would let an unmeasured judge start deleting recall results the
 * moment someone forgot to copy a file in.
 */
export function checkApplyGate(
  rate: number | null,
  reportPath: string | undefined,
  threshold = LLM_APPLY_MAX_FALSE_SUPERSEDE,
): GateDecision {
  // A rate outside [0, 1] is not a measurement either. Without this, "-0.5" passes the
  // range check below by being less than the threshold — the same class of mistake as
  // treating "no measurement" as 0%, only harder to spot because a number was supplied.
  if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    const why =
      rate === null || !Number.isFinite(rate)
        ? "no false-supersede measurement available"
        : `false-supersede rate ${rate} is not a rate (expected 0..1)`;
    return {
      allowed: false,
      rejection: "no-measurement",
      message:
        `error: --mode=apply refused: ${why}` +
        (reportPath ? ` (looked at ${reportPath})` : "") +
        `. The threshold is ${threshold} and an unmeasured judge is not assumed to pass it. ` +
        `Run the review set and produce the report first.`,
    };
  }
  if (rate >= threshold) {
    return {
      allowed: false,
      rejection: "rate-above-threshold",
      message:
        `error: --mode=apply refused: measured false-supersede rate ${(rate * 100).toFixed(1)}% ` +
        `>= threshold ${(threshold * 100).toFixed(1)}%` +
        (reportPath ? ` (report: ${reportPath})` : "") +
        `. Shadow mode still records suggestions; the judge does not get to act yet.`,
    };
  }
  return { allowed: true, rejection: null, message: "" };
}

interface ReadRow {
  record_id: string;
  content: string;
  type: string;
  created_time: string;
  scene_name: string;
}

function readRecord(db: DatabaseSync, id: string): ReadRow | undefined {
  return db
    .prepare("SELECT record_id, content, type, created_time, scene_name FROM l1_records WHERE record_id = ?")
    .get(id) as ReadRow | undefined;
}

/**
 * Run the judge over a set of pairs.
 *
 * SHADOW: writes `forgetting_audit` rows with `action='llm-suggest'` and nothing else.
 * The UPDATE statements for `invalid_at` / `superseded_by` are not issued at all — the
 * code path that reaches them is guarded by the mode, checked before any write. There is
 * no transaction to roll back because there is nothing to roll back.
 *
 * APPLY: only reached once `checkApplyGate` passes. Writes the invalidation AND an audit
 * row attributed to the LLM, with the report path in the reason, so a record invalidated
 * by a model is distinguishable from one invalidated by a person.
 */
export async function runCriteria(opts: RunCriteriaOptions): Promise<CriteriaRunResult> {
  const mode = opts.mode;

  if (mode === "apply") {
    const gate = checkApplyGate(opts.measuredFalseSupersedeRate, opts.reportPath);
    if (!gate.allowed) {
      return {
        mode,
        applied: false,
        rejection: gate.rejection,
        outcomes: [],
        auditRows: 0,
        invalidated: [],
      };
    }
  }

  migrate(opts.dbPath);
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const runId = `criteria-${mode}-${nowIso.replace(/[:.]/g, "-")}`;

  const outcomes: CriteriaOutcome[] = [];
  const invalidated: string[] = [];
  let auditRows = 0;

  const db = new DatabaseSync(opts.dbPath);
  try {
    for (const pair of opts.pairs) {
      const oldRec = readRecord(db, pair.oldId);
      const newRec = readRecord(db, pair.newId);
      if (!oldRec || !newRec) {
        outcomes.push({
          pairId: pair.pairId,
          oldId: pair.oldId,
          newId: pair.newId,
          verdict: null,
          confidence: 0,
          applied: false,
          error: "record missing from the database",
        });
        continue;
      }

      const judged = await judgePair(
        {
          oldRecord: oldRec,
          newRecord: newRec,
        },
        opts.judge,
      );

      // A failed judgement is recorded as a failed judgement — the audit row says
      // "could not judge", which is information. What it must NOT become is a silent
      // skip, because then a persistently broken judge looks like a working one.
      const reason =
        judged.verdict === null
          ? `llm-suggest: could not judge (${judged.error ?? "unknown"}); model=${judged.modelId} prompt=${judged.promptVersion}`
          : `llm-suggest: verdict=${judged.verdict} confidence=${judged.confidence.toFixed(2)} model=${judged.modelId} prompt=${judged.promptVersion}`;

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO forgetting_audit
             (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
           VALUES (?, ?, ?, ?, 'active', 'suggested', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          runId,
          pair.oldId,
          LLM_SUGGEST_ACTION,
          judged.confidence,
          reason,
          nowIso,
          now.getTime(),
        );
        auditRows++;

        // ── the isolation boundary ──
        // Only an apply run past the gate reaches this block, and only a supersede
        // verdict triggers it. In shadow, execution never arrives here.
        if (mode === "apply" && judged.verdict === "supersede") {
          const updated = db
            .prepare(
              "UPDATE l1_records SET invalid_at = ?, superseded_by = ? WHERE record_id = ? AND invalid_at IS NULL",
            )
            .run(nowIso, pair.newId, pair.oldId);
          // The UPDATE is guarded by "invalid_at IS NULL", so re-running an apply over the
          // same review set changes nothing. Writing the audit row anyway would claim an
          // action that did not happen, and the audit trail is the only way this project can
          // correct a wrong invalidation later - a phantom row destroys that. Same contract as
          // src/invalidation.ts: changes === 0 means report nothing.
          const changed = Number((updated as { changes?: number }).changes ?? 0);
          if (changed === 0) {
            outcomes.push({
              pairId: pair.pairId,
              oldId: pair.oldId,
              newId: pair.newId,
              verdict: judged.verdict,
              confidence: judged.confidence,
              applied: false,
              error: undefined,
              alreadyInvalid: true,
            });
            db.exec("COMMIT");
            continue;
          }
          db.prepare(
            `INSERT INTO forgetting_audit
               (audit_id, run_id, record_id, action, from_state, to_state, score, reason, decided_at, decided_at_ms)
             VALUES (?, ?, ?, 'invalidate', 'active', 'invalidated', ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            runId,
            pair.oldId,
            judged.confidence,
            `LLM verdict supersede (confidence ${judged.confidence.toFixed(2)}), model=${judged.modelId}` +
              (opts.reportPath ? `, report=${opts.reportPath}` : ""),
            nowIso,
            now.getTime(),
          );
          auditRows++;
          invalidated.push(pair.oldId);
        }

        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already gone */
        }
        throw err;
      }

      outcomes.push({
        pairId: pair.pairId,
        oldId: pair.oldId,
        newId: pair.newId,
        verdict: judged.verdict,
        confidence: judged.confidence,
        applied: mode === "apply" && judged.verdict === "supersede",
        error: judged.error,
      });
    }
    const result: CriteriaRunResult = {
      mode,
      applied: mode === "apply",
      rejection: null,
      outcomes,
      auditRows,
      invalidated,
    };
    // The gate's input comes from a measurement taken OUTSIDE this run, so the run has to
    // leave behind something a third party can recheck: which pairs, which verdicts, and
    // which number the gate was handed. Written last, after the transaction, so a report
    // on disk always describes work that actually landed.
    if (opts.reportPath) writeRunReport(opts.reportPath, opts, result, runId, nowIso);
    return result;
  } finally {
    db.close();
  }
}

/**
 * Persist what the run decided.
 *
 * Deliberately a plain JSON artefact with no timestamps beyond the run's own: the review
 * set is regenerable from the same database and seed, so the report is checkable rather
 * than merely trustworthy.
 */
function writeRunReport(
  path: string,
  opts: RunCriteriaOptions,
  result: CriteriaRunResult,
  runId: string,
  startedAt: string,
): void {
  const judged = result.outcomes.filter((o) => o.verdict !== null);
  const supersedes = judged.filter((o) => o.verdict === "supersede");
  const report = {
    report: "criteria-run/1",
    runId,
    startedAt,
    mode: result.mode,
    model: opts.judge.provider.modelId,
    promptVersion: PROMPT_VERSION,
    db: opts.dbPath,
    pairs: opts.pairs.length,
    judged: judged.length,
    unjudged: result.outcomes.length - judged.length,
    verdicts: {
      supersede: supersedes.length,
      "keep-both": judged.filter((o) => o.verdict === "keep-both").length,
      unrelated: judged.filter((o) => o.verdict === "unrelated").length,
    },
    auditRows: result.auditRows,
    invalidated: result.invalidated,
    measuredFalseSupersedeRate: opts.measuredFalseSupersedeRate ?? null,
    gateThreshold: LLM_APPLY_MAX_FALSE_SUPERSEDE,
    gateAllowed: result.mode === "apply" ? result.rejection === null : null,
    outcomes: result.outcomes,
  };
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
}

/** Every LLM suggestion on record, so a reviewer can see what the judge has been saying. */
export function listSuggestions(dbPath: string, limit = 200): Array<{ record_id: string; reason: string; decided_at: string }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // A database that has never been migrated has no audit table at all. That is "no
    // suggestions yet", not an error: the question "what has the judge been saying" has
    // the answer "nothing" on a fresh database, and it should not need a migration to say
    // so. (The sibling `auditSummary` path already guards the same way.)
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forgetting_audit'")
      .get() as { name?: string } | undefined;
    if (!has) return [];
    return db
      .prepare(
        "SELECT record_id, reason, decided_at FROM forgetting_audit WHERE action = ? ORDER BY decided_at DESC LIMIT ?",
      )
      .all(LLM_SUGGEST_ACTION, limit) as Array<{ record_id: string; reason: string; decided_at: string }>;
  } finally {
    db.close();
  }
}
