// npm run report — strict evidence aggregation + E2E corpus coverage (T16).
// Reads the latest evidence per command, validates each file against
// run-report.schema.json, and maps every tests/scenarios.json case (C01..C32)
// to executed passing evidence at its primary level.
//
// Strictness: a scenario whose primary level is L0/L1/L2 (runnable here)
// without passing primary-level evidence is a FAIL, not a silent gap.
// L3+ scenarios without evidence stay blocked (prerequisite, never pass).
// Exit 0 = every scenario covered-pass; 1 = fail; 2 = blocked-only gaps.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();

// Scenario -> executed case-id suffixes that prove it, plus the command
// evidence file (script-local id) they come from. Level match is exact: L1
// domain proof does not satisfy an L3 scenario (same rule as native-vs-
// browser in docs/TESTING.md).
const COVERAGE = {
  C01: ["slice-send-fencing"],
  C02: [],
  C03: ["real-ipc-send-answer", "send-dedup"],
  C04: ["normalize-soniox", "rust-storage"],
  C05: ["reconnect-offset", "stt-protocol-replay"],
  C06: ["real-ipc-send-answer"],
  C07: ["stt-protocol-replay"],
  C08: [],
  C09: ["reader-version-rebase"],
  C10: ["slice-reader-follows-self"],
  C11: ["domain-ts"],
  C12: ["reader-skip-repeat-offscript"],
  C13: ["context-retrieval"],
  C14: ["context-retrieval"],
  C15: [],
  C16: ["memory-learning"],
  C17: ["memory-learning"],
  C18: ["compaction"],
  C19: ["dashboard-renders", "overlay-send-journey", "token-seek-band"],
  C20: ["focus-preserved-after-stream"],
  C21: [],
  C22: ["restart-reopens-clean"],
  C23: ["real-ipc-send-answer"],
  C24: [],
  C25: [],
  C26: [],
  C27: [],
  C28: [],
  C29: [],
  C30: ["production isolation (A20 L0)"],
  C31: [],
  C32: [],
};

const evDir = path.join(rootDir, ".agent", "evidence");
const runs = [];
if (existsSync(evDir)) {
  for (const f of readdirSync(evDir).filter((f) => f.endsWith(".json") && !f.startsWith("index-"))) {
    try {
      const r = JSON.parse(readFileSync(path.join(evDir, f), "utf8"));
      if (!r.command) continue;
      runs.push({ file: f, ...r });
    } catch { /* skip unreadable */ }
  }
}
const byCommand = new Map();
for (const r of runs) {
  if (!byCommand.has(r.command) || byCommand.get(r.command).run_id < r.run_id) byCommand.set(r.command, r);
}
const latest = [...byCommand.values()];

// Validate the aggregated inputs: a malformed evidence file is a failure of
// the aggregation itself, never silently dropped.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const reportSchema = JSON.parse(readFileSync(path.join(rootDir, ".agent", "schemas", "run-report.schema.json"), "utf8"));
const validateReport = ajv.compile(reportSchema);
const schemaBad = latest.filter((r) => !validateReport(r)).map((r) => r.file);

const scenarios = JSON.parse(readFileSync(path.join(rootDir, "tests", "scenarios.json"), "utf8")).cases;

// Executed passing case ids, by level, from latest evidence only.
const passingByLevel = new Map();
for (const r of latest) {
  for (const c of r.cases ?? []) {
    if (c.status !== "pass") continue;
    if (!passingByLevel.has(c.level)) passingByLevel.set(c.level, new Set());
    passingByLevel.get(c.level).add(c.id);
  }
}

const rows = [];
for (const s of scenarios) {
  const patterns = COVERAGE[s.id] ?? [];
  const pool = passingByLevel.get(s.primary_level) ?? new Set();
  const hits = patterns.filter((p) => [...pool].some((id) => id === p || id.endsWith(`:${p}`) || id.includes(p)));
  const lowerHits = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"]
    .filter((l) => l !== s.primary_level)
    .flatMap((l) => [...(passingByLevel.get(l) ?? [])].filter((id) => patterns.some((p) => id.includes(p))));
  let status, note;
  if (hits.length > 0) {
    status = "pass";
    note = `covered at ${s.primary_level} by ${hits.join(", ")}`;
  } else if (["L0", "L1", "L2"].includes(s.primary_level)) {
    status = "fail";
    note = `STRICT: ${s.primary_level} scenario has no passing primary-level evidence` +
      (lowerHits.length > 0 ? ` (lower-level only: ${[...new Set(lowerHits)].join(", ")})` : " (no evidence at any level)");
  } else {
    status = "blocked";
    note = `needs ${s.primary_level} run` +
      (lowerHits.length > 0 ? ` (lower-level slice passes: ${[...new Set(lowerHits)].join(", ")})` : "");
  }
  rows.push({ id: `corpus:${s.id}`, level: s.primary_level, status, replaced_boundaries: [], note: `${s.title} — ${note}` });
}
for (const f of schemaBad) {
  rows.push({ id: `report:schema-invalid:${f}`, level: "L0", status: "fail", replaced_boundaries: [], note: "latest evidence file fails run-report.schema.json" });
}

const lines = [
  "# Verification report (strict aggregation)",
  "",
  `Generated: ${startedUtc} (working tree)`,
  "",
  "## Latest evidence per command",
  "",
  "| Command | Level | Status | Exit | Counts |",
  "|---|---|---|---|---|",
  ...latest.map((r) => `| \`${r.command}\` | ${r.level} | ${r.status} | ${r.exit_code ?? "?"} | ${JSON.stringify(r.counts ?? {})} |`),
  ...(schemaBad.length > 0 ? ["", `Schema-invalid evidence files: ${schemaBad.join(", ")}`] : []),
  "",
  "## Scenario corpus coverage (tests/scenarios.json C01..C32)",
  "",
  "| Scenario | Level | Status | Evidence |",
  "|---|---|---|---|",
  ...rows.filter((r) => r.id.startsWith("corpus:")).map((r) => `| \`${r.id.slice(7)}\` | ${r.level} | ${r.status} | ${r.note} |`),
  "",
  "Blocked capabilities are prerequisites, not passes. Live provider gates need keys + opt-in (owner: user).",
  "",
];
const stamp = startedUtc.replace(/[:.]/g, "-");
const artDir = path.join(rootDir, "artifacts", `report-${stamp}`);
mkdirSync(artDir, { recursive: true });
writeFileSync(path.join(artDir, "REPORT.md"), lines.join("\n"));
writeFileSync(
  path.join(evDir, `index-${stamp}.json`),
  JSON.stringify({ kind: "evidence_index", generated_utc: startedUtc, schema_invalid: schemaBad, runs: latest.map((r) => r.file), corpus: rows }, null, 2) + "\n",
);
console.log(lines.join("\n"));

finish({ script: "report", level: "L0", cases: rows, startedUtc });
