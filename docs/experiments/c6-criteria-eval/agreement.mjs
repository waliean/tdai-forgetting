
// Inter-annotator agreement and the three false-supersede rates.
//
// Exists because one annotator is not a gold standard. The number nobody wants is the
// first one printed: how often two independent judgements of "is the old record
// superseded" disagree.
//
//   node agreement.mjs [--measure <run-report.json>] [--out <dir>]
//
// Labels always come from this file's own directory (the committed evidence). The machine
// verdicts can be overridden with --measure, because a fresh run's report is the thing you
// are checking — defaulting to the committed copy would mean the check agrees with itself.
// Nothing is written unless --out is given, for the same reason.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = import.meta.dirname;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const measurePath = flag("--measure") ?? join(src, "measure-report.json");
const outDir = flag("--out");

const a1 = JSON.parse(readFileSync(join(src, "human-labels.json"), "utf8"));
const a2 = JSON.parse(readFileSync(join(src, "blind-labels.json"), "utf8"));
const judgeReport = JSON.parse(readFileSync(measurePath, "utf8"));
const set = JSON.parse(readFileSync(join(src, "review-set.json"), "utf8"));

const L1 = new Map(a1.labels.map((l) => [l.pairId, l.verdict]));
const L2 = new Map(a2.labels.map((l) => [l.pairId, l.verdict]));
const J = new Map(judgeReport.outcomes.map((o) => [o.pairId, o.verdict]));
const pairIds = set.pairs.map((p) => p.pairId);

const tally = (m) => {
  const t = { supersede: 0, "keep-both": 0, unrelated: 0 };
  for (const id of pairIds) { const v = m.get(id); if (v) t[v] = (t[v] ?? 0) + 1; }
  return t;
};

let agree = 0;
const confusion = {};
for (const id of pairIds) {
  const v1 = L1.get(id), v2 = L2.get(id);
  confusion[v1 + "|" + v2] = (confusion[v1 + "|" + v2] ?? 0) + 1;
  if (v1 === v2) agree++;
}

const n = pairIds.length;
const po = agree / n;
const cats = ["supersede", "keep-both", "unrelated"];
const t1 = tally(L1), t2 = tally(L2);
const pe = cats.reduce((s, c) => s + (t1[c] / n) * (t2[c] / n), 0);
const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);

function rate(labels) {
  let ts = 0, fs = 0, ms = 0;
  for (const id of pairIds) {
    const human = labels.get(id);
    const machine = J.get(id) ?? null;
    if (human === undefined) continue;
    if (machine === "supersede" && human === "supersede") ts++;
    if (machine === "supersede" && human !== "supersede") fs++;
    if (machine !== "supersede" && human === "supersede") ms++;
  }
  return { trueSupersede: ts, falseSupersede: fs, missedSupersede: ms, rate: ts + fs > 0 ? fs / (ts + fs) : null };
}

const consensus = new Map();
let agreePairs = 0;
for (const id of pairIds) {
  if (L1.get(id) === L2.get(id)) { consensus.set(id, L1.get(id)); agreePairs++; }
}

const r1 = rate(L1), r2 = rate(L2), rc = rate(consensus);
const fmt = (r) => (r.rate === null ? "n/a" : (r.rate * 100).toFixed(1) + "%");
const supersedeCalls = [...J.values()].filter((v) => v === "supersede").length;

console.log("machine verdicts from:   " + measurePath);
console.log("A1 (implementer):        " + JSON.stringify(t1));
console.log("A2 (blind, independent): " + JSON.stringify(t2));
console.log("judge supersede calls:   " + supersedeCalls);
console.log("");
console.log("inter-annotator agreement: " + agree + "/" + n + " = " + (po * 100).toFixed(1) + "%, kappa = " + kappa.toFixed(3));
console.log("confusion (A1|A2): " + JSON.stringify(confusion));
console.log("");
console.log("false-supersede vs A1:                   " + r1.falseSupersede + "/" + (r1.trueSupersede + r1.falseSupersede) + " = " + fmt(r1));
console.log("false-supersede vs A2:                   " + r2.falseSupersede + "/" + (r2.trueSupersede + r2.falseSupersede) + " = " + fmt(r2));
console.log("false-supersede vs consensus (" + agreePairs + " pairs):  " + rc.falseSupersede + "/" + (rc.trueSupersede + rc.falseSupersede) + " = " + fmt(rc));

if (outDir) {
  writeFileSync(join(outDir, "agreement.json"), JSON.stringify({
    schema: "agreement/1",
    pairs: n,
    measureReport: measurePath,
    annotators: {
      a1: { who: a1.labelledBy, at: a1.labelledAt, counts: t1 },
      a2: { who: a2.labelledBy, at: a2.labelledAt, counts: t2 },
    },
    interAnnotator: { agree, agreement: po, kappa, confusion },
    judge: { model: judgeReport.model, supersedeCalls },
    falseSupersede: { vsA1: r1, vsA2: r2, vsConsensus: rc, consensusPairs: agreePairs },
  }, null, 2), "utf8");
  console.log("");
  console.log("wrote " + join(outDir, "agreement.json"));
}
