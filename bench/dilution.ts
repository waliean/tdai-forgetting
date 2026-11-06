/**
 * Shingle dilution: how bad is it, and which fix actually separates duplicates.
 *
 * The known defect: `shingles(content, 4)` builds a set whose size grows with the
 * text, so two long records saying the same thing share a fixed prefix while the
 * union keeps growing. Jaccard therefore falls as length rises, and a single 0.6 bar
 * cannot be right for both a 70-character note and a 1200-character document.
 *
 * This script measures three things on the D2 long-text corpus:
 *
 *   1. the dilution curve — one prefix held at 100 characters, the other document
 *      grown from 100 to 1200, reporting what Jaccard does;
 *   2. two candidate fixes, scored on the same corpus with two metrics that matter:
 *      recall of the 60 true duplicate pairs, and the share of the 7,080 unrelated
 *      pairs that get merged anyway;
 *   3. the shipped behaviour as a baseline, so "better" has a reference point.
 *
 * It is a measurement script, not a library: run it, read the tables, and the design
 * doc records the conclusion. The winning approach is what gets implemented.
 *
 *   node bench/dilution.ts
 */

import { longtextCorpus } from "./corpus-long.ts";
import { DEFAULT_CLUSTER_OPTIONS, jaccard, shingles } from "../src/redundancy.ts";

/** One document cut into sentence-ish blocks. Used by the block-coverage approach. */
function splitBlocks(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/)
    .map((block) => block.trim())
    .filter((block) => block.length >= 12);
}

/**
 * Share of A's blocks that find a near-identical block in B.
 *
 * This is the property a long duplicate actually has: almost every sentence of the
 * short statement reappears in the long one. Jaccard asks "how much of the union do
 * they share", which punishes B for being longer; coverage asks "is each part of A
 * present in B", which is the question a duplicate detector means to ask.
 */
function blockCoverage(a: string, b: string, threshold: number): number {
  const blocksA = splitBlocks(a);
  const blocksB = splitBlocks(b);
  if (blocksA.length === 0 || blocksB.length === 0) return 0;
  const setsB = blocksB.map((block) => shingles(block, 3));
  let matched = 0;
  for (const block of blocksA) {
    const setA = shingles(block, 3);
    let best = 0;
    for (const setB of setsB) {
      const similarity = jaccard(setA, setB);
      if (similarity > best) best = similarity;
      if (best >= threshold) break;
    }
    if (best >= threshold) matched++;
  }
  return matched / blocksA.length;
}

/** Length-bucketed Jaccard threshold: the cheap fix the README hints at. */
function tieredThreshold(length: number): number {
  if (length < 200) return 0.6;
  if (length < 600) return 0.45;
  return 0.35;
}

function curve(): void {
  const records = longtextCorpus({ facts: 1 });
  const full = records.find((r) => r.record_id === "long_0_full")!.content;
  const prefix = full.slice(0, 100);

  console.log("## Dilution curve: prefix fixed at 100 chars, comparison document grown");
  console.log("");
  console.log("| comparison length | Jaccard(prefix, doc) |");
  console.log("|---|---|");
  for (const length of [100, 200, 300, 400, 600, 800, 1000, 1200]) {
    const doc = full.slice(0, length);
    console.log(`| ${length} | ${jaccard(shingles(prefix), shingles(doc)).toFixed(3)} |`);
  }

  // The shape the prompt names: two 1000-character records, same fact, each with 200
  // characters the other lacks. Jaccard sees 800/1200 and misses a 0.6 bar.
  const left = full.slice(0, 400) + full.slice(400, 600);
  const right = full.slice(0, 400) + full.slice(600, 800);
  console.log("");
  console.log("## Same fact, both 600 chars, 200 chars differ");
  console.log("");
  console.log(`Jaccard = ${jaccard(shingles(left), shingles(right)).toFixed(3)} (a 0.6 bar calls these different)`);
}

interface Tally {
  truePairs: number;
  trueCaught: number;
  falsePairs: number;
  falseMerged: number;
}

function score(name: string, decide: (a: string, b: string) => boolean, records: ReturnType<typeof longtextCorpus>): void {
  const briefs = records.filter((r) => r.record_id.endsWith("_brief"));
  const fulls = records.filter((r) => r.record_id.endsWith("_full"));
  const tally: Tally = { truePairs: briefs.length, trueCaught: 0, falsePairs: 0, falseMerged: 0 };

  for (let i = 0; i < briefs.length; i++) {
    // The pair the detector is supposed to find.
    if (decide(briefs[i].content, fulls[i].content)) tally.trueCaught++;
  }

  const all = [...briefs, ...fulls];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      // Skip the true pair: same fact index, one brief and one full.
      const a = all[i].record_id;
      const b = all[j].record_id;
      if (a.replace(/_(brief|full)$/, "") === b.replace(/_(brief|full)$/, "")) continue;
      tally.falsePairs++;
      if (decide(all[i].content, all[j].content)) tally.falseMerged++;
    }
  }

  const recall = tally.trueCaught / tally.truePairs;
  const falseMerge = tally.falseMerged / tally.falsePairs;
  console.log(
    `| ${name} | ${tally.trueCaught}/${tally.truePairs} = ${recall.toFixed(3)} | ` +
      `${tally.falseMerged}/${tally.falsePairs} = ${falseMerge.toFixed(4)} | ` +
      `${(recall - falseMerge).toFixed(3)} |`,
  );
}

function compare(): void {
  const records = longtextCorpus();

  console.log("");
  console.log("## Two candidate fixes on the same corpus (60 true pairs, 7,080 unrelated)");
  console.log("");
  console.log("| approach | true-duplicate recall | false-merge rate | recall - falseMerge |");
  console.log("|---|---|---|---|");

  // Baseline: what ships today, including the length prefilter.
  const lengthRatioOk = (a: string, b: string): boolean => {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return ratio >= DEFAULT_CLUSTER_OPTIONS.threshold;
  };
  score(
    "shipped (Jaccard >= 0.6 + length prefilter)",
    (a, b) => lengthRatioOk(a, b) && jaccard(shingles(a), shingles(b)) >= DEFAULT_CLUSTER_OPTIONS.threshold,
    records,
  );

  // Tiered: drop the prefilter, pick the bar from the shorter document's length.
  score(
    "tiered (0.6 / 0.45 / 0.35 by length)",
    (a, b) => jaccard(shingles(a), shingles(b)) >= tieredThreshold(Math.min(a.length, b.length)),
    records,
  );

  // Block coverage, over the same 60 pairs.
  score("block coverage >= 0.8", (a, b) => blockCoverage(a, b, 0.8) >= 0.8, records);
}

curve();
compare();
