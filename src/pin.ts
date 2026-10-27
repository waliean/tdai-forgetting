/**
 * Pin resolution.
 *
 * tdai has no notion of a memory that must survive forgetting. The live corpus
 * carries two separate signals of "do not throw this away":
 *
 *   - 59 records already marked priority = -1, the upstream convention for a
 *     global instruction;
 *   - 162 instruction records whose body says 永久记住 / 不得遗忘 / 不得删除.
 *
 * Any decay or quota policy that ignores these will demote exactly the memories
 * users asked to keep, and it will do so silently. This module turns those
 * signals into a pin kind plus the reason it fired, so the audit trail can answer
 * "why was this record spared" without re-deriving it.
 *
 * Two levels, because the corpus has two levels of intent:
 *
 *   hard     - never decayed, never evicted. Explicit metadata pins, priority -1,
 *              and instructions that state permanence.
 *   extended - decays, but against a stretched half-life (default 12x). Applied to
 *              non-instruction records that merely quote a permanence request.
 *              Refusing to treat a quote as a command matters: "用户要求 AI 永久记住
 *              X" inside an episodic dump is a record of a request, not the request.
 *
 * Whatever the rules miss shows up in the plan's review list rather than being
 * forgotten quietly.
 */

import type { MemoryRecord, PinKind } from "./types.ts";

export type PinRule = "metadata" | "priority" | "instruction" | "quote" | "persona";

export interface PinResult {
  pinned: boolean;
  kind?: PinKind;
  reason?: string;
  rule?: PinRule;
}

/**
 * Wording that means "keep this". Single source of truth so the report and the
 * engine agree on what counted as a permanence claim.
 *
 * Deliberately conservative: phrases that state durability, not phrases that
 * describe importance. "重要" does not pin; "不得删除" does.
 */
export const PERMANENCE_PATTERN =
  /永久(记住|保留|保存|存档|有效|存放|记忆)|不得(遗忘|删除|覆盖|清除)|永不?(删除|遗忘)|禁止(删除|遗忘)|(不要|请勿|别)(删除|遗忘|覆盖|清除)|never\s+forget|do\s+not\s+(forget|delete)|remember\s+forever|keep\s+forever/i;

export interface PinOptions {
  /** Treat every tdai global-instruction record (priority = -1) as a hard pin. Default true. */
  pinPriorityMinusOne: boolean;
  /** Treat instruction-type records carrying permanence wording as a hard pin. Default true. */
  pinInstructionPermanence: boolean;
  /** Give non-instruction records that quote permanence an extended half-life. Default true. */
  extendQuotedPermanence: boolean;
  /** Half-life multiplier for extended pins. Default 12 (a year at a 30-day half-life keeps ~43%). */
  extendedMultiplier: number;
  /** Treat persona records as hard pins. Default false: persona is regenerated from L0. */
  pinPersona: boolean;
}

export const DEFAULT_PIN_OPTIONS: PinOptions = {
  pinPriorityMinusOne: true,
  pinInstructionPermanence: true,
  extendQuotedPermanence: true,
  extendedMultiplier: 12,
  pinPersona: false,
};

function metadataPin(record: MemoryRecord): PinKind | undefined {
  if (!record.metadata_json) return undefined;
  try {
    const meta = JSON.parse(record.metadata_json) as Record<string, unknown>;
    if (meta.pin === true || meta.pinned === true) return "hard";
    if (meta.pin_kind === "hard" || meta.pin_kind === "extended") return meta.pin_kind;
    return undefined;
  } catch {
    // Malformed metadata is not a pin signal. Ignoring beats pinning on a parse accident.
    return undefined;
  }
}

export function resolvePin(record: MemoryRecord, opts: PinOptions = DEFAULT_PIN_OPTIONS): PinResult {
  const explicit = metadataPin(record);
  if (explicit) {
    return { pinned: true, kind: explicit, rule: "metadata", reason: `metadata pin_kind=${explicit}` };
  }
  if (opts.pinPriorityMinusOne && record.priority === -1) {
    return { pinned: true, kind: "hard", rule: "priority", reason: "priority=-1 (global instruction)" };
  }
  if (opts.pinPersona && record.type === "persona") {
    return { pinned: true, kind: "hard", rule: "persona", reason: "type=persona" };
  }
  const asserts = PERMANENCE_PATTERN.test(record.content);
  if (asserts && opts.pinInstructionPermanence && record.type === "instruction") {
    return { pinned: true, kind: "hard", rule: "instruction", reason: "instruction asserts permanence" };
  }
  if (asserts && opts.extendQuotedPermanence && record.type !== "instruction") {
    return {
      pinned: true,
      kind: "extended",
      rule: "quote",
      reason: `quotes permanence (half-life x${opts.extendedMultiplier})`,
    };
  }
  return { pinned: false };
}

/**
 * Whether a record is hard-pinned, without requiring that `applyPins` ran first.
 *
 * The scorer needs this answer on its own: the shipped patch (src/l1-decay.ts)
 * derives the pin from `priority === -1` directly, and if the engine's version only
 * honoured a pre-computed flag, the two would disagree on exactly the records that
 * matter most. test/equivalence.test.ts is what caught that.
 */
export function isHardPinned(record: MemoryRecord): boolean {
  if (record.pin_kind === "hard") return true;
  return record.priority === -1 && (record.state ?? "active") !== "archived";
}

export function applyPins(records: MemoryRecord[], opts: PinOptions = DEFAULT_PIN_OPTIONS): MemoryRecord[] {
  return records.map((record) => {
    const { pinned, kind, reason } = resolvePin(record, opts);
    if (!pinned) return { ...record, pinned: false };
    return {
      ...record,
      pinned: true,
      pin_kind: kind,
      pin_reason: reason,
      pin_half_life_multiplier: kind === "extended" ? opts.extendedMultiplier : undefined,
    };
  });
}

/**
 * Records whose text asserts permanence but which no rule protected. With the
 * defaults this stays empty; it is the safety net for a corpus where someone
 * lowers the pin rules, and the "did the rules miss anything" check for a new one.
 */
export function unprotectedPermanence(records: MemoryRecord[]): MemoryRecord[] {
  return records.filter((r) => !r.pinned && PERMANENCE_PATTERN.test(r.content));
}
