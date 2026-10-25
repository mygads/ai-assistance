// Shared verification harness for all test:* scripts.
// Exit discipline (docs/TESTING.md): 0 = pass, 1 = fail, 2 = blocked.
// A pass requires a non-empty case list; empty suites are never pass.
// Writes: .agent/evidence/<run>-<stamp>.json (concise index) and
// artifacts/<run-id>/report.json (full report, secrets must never enter).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function root() {
  return rootDir;
}

export function cargoEnv() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const bin = path.join(home, ".cargo", "bin");
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PATH: `${bin}${sep}${process.env.PATH ?? ""}` };
}

/**
 * @param {object} opts
 * @param {string} opts.script e.g. "test:replay"
 * @param {string} opts.level L0..L6
 * @param {Array} opts.cases [{id, level, status, replaced_boundaries?, note?}]
 * @param {object} [opts.counts] {pass, fail}
 * @param {string} [opts.codeRevision] default "working-tree"
 * @param {object} [opts.extra] merged into the report
 * Never returns: writes evidence and exits the process.
 */
export function finish(opts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${opts.script.replace(/[^a-z0-9]+/gi, "-")}-${stamp}`;
  const cases = opts.cases ?? [];
  const pass = cases.filter((c) => c.status === "pass").length;
  const fail = cases.filter((c) => c.status === "fail").length;
  const blocked = cases.filter((c) => c.status === "blocked").length;
  const status =
    cases.length === 0 || fail > 0 ? "fail" : blocked > 0 ? "blocked" : "pass";
  const report = {
    kind: "app_test",
    run_id: runId,
    level: opts.level,
    command: `npm run ${opts.script}`,
    exit_code: status === "pass" ? 0 : status === "blocked" ? 2 : 1,
    status,
    started_utc: opts.startedUtc ?? new Date().toISOString(),
    cases,
    counts: opts.counts ?? { pass, fail, blocked, total: cases.length },
    code_revision: opts.codeRevision ?? "working-tree",
    environment: {
      os: `${process.platform}-${process.arch}`,
      versions: { node: process.version },
    },
    evidence_refs: [],
    ...(opts.extra ?? {}),
  };
  const evDir = path.join(rootDir, ".agent", "evidence");
  mkdirSync(evDir, { recursive: true });
  const evPath = path.join(evDir, `${runId}.json`);
  report.evidence_refs.push(path.relative(rootDir, evPath));
  writeFileSync(evPath, JSON.stringify(report, null, 2) + "\n");
  const artDir = path.join(rootDir, "artifacts", runId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(path.join(artDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    `${opts.script}: ${status} (pass=${pass} fail=${fail} blocked=${blocked}) evidence=${report.evidence_refs[0]}`
  );
  process.exit(report.exit_code);
}
