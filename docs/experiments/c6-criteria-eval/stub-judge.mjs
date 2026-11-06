
// Offline OpenAI-compatible stub judge.
//
// The verdict comes from the pair's position in a pairId-sorted list, not from the request
// order. Order-based rules look deterministic but are not: every CLI run starts a fresh
// process with a fresh counter, so two runs over the same review set judged different
// subsets and their reports were not comparable. Sorting by the id first makes the same
// pair get the same verdict forever.
//
// The prompt does not carry the pairId (it carries "record_id: <oldId>" and
// "record_id: <newId>"), so the pair is identified by the old record's id.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const set = JSON.parse(readFileSync(process.argv[2], "utf8"));
const decided = new Map();

const stableIndex = new Map(
  [...set.pairs].map((p) => p.pairId).sort().map((id, i) => [id, i]),
);

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const pair =
      set.pairs.find((p) => body.includes("record_id: " + p.oldId) && body.includes("record_id: " + p.newId)) ??
      set.pairs.find((p) => body.includes("record_id: " + p.oldId));
    const idx = pair ? stableIndex.get(pair.pairId) : undefined;
    // Roughly one in three pairs is called supersede. A deliberately mediocre judge: the
    // exercise is to measure it, not to make it look good.
    const verdict = idx !== undefined && idx % 3 === 0 ? "supersede" : "keep-both";
    if (pair) decided.set(pair.pairId, verdict);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ verdict, confidence: 0.8, reason: "stub" }) } }],
      }),
    );
  });
});
server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";
  writeFileSync(process.argv[3], url, "utf8");
  console.log("stub listening " + url + " over " + set.pairs.length + " pairs");
});
process.on("SIGTERM", () => {
  writeFileSync(process.argv[4], JSON.stringify(Object.fromEntries(decided), null, 2), "utf8");
  process.exit(0);
});
