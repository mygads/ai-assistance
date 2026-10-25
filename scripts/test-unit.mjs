// npm run test:unit — portable TypeScript domain unit tests (L0).
// Uses the Node built-in test runner with native type stripping (no build step).
// Exit 0 = pass with non-empty tests; 1 = fail; empty suite is never pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `unit-${new Date().toISOString().replace(/[:.]/g, "-")}`;

function cargoEnv() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const bin = path.join(home, ".cargo", "bin");
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PATH: `${bin}${sep}${process.env.PATH ?? ""}` };
}

// Part 1: TypeScript domain tests (node:test, type-stripped, no build step).
const ts = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "src/domain/transcript.test.ts", "src/domain/session.test.ts", "src/domain/core.test.ts", "src/domain/reader.test.ts"], {
  cwd: rootDir,
  encoding: "utf8",
  timeout: 180000,
});

const tap = (ts.stdout ?? "") + (ts.stderr ?? "");
const tsPass = Number(tap.match(/# pass (\d+)/)?.[1] ?? 0);
const tsFail = Number(tap.match(/# fail (\d+)/)?.[1] ?? 0);

// Part 2: portable Rust unit tests (real compile via MSVC linker on Windows).
let rsPass = 0;
let rsFail = 0;
let rsStatus = "not_run";
if (existsSync(path.join(rootDir, "src-tauri", "Cargo.toml"))) {
  const rs = spawnSync("cargo test -p conversation-assistant --lib", {
    cwd: path.join(rootDir, "src-tauri"),
    encoding: "utf8",
    timeout: 600000,
    shell: true,
    env: cargoEnv(),
  });
  const out = (rs.stdout ?? "") + (rs.stderr ?? "");
  const m = out.match(/test result: ok\. (\d+) passed; (\d+) failed/);
  rsStatus = rs.status === 0 && m ? "pass" : "fail";
  if (m) {
    rsPass = Number(m[1]);
    rsFail = Number(m[2]);
  } else if (rs.status !== 0) {
    rsFail = 1;
    console.error(out.slice(-2000));
  }
}

const passCount = tsPass + rsPass;
const failCount = tsFail + rsFail;
const tsOk = (ts.status ?? 1) === 0 && tsPass > 0 && tsFail === 0;
const rsOk = rsStatus === "pass" && rsPass > 0 && rsFail === 0;

const report = {
  kind: "app_test",
  run_id: runId,
  level: "L0",
  command: "npm run test:unit",
  exit_code: 0,
  status: tsOk && rsOk ? "pass" : "fail",
  cases: [
    { id: "L0-domain-ts", level: "L0", status: tsOk ? "pass" : "fail", replaced_boundaries: [] },
    { id: "L0-domain-rs", level: "L0", status: rsOk ? "pass" : (rsStatus === "not_run" ? "blocked" : "fail"), replaced_boundaries: [] },
  ],
  counts: { pass: passCount, fail: failCount, ts: { pass: tsPass, fail: tsFail }, rs: { pass: rsPass, fail: rsFail, status: rsStatus } },
  code_revision: "working-tree",
  environment: { os: `${process.platform}-${process.arch}`, versions: { node: process.version } },
  evidence_refs: [],
};

if (passCount === 0) {
  report.status = "fail";
  console.error("test:unit FAIL: empty suite is never pass");
}

const outDir = path.join(rootDir, ".agent", "evidence");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${runId}.json`);
report.evidence_refs.push(path.relative(rootDir, outPath));
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
report.exit_code = report.status === "pass" ? 0 : 1;
console.log(`test:unit ts=${tsPass}/${tsFail} rs=${rsPass}/${rsFail} status=${report.status} evidence=${report.evidence_refs[0]}`);
process.exit(report.status === "pass" ? 0 : 1);
