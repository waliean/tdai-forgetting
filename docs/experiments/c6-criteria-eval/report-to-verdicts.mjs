
// Turn a criteria run report into the --verdicts file criteria-eval reads.
//
// Reads the run report and writes the verdicts file, both named by argv:
//   node report-to-verdicts.mjs <run-report.json> <verdicts.json>
import { readFileSync, writeFileSync } from "node:fs";

const [reportPath, outPath] = process.argv.slice(2);
if (!reportPath || !outPath) {
  console.error("usage: node report-to-verdicts.mjs <run-report.json> <verdicts.json>");
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const verdicts = {};
for (const o of report.outcomes) verdicts[o.pairId] = o.verdict;
writeFileSync(outPath, JSON.stringify(verdicts, null, 2), "utf8");
const tally = {};
for (const v of Object.values(verdicts)) tally[String(v)] = (tally[String(v)] ?? 0) + 1;
console.log("wrote " + Object.keys(verdicts).length + " verdicts: " + JSON.stringify(tally));
