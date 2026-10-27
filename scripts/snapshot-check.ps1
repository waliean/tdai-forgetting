<#
  Snapshot / copy self-check for a tdai memory database.

  Moved here from the drill guide (docs/guides/回退演练-2026-10-26.md) so the key list
  in the docs can be taken from a real run instead of hand-copied -- the hand-copied
  version had already drifted twice (a key that never existed, and four wal keys
  described as conditional when they are always present).

  Usage (dot-source it; the functions then live in your shell):

    . .\scripts\snapshot-check.ps1
    $stamp = Get-SnapshotStamp -SourceDbPath <source db>
    <copy the three files, or VACUUM INTO>
    Show-Snapshot -DbPath <copy> -SourceDbPath <source db> -SourceStampBefore $stamp

  Source side is only stat'ed and read as bytes; the SQLite connections are opened on
  the copy under test and on a throwaway copy of the source in %TEMP%.

  Save this file as UTF-8 **with BOM**: Windows PowerShell 5.1 reads a BOM-less file as
  ANSI, so the Chinese comments above turn into mojibake and parse as code ("意外的标记 }").
#>

# 取快照自查（REV-005 修订）。判据是「三项计数是否相等」+「源在拷贝期间动没动」。
# 不再用「副本比源旧多少秒」判：那个数是「源最后写」减「最后一次入库写」，
# 而 src/applier.ts:88–92 只写 state / forget_reason / forgotten_time，不动 updated_time，
# 所以 apply 之后每一份副本的 lag 都是小时级，与「拷得多新」无关。
#
# 用法（顺序是死的：stamp 必须在拷贝之前取）：
#   $stamp = Get-SnapshotStamp -SourceDbPath <源库>
#   <拷贝三件 / 或你的 VACUUM INTO>
#   Show-Snapshot -DbPath <副本> -SourceDbPath <源库> -SourceStampBefore $stamp
function Get-SnapshotStamp {
  param(
    [Parameter(Mandatory)][string]$SourceDbPath,
    [string]$SourceWalPath
  )
  if (-not (Test-Path -LiteralPath $SourceDbPath)) { throw "BAD ARGUMENT: -SourceDbPath '$SourceDbPath' does not exist" }
  if ($SourceWalPath -and -not (Test-Path -LiteralPath $SourceWalPath)) {
    throw "BAD ARGUMENT: -SourceWalPath '$SourceWalPath' does not exist -- omit it to auto-detect '<SourceDbPath>-wal'"
  }
  $env:TDAI_DB  = $SourceDbPath
  $env:TDAI_WAL = $SourceWalPath
  @'
import { existsSync, statSync } from "node:fs";
// Stat only. Nothing here opens the source database, so no -shm and no zero-byte -wal
// appear beside it -- which is what makes it safe right before a copy, the one moment
// when the source directory must not gain files.
const db = process.env.TDAI_DB;
const wal = process.env.TDAI_WAL || (db + "-wal");
const wb = existsSync(wal) ? statSync(wal).size : 0;
const m = statSync(db);
console.log("main=" + m.size + "@" + m.mtimeMs + ";wal=" + wb + "@" +
  (wb > 0 ? statSync(wal).mtimeMs : "none"));
'@ | node --input-type=module
  if ($LASTEXITCODE -ne 0) { throw "Get-SnapshotStamp failed (exit $LASTEXITCODE)" }
}

function Show-Snapshot {
  param(
    [Parameter(Mandatory)][string]$DbPath,
    [string]$SourceDbPath,
    [string]$SourceWalPath,
    [string]$SourceStampBefore,
    [switch]$ActionOnly
  )
  if (-not (Test-Path -LiteralPath $DbPath)) { throw "BAD ARGUMENT: -DbPath '$DbPath' does not exist" }
  if ($SourceDbPath -and -not (Test-Path -LiteralPath $SourceDbPath)) { throw "BAD ARGUMENT: -SourceDbPath '$SourceDbPath' does not exist" }
  # A path that does not exist is a typo, not "the source has no -wal". Those two used to
  # read the same, and the typo came out as UNVERIFIED / use / exit 0 -- pointing the
  # operator away from the copy and at a nonexistent problem.
  if ($SourceWalPath -and -not (Test-Path -LiteralPath $SourceWalPath)) {
    throw "BAD ARGUMENT: -SourceWalPath '$SourceWalPath' does not exist -- omit it to auto-detect '<SourceDbPath>-wal', which covers the 'source has no -wal' case"
  }

  # Self-comparison guard. Pointing -SourceDbPath at the copy under test makes the
  # function compare the file with itself: all three counts match by construction, so
  # it printed OK / use / exit 0 on a copy nobody had checked. Resolve both paths first
  # (case-insensitive on Windows, and Resolve-Path collapses '..' and symlink targets)
  # so the same file reached by two spellings still hits this branch.
  if ($SourceDbPath) {
    $dbResolved  = (Resolve-Path -LiteralPath $DbPath).ProviderPath
    $srcResolved = (Resolve-Path -LiteralPath $SourceDbPath).ProviderPath
    if ([string]::Equals($dbResolved, $srcResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ("BAD ARGUMENT: -SourceDbPath and -DbPath resolve to the same file ($dbResolved) -- comparing a copy with itself always matches the counts; pass the real source database")
    }
  }
  $env:TDAI_CP    = $DbPath
  $env:TDAI_SRC   = $SourceDbPath
  $env:TDAI_WAL   = $SourceWalPath
  $env:TDAI_STAMP = $SourceStampBefore
  $js = @'
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cp  = process.env.TDAI_CP;
const src = process.env.TDAI_SRC || "";
const walGiven = process.env.TDAI_WAL || "";
const stampBefore = process.env.TDAI_STAMP || "";

// Measured by size, not by exists(): a read-only open of a WAL database leaves a
// zero-byte -wal next to the copy, so exists() would flip to true on the second run.
const copyWal = existsSync(cp + "-wal") ? statSync(cp + "-wal").size : 0;

// The three forward counts. An item a database cannot answer (no such table, no such
// column) is null. If the source answers one and the copy cannot, that is itself a
// difference: the copy cannot hold rows the source has.
const COUNT_DEFS = [
  { key: "l1_records", sql: "SELECT COUNT(*) AS c FROM l1_records",
    ok: () => true },
  { key: "forgetting_audit", sql: "SELECT COUNT(*) AS c FROM forgetting_audit",
    ok: (d) => !!d.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='forgetting_audit'").get() },
  { key: "not_active", sql: "SELECT COUNT(*) AS c FROM l1_records WHERE state <> 'active'",
    ok: (d) => !!d.prepare("SELECT 1 AS x FROM pragma_table_info('l1_records') WHERE name='state'").get() },
];
const readCounts = (d) => {
  const o = {};
  for (const def of COUNT_DEFS) o[def.key] = def.ok(d) ? d.prepare(def.sql).get().c : null;
  return o;
};

const db = new DatabaseSync(cp, { readOnly: true });
const one = (s) => db.prepare(s).get();
const copyCounts = readCounts(db);
const out = {
  file_bytes: statSync(cp).size,
  journal_mode: one("PRAGMA journal_mode").journal_mode,
  l1_rows: one("SELECT COUNT(*) AS c FROM l1_records").c,
  max_updated_time: one("SELECT MAX(updated_time) AS m FROM l1_records").m,
  checked_at: one("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").t,
  vec_rows: one("SELECT COUNT(DISTINCT rowid) AS c FROM l1_vec_rowids").c,
  has_state_column: !!one("SELECT name FROM pragma_table_info('l1_records') WHERE name='state'"),
  integrity: String(one("PRAGMA integrity_check").integrity_check),
};
db.close();

// ---- source side: sizes by stat, counts on a throwaway copy ---------------------
// A read-only connection to a WAL database creates -shm -- and, when its -wal was
// truncated, a zero-byte -wal -- inside the source directory. Counting by opening the
// source therefore edits the directory being measured: that is why source_wal_present
// flipped from false to true between two runs of one fixture, and why a later "copy all
// three files" of that directory would drag a 0-byte -wal along. So the sizes come from
// stat, and the counts come from a copy under the temp directory.
const srcWal = walGiven || (src ? src + "-wal" : "");
const srcWalBytes = srcWal && existsSync(srcWal) ? statSync(srcWal).size : 0;
const srcWalMtime = srcWalBytes > 0 ? statSync(srcWal).mtime.toISOString() : null;
const srcMain = src ? statSync(src) : null;
const stampNow = src ? ("main=" + srcMain.size + "@" + srcMain.mtimeMs + ";wal=" + srcWalBytes +
  "@" + (srcWalBytes > 0 ? statSync(srcWal).mtimeMs : "none")) : null;

out.copy_wal_bytes = copyWal;
out.wal_files_present = copyWal > 0;
out.copy_counts = copyCounts;
out.source_wal_present = srcWalBytes > 0;
out.source_wal_bytes = srcWal ? srcWalBytes : null;
out.source_wal_mtime = srcWalMtime;
out.copy_lag_seconds_vs_wal = null;
out.source_stamp_before = stampBefore || null;
out.source_stamp_now = stampNow;
out.source_moved = null;
out.count_note = null;

// Informational only, never a verdict input: "last row insert" against "last write of
// any kind". src/applier.ts:88-92 never touches updated_time, so one apply run leaves
// every later copy "hours older" no matter when it was taken.
if (srcWalBytes > 0 && out.max_updated_time) {
  out.copy_lag_seconds_vs_wal =
    Math.round((Date.parse(srcWalMtime) - Date.parse(out.max_updated_time)) / 1000);
}

// Did the source move between the copy and this reading? The stamp taken before the copy
// answers it, with one extra reading: if the copy's own mtime is older than that stamp,
// the copy was taken before this stamp window existed, so the source has been written
// since and this reading cannot attribute the gap (a historical snapshot looks exactly
// like this). Copy-Item and copyFileSync preserve mtime, which is what makes the
// comparison meaningful; a VACUUM INTO product carries the time it was written.
// The 5 s tolerance is for timestamp granularity, not for sloppy copying: exFAT and some
// SMB shares store mtime to the second or two, so a copy landing there can read a little
// older than the source it came from. Without the tolerance that rounding would look like
// "the source moved" on a perfectly good copy -- the retry loop this change exists to kill.
const STAMP_SLACK_MS = 5000;
const stampMainMs = /main=\d+@([\d.]+)/.exec(stampBefore);
if (stampBefore) {
  const copyMainMs = statSync(cp).mtimeMs;
  const predates = stampMainMs && (copyMainMs < Number(stampMainMs[1]) - STAMP_SLACK_MS);
  out.source_moved = predates ? true : (stampBefore !== stampNow);
}

// Forward counting: the only check that answers "did this copy lose committed data".
// MAX(updated_time) cannot answer it. src/applier.ts:88-92 writes only state /
// forget_reason / forgotten_time, so a copy missing whole apply runs can still carry
// a MAX(updated_time) fresh enough to look caught-up.
let compared = 0;
const short = [];
const ahead = [];
if (src) {
  const tmp = mkdtempSync(join(tmpdir(), "tdai-snap-"));
  let sourceCounts = null;
  try {
    const tdb = join(tmp, "vectors.db");
    copyFileSync(src, tdb);
    if (srcWalBytes > 0) copyFileSync(srcWal, tdb + "-wal");
    const sdb = new DatabaseSync(tdb, { readOnly: true });
    // The twin has to be self-consistent before its counts mean anything: a source
    // written to during the copy yields a torn page set, and reading that would blame
    // the copy under test for a number taken from a broken twin.
    const ok = String(sdb.prepare("PRAGMA integrity_check").get().integrity_check);
    if (ok !== "ok") throw new Error("torn source copy (integrity_check " + ok + ")");
    sourceCounts = readCounts(sdb);
    sdb.close();
  } catch (e) {
    out.count_note = "source counts skipped: " + e.message;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (sourceCounts) {
    out.source_counts = sourceCounts;
    const deltas = {};
    for (const def of COUNT_DEFS) {
      const a = copyCounts[def.key];
      const b = sourceCounts[def.key];
      if (a === null && b === null) { deltas[def.key] = "not compared (absent on both sides)"; continue; }
      if (a === null) { deltas[def.key] = "absent on copy"; short.push(def.key + ": absent on copy, present on source"); continue; }
      if (b === null) { deltas[def.key] = "absent on source"; ahead.push(def.key + ": present on copy, absent on source"); continue; }
      compared += 1;
      deltas[def.key] = a - b;   // negative: the copy is short of the source
      if (a < b) short.push(def.key + " copy " + a + " vs source " + b + " (" + (a - b) + ")");
      if (a > b) ahead.push(def.key + " copy " + a + " vs source " + b + " (+" + (a - b) + ")");
    }
    out.count_deltas = deltas;
  }
}
const countsDiffer = short.length > 0 || ahead.length > 0;
const unusable = out.l1_rows === 0 || !out.max_updated_time || out.integrity !== "ok";

// The count axis on its own, so it reads without parsing the verdict word.
out.count_check = compared === 0 ? "not_compared" : (countsDiffer ? "diff" : "match");

// Verdict vocabulary. One word, one meaning, precedence top to bottom:
//   UNUSABLE   -- zero rows, no updated_time, or integrity_check failed. Never OK.
//   MISMATCH   -- counts differ and the difference is the copy's fault: the copy holds
//                 rows the source lacks, or the source provably did not move while the
//                 copy was taken, so the rows were never in the copy.
//   OLDER      -- counts differ and the source provably moved after the copy: the copy is
//                 a picture of an older source state. Re-copy while the source is still
//                 and the same command settles it. The only case a re-run fixes.
//   UNVERIFIED -- nothing compared, or the copy is short and the source's stillness was
//                 never measured (no -SourceStampBefore). Not a pass.
//   OK         -- every countable item matches the source.
let code = 0;
const shortText = short.join("; ");
const aheadText = ahead.join("; ");
if (unusable) {
  out.verdict = "UNUSABLE (zero rows, no updated_time, or integrity_check failed)";
} else if (ahead.length > 0) {
  out.verdict = "MISMATCH (copy has rows the source lacks: " + aheadText + " -- wrong -SourceDbPath?)";
} else if (short.length > 0 && out.source_moved === false) {
  out.verdict = "MISMATCH (copy is short of source and the source did not move while the copy " +
    "was taken, so the rows are missing from the copy: " + shortText + ")";
} else if (short.length > 0 && out.source_moved === true) {
  out.verdict = "OLDER (the source moved after this copy was taken and counts differ: " + shortText +
    " -- re-copy while the source is still)";
} else if (short.length > 0) {
  out.verdict = "UNVERIFIED (counts differ (" + shortText + ") and the source's stillness was never " +
    "measured -- take Get-SnapshotStamp before copying and pass it as -SourceStampBefore)";
} else if (compared > 0) {
  out.verdict = "OK (counts match source" +
    (out.source_moved === true ? "; the source moved after the copy but no counted row differs" : "") + ")";
} else if (src && out.count_note) {
  out.verdict = "UNVERIFIED (counts not compared: " + out.count_note + ")";
} else if (src) {
  out.verdict = "UNVERIFIED (counts not compared: no item both sides could answer)";
} else if (walGiven) {
  out.verdict = "UNVERIFIED (no -SourceDbPath, so neither counts nor a stamp -- pass -SourceDbPath)";
} else {
  out.verdict = "UNVERIFIED (no -SourceDbPath and no -SourceWalPath given)";
}

// Operational twin, so a script never parses the prose:
//   reject  -- do not use this copy. UNUSABLE, MISMATCH, or a shortfall nobody can
//              attribute: in all three the copy does not demonstrably hold what the
//              source holds. Doubt lands here, not in a pass.
//   recheck -- the source provably moved; re-copy while it is still and run it again.
//              NOT a pass and NOT a retry loop: it voids this reading.
//   use     -- every countable item matches the source. The only pass.
//   unknown -- nothing was compared, so nothing is claimed.
out.action = unusable
  ? "reject"
  : (ahead.length > 0) ? "reject"
  : (short.length > 0) ? (out.source_moved === true ? "recheck" : "reject")
  : (compared > 0 ? "use" : "unknown");
if (out.action === "reject") code = 2;
console.log(JSON.stringify(out, null, 2));
if (code === 2) process.exitCode = 2;
'@
  $raw = $js | node --input-type=module
  $code = $LASTEXITCODE
  if ($code -ne 0 -and $code -ne 2) { throw "snapshot check failed (exit $code)" }
  $json = $raw -join [char]10
  $obj = $json | ConvertFrom-Json
  # Output contract, and the only one a script should consume:
  #   Show-Snapshot -DbPath …               -> the JSON text (pipe it into ConvertFrom-Json)
  #   Show-Snapshot -DbPath … -ActionOnly   -> one word: use / recheck / reject / unknown
  # -ActionOnly never throws, so a cron line can tell "rejected" from "the script crashed".
  # The plain form still throws on reject: at a prompt the run should stop, and node's 2
  # becomes the outer PowerShell's 1 (measured; see the exit-code table in the doc).
  if ($ActionOnly) { return $obj.action }
  Write-Output $json
  if ($code -eq 2) { throw ("DO NOT USE THIS COPY -- " + $obj.verdict) }
}
