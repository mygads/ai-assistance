// npm run verify — applicable-matrix runner. Runs every implemented check/test
// script, collects exit codes (0 pass / 1 fail / 2 blocked), and emits the
// authoritative aggregate report. Exit: 0 = no failures; 1 = ≥1 failure;
// 2 = no failures but ≥1 blocked (never silently converted to pass).
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();

const MATRIX = [
  { script: "check", args: [], level: "L0" },
  { script: "test:unit", args: [], level: "L0" },
  { script: "test:integration", args: [], level: "L1" },
  { script: "test:replay", args: [], level: "L1" },
  { script: "test:ui", args: [], level: "L2" },
  { script: "test:native", args: [], level: "L3" },
  { script: "test:audio", args: [], level: "L4" },
  { script: "test:live", args: [], level: "L5" },
  { script: "test:soak", args: ["--minutes=1"], level: "L2" },
  { script: "test:capture", args: [], level: "L6" },
];

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const rows = [];
for (const entry of MATRIX) {
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    // .cmd shims cannot be execFile-spawned directly on Windows (EINVAL);
    // route through the shell as one literal-only command string. All args
    // are fixed literals from MATRIX — no caller input reaches the shell.
    execFile(`${npmCmd} run ${entry.script} -- ${entry.args.join(" ")}`, { cwd: rootDir, timeout: 900000, maxBuffer: 64 * 1024 * 1024, shell: true }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
  const evMatch = res.out.match(/evidence=([^\s]+\.json)/);
  let detail = { status: res.code === 0 ? "pass" : res.code === 2 ? "blocked" : "fail", cases: [], counts: {} };
  if (evMatch) {
    try {
      const ev = JSON.parse(readFileSync(path.join(rootDir, evMatch[1]), "utf8"));
      detail = { status: ev.status, cases: ev.cases ?? [], counts: ev.counts ?? {} };
    } catch { /* keep exit-code-derived status */ }
  }
  rows.push({ ...entry, exit_code: res.code, status: detail.status, duration_ms: Date.now() - t0, cases: detail.cases, counts: detail.counts });
  console.log(`verify: ${entry.script} -> exit ${res.code} (${detail.status})`);
}

const flatCases = [];
for (const r of rows) {
  if (r.cases.length === 0) {
    flatCases.push({ id: `${r.script}-no-cases`, level: r.level, status: "fail", replaced_boundaries: [], note: "script produced no cases" });
  } else {
    for (const c of r.cases) flatCases.push({ ...c, id: `${r.script}:${c.id}` });
  }
}

const fails = rows.filter((r) => r.status === "fail").length;
const blocked = rows.filter((r) => r.status === "blocked").length;
const status = fails > 0 ? "fail" : blocked > 0 ? "blocked" : "pass";

// verify itself also goes through the shared harness for a conforming record.
const { writeFileSync, mkdirSync } = await import("node:fs");
const stamp = startedUtc.replace(/[:.]/g, "-");
const report = {
  kind: "app_test",
  run_id: `verify-${stamp}`,
  level: "L0",
  command: "npm run verify",
  exit_code: status === "pass" ? 0 : status === "blocked" ? 2 : 1,
  status,
  matrix: rows.map((r) => ({ script: r.script, exit_code: r.exit_code, status: r.status, duration_ms: r.duration_ms, counts: r.counts })),
  cases: flatCases,
  counts: { pass: flatCases.filter((c) => c.status === "pass").length, fail: flatCases.filter((c) => c.status === "fail").length, blocked: flatCases.filter((c) => c.status === "blocked").length, total: flatCases.length },
  code_revision: "working-tree",
  environment: { os: `${process.platform}-${process.arch}`, versions: { node: process.version } },
  evidence_refs: [],
};
const evDir = path.join(rootDir, ".agent", "evidence");
mkdirSync(evDir, { recursive: true });
const evPath = path.join(evDir, `verify-${stamp}.json`);
report.evidence_refs.push(path.relative(rootDir, evPath));
writeFileSync(evPath, JSON.stringify(report, null, 2) + "\n");
const artDir = path.join(rootDir, "artifacts", `verify-${stamp}`);
mkdirSync(artDir, { recursive: true });
writeFileSync(path.join(artDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`verify: ${status} (scripts fail=${fails} blocked=${blocked}) evidence=${report.evidence_refs[0]}`);
process.exit(report.exit_code);
