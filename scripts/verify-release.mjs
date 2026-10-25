// npm run verify:release — strict release gate. Required critical gates must ALL
// pass; any required blocked/not_run/fail means non-pass (exit 1). This is the
// T26 rehearsal entry point; today it honestly reports which critical gates
// are still blocked (native binary flow, packaging, installer, live).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L6", status, replaced_boundaries, ...(note ? { note } : {}) });
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  // .cmd shims cannot be execFile-spawned directly on Windows (EINVAL);
  // route them through the shell as one literal-only command string.
  if (cmd.endsWith(".cmd")) {
    execFile(`${cmd} ${args.join(" ")}`, { timeout: 900000, maxBuffer: 64 * 1024 * 1024, shell: true, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
    return;
  }
  execFile(cmd, args, { timeout: 900000, maxBuffer: 64 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error?.code ?? 0, out: `${stdout ?? ""}${stderr ?? ""}` });
  });
});
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const latestEvidence = (prefix) => {
  const dir = path.join(rootDir, ".agent", "evidence");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
  if (files.length === 0) return null;
  try { return JSON.parse(readFileSync(path.join(dir, files[files.length - 1]), "utf8")); } catch { return null; }
};

// 1. Static + unit + L1 gates must pass.
for (const script of ["check", "test:unit", "test:integration", "test:replay"]) {
  const r = await run(npmCmd, ["run", script], { cwd: rootDir });
  const ok = r.ok;
  push(`release-${script}`, ok ? "pass" : "fail", [], ok ? "exit 0" : `exit ${r.code}: ${r.out.slice(-300)}`);
}

// 2. Production hook-absence: test-harness feature must NOT be in the release
// build path; fixture/test-only identifiers must not appear in release artefacts.
const srcFiles = [];
{
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!["target", "node_modules", "dist"].includes(f.name)) walk(p); }
      else if (/\.(rs|ts|tsx|mjs|json)$/.test(f.name)) srcFiles.push(p);
    }
  };
  walk(path.join(rootDir, "src-tauri", "src"));
}
const harnessRefs = srcFiles.filter((f) => /cfg\s*\(\s*feature\s*=\s*"test-harness"|test_harness/.test(readFileSync(f, "utf8")));
const releaseHasHarness = /--features[= ][^ ]*test-harness/.test(readFileSync(path.join(rootDir, "package.json"), "utf8"));
push("release-hooks-absent-source", harnessRefs.length === 0 && !releaseHasHarness ? "pass" : "fail", [],
  harnessRefs.length === 0 ? "no test-harness-gated code on the release path" : `test-harness refs: ${harnessRefs.join(", ")}`);

// 3. Bundled release artefacts must exist (npm run package evidence).
const pkg = latestEvidence("package-");
const hasBundle = pkg?.status === "pass";
push("release-bundle-present", hasBundle ? "pass" : "blocked", [],
  hasBundle ? (pkg.extra?.bundle_artifacts ?? []).map((a) => a.path).join(", ") : "no passing package run yet (T22).");

// 4. Installer smoke (npm run test:installer evidence).
const inst = latestEvidence("test-installer-");
push("release-installer-smoke", inst?.status === "pass" ? "pass" : "blocked", [],
  inst ? `latest test:installer: ${inst.status}` : "test:installer has never run (T23).");

// 5. Independent review (T25) is a human/subagent gate; record its absence.
push("release-independent-review", "blocked", [],
  "T25 independent review not yet performed; verify:release cannot pass without it.");

const fails = cases.filter((c) => c.status === "fail").length;
const blocked = cases.filter((c) => c.status === "blocked").length;
console.log(`verify:release: strict gate ${fails === 0 && blocked === 0 ? "PASS" : "NON-PASS"} (fail=${fails} blocked=${blocked})`);
finish({ script: "verify:release", level: "L6", cases, startedUtc });
