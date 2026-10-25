// npm run report — evidence index + human-readable verification summary.
// Scans .agent/evidence/*.json and artifacts/*/report.json, prints a concise
// matrix, and writes artifacts/report-<stamp>.md + evidence index JSON.
// Exit 0 when the report itself is produced (blocked capabilities retained).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [{ id: "report-generated", level: "L0", status: "pass", replaced_boundaries: [] }];

const evDir = path.join(rootDir, ".agent", "evidence");
const runs = [];
if (existsSync(evDir)) {
  for (const f of readdirSync(evDir).filter((f) => f.endsWith(".json") && !f.startsWith("index-"))) {
    try {
      const r = JSON.parse(readFileSync(path.join(evDir, f), "utf8"));
      if (!r.command) continue; // doctor/state snapshots are not test runs
      runs.push({ file: f, run_id: r.run_id ?? f, command: r.command ?? "?", level: r.level ?? "?", status: r.status, exit_code: r.exit_code, counts: r.counts ?? {} });
    } catch { /* skip unreadable */ }
  }
}
runs.sort((a, b) => (a.run_id < b.run_id ? -1 : 1));

const byCommand = new Map();
for (const r of runs) {
  if (!byCommand.has(r.command) || byCommand.get(r.command).run_id < r.run_id) byCommand.set(r.command, r);
}
const latest = [...byCommand.values()].sort((a, b) => (a.command < b.command ? -1 : 1));

const lines = [
  "# Verification report",
  "",
  `Generated: ${startedUtc} (working tree; see dirty-tree notes in run records)`,
  "",
  "| Command | Level | Status | Exit | Counts |",
  "|---|---|---|---|---|",
  ...latest.map((r) => `| \`${r.command}\` | ${r.level} | ${r.status} | ${r.exit_code ?? "?"} | ${JSON.stringify(r.counts)} |`),
  "",
  "Blocked capabilities are prerequisites, not passes. Live provider gates need keys + opt-in (owner: user).",
  "",
];
const stamp = startedUtc.replace(/[:.]/g, "-");
const artDir = path.join(rootDir, "artifacts", `report-${stamp}`);
mkdirSync(artDir, { recursive: true });
writeFileSync(path.join(artDir, "REPORT.md"), lines.join("\n"));
writeFileSync(path.join(evDir, `index-${stamp}.json`), JSON.stringify({ kind: "evidence_index", generated_utc: startedUtc, runs }, null, 2) + "\n");
console.log(lines.join("\n"));

finish({ script: "report", level: "L0", cases, startedUtc });
