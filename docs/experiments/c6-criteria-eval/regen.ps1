
# End-to-end rehearsal for the C6 criteria feature.
#
# Runs the documented scenarios (shadow / three gate refusals / apply / re-apply) and the
# measurement chain against fresh copies of a snapshot database. Everything it writes lands
# in -Work; neither the snapshot nor the committed evidence in this directory is touched.
#
#   & docs\experiments\c6-criteria-eval\regen.ps1
#   & docs\experiments\c6-criteria-eval\regen.ps1 -Work .scratch\my-run
#
# Windows PowerShell 5.1 is enough; nothing here needs pwsh 7.
param(
  [string]$Snapshot = "",
  [string]$Work = ""
)
$ErrorActionPreference = 'Continue'
# This file lives at docs/experiments/c6-criteria-eval/, three levels below the repo root.
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$here = $PSScriptRoot
if (-not $Snapshot) { $Snapshot = Join-Path $repo "data\snapshot-20261026.db" }
if (-not $Work) { $Work = Join-Path $repo ".scratch\c6-lead" }
Set-Location $repo

if (-not (Test-Path $Work)) { New-Item -ItemType Directory -Force -Path $Work | Out-Null }
$w = (Resolve-Path $Work).Path
$snap = (Resolve-Path $Snapshot).Path
$cli = Join-Path $repo "src\cli.ts"

foreach ($n in @('shadow','apply','measure')) {
  Copy-Item $snap (Join-Path $w "$n.db") -Force
}

# The stub writes its URL and its decision log into $w, not into this directory: the
# evidence directory holds committed artefacts and a rehearsal must not add files to it.
$job = Start-Job -ScriptBlock {
  param($evidence, $out)
  Set-Location $evidence
  node (Join-Path $evidence "stub-judge.mjs") (Join-Path $evidence "review-set.json") (Join-Path $out "judge-url.txt") (Join-Path $out "stub-verdicts.json")
} -ArgumentList $here, $w
Start-Sleep -Seconds 2
$url = (Get-Content (Join-Path $w "judge-url.txt") -Raw).Trim()
Write-Output "work = $w"
Write-Output "judge = $url"

function Run-Criteria {
  param([string]$Db, [string]$Pairs, [string[]]$Extra)
  $argv = @("--experimental-strip-types", $cli, "criteria", "--db", $Db, "--pairs", $Pairs,
            "--judge-url", $url, "--judge-model", "stub-1") + $Extra
  node @argv | Out-Null
  return $LASTEXITCODE
}

Write-Output "=== shadow (expect 0, invalid_at untouched) ==="
$code = Run-Criteria -Db (Join-Path $w "shadow.db") -Pairs (Join-Path $here "review-set.json") -Extra @(
  "--mode", "shadow", "--report", (Join-Path $w "shadow-report.json"))
Write-Output "shadow exit=$code"

Write-Output "=== apply, no measurement (expect 5) ==="
Write-Output ("exit=" + (Run-Criteria -Db (Join-Path $w "apply.db") -Pairs (Join-Path $here "review-set.json") -Extra @("--mode", "apply")))

Write-Output "=== apply, 0.12 (expect 5) ==="
Write-Output ("exit=" + (Run-Criteria -Db (Join-Path $w "apply.db") -Pairs (Join-Path $here "review-set.json") -Extra @("--mode", "apply", "--false-supersede-rate", "0.12")))

Write-Output "=== apply, -0.5 (expect 5: not a rate) ==="
Write-Output ("exit=" + (Run-Criteria -Db (Join-Path $w "apply.db") -Pairs (Join-Path $here "review-set.json") -Extra @("--mode", "apply", "--false-supersede-rate=-0.5")))

Write-Output "=== apply, empty rate (expect 5: not a measurement) ==="
Write-Output ("exit=" + (Run-Criteria -Db (Join-Path $w "apply.db") -Pairs (Join-Path $here "review-set.json") -Extra @("--mode", "apply", "--false-supersede-rate=")))

Write-Output "=== apply, 0.00 (expect 0, writes) ==="
Write-Output ("exit=" + (Run-Criteria -Db (Join-Path $w "apply.db") -Pairs (Join-Path $here "review-set.json") -Extra @(
  "--mode", "apply", "--false-supersede-rate", "0.00", "--report", (Join-Path $w "apply-report.json"))))

Write-Output "=== apply again (expect 0, already invalid, nothing written) ==="
$again = @("--experimental-strip-types", $cli, "criteria", "--db", (Join-Path $w "apply.db"),
           "--pairs", (Join-Path $here "review-set.json"), "--judge-url", $url, "--judge-model", "stub-1",
           "--mode", "apply", "--false-supersede-rate", "0.00", "--report", (Join-Path $w "apply-report2.json"))
$againOut = node @again
Write-Output ("exit=" + $LASTEXITCODE)
$againOut | Select-String -Pattern 'already invalid before this run|records invalidated'

Write-Output "=== measurement run over the labelled set ==="
node (Join-Path $here "merge-labels.mjs") $w
Write-Output ("exit=" + (Run-Criteria -Db (Join-Path $w "measure.db") -Pairs (Join-Path $w "review-set-labelled.json") -Extra @(
  "--mode", "shadow", "--report", (Join-Path $w "measure-report.json"))))

Stop-Job $job; Remove-Job $job -Force

Write-Output ""
Write-Output "=== censuses ==="
node (Join-Path $here "census.mjs") (Join-Path $w "shadow.db")
node (Join-Path $here "census.mjs") (Join-Path $w "apply.db")

Write-Output ""
Write-Output "=== reports ==="
foreach ($f in @('shadow-report.json','apply-report.json','apply-report2.json','measure-report.json')) {
  $j = Get-Content (Join-Path $w $f) -Raw | ConvertFrom-Json
  Write-Output ("$f : mode=" + $j.mode + " supersede=" + $j.verdicts.supersede + " invalidated=" + $j.invalidated.Count + " auditRows=" + $j.auditRows + " gateAllowed=" + $j.gateAllowed)
}

Write-Output ""
Write-Output "=== false-supersede rate and inter-annotator agreement ==="
# Labels come from the committed evidence; the machine verdicts are the run just made.
node (Join-Path $here "report-to-verdicts.mjs") (Join-Path $w "measure-report.json") (Join-Path $w "verdicts.json")
node --experimental-strip-types (Join-Path $repo "src\cli.ts") criteria-eval `
  --set (Join-Path $w "review-set-labelled.json") `
  --verdicts (Join-Path $w "verdicts.json") `
  --report (Join-Path $w "evaluation.json")
node (Join-Path $here "agreement.mjs") --measure (Join-Path $w "measure-report.json") --out $w
