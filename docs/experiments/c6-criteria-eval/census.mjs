
// Census a database copy: how many records carry invalid_at, and what the audit table
// holds by action. Takes the database path as argv[2].
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) {
  console.error("usage: node census.mjs <path-to-vectors.db>");
  process.exit(1);
}
const d = new DatabaseSync(path, { readOnly: true });
const one = (sql) => d.prepare(sql).get();
const cols = d.prepare("PRAGMA table_info(l1_records)").all().map((c) => c.name);

console.log("l1_records columns: " + cols.length);
console.log("  has invalid_at:    " + cols.includes("invalid_at"));
console.log("  has superseded_by: " + cols.includes("superseded_by"));
console.log("rows: " + one("SELECT COUNT(*) n FROM l1_records").n);
if (cols.includes("invalid_at")) {
  console.log("invalid_at NOT NULL:    " + one("SELECT COUNT(*) n FROM l1_records WHERE invalid_at IS NOT NULL").n);
  console.log("superseded_by NOT NULL: " + one("SELECT COUNT(*) n FROM l1_records WHERE superseded_by IS NOT NULL").n);
}
const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
if (tables.includes("forgetting_audit")) {
  console.log("--- forgetting_audit ---");
  for (const r of d.prepare("SELECT action, COUNT(*) n FROM forgetting_audit GROUP BY action ORDER BY action").all()) {
    console.log("  action=" + r.action + " n=" + r.n);
  }
} else {
  console.log("forgetting_audit: (absent — nothing has run against this database)");
}
d.close();
