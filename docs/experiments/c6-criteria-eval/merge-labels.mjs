
// Merge the first annotator's labels into the review set, so criteria can read
// humanVerdict off each pair.
//
// Reads from the tracked evidence directory (this file's own directory) and writes to an
// output directory given as argv[2] — defaulting to the evidence directory would mean a
// re-run quietly rewrites the committed artefacts it is supposed to be checking.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = import.meta.dirname;
const out = process.argv[2] ?? src;
const set = JSON.parse(readFileSync(join(src, "review-set.json"), "utf8"));
const lab = JSON.parse(readFileSync(join(src, "human-labels.json"), "utf8"));
const byId = new Map(lab.labels.map((l) => [l.pairId, l]));

let n = 0;
for (const p of set.pairs) {
  const l = byId.get(p.pairId);
  if (!l) throw new Error("no label for " + p.pairId);
  p.humanVerdict = l.verdict;
  p.humanWhy = l.why;
  // Per-pair provenance, so a correction to one pair carries its own attribution.
  p.labelledBy = l.labelledBy;
  p.labelledAt = l.labelledAt;
  n++;
}
set.labelledBy = lab.labelledBy;
set.labelledAt = lab.labelledAt;
set.labelMethod = lab.method;
writeFileSync(join(out, "review-set-labelled.json"), JSON.stringify(set, null, 2), "utf8");
console.log("merged " + n + " labels -> " + join(out, "review-set-labelled.json"));
