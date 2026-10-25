// npm run package — release executable/installer via Tauri bundler.
// Fails (exit 1) when no real release can be produced; never emits a fake
// artifact. Hashes (sha256) every produced file into the evidence record.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cargoEnv, finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L6", status, replaced_boundaries, ...(note ? { note } : {}) });
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  // .cmd shims (tauri on Windows) cannot be execFile-spawned directly
  // (EINVAL); run them through the shell as one literal-only command string.
  // All call sites pass fixed literals — no caller input reaches the shell.
  if (cmd.endsWith(".cmd")) {
    execFile(`${cmd} ${args.join(" ")}`, { timeout: 600000, maxBuffer: 256 * 1024 * 1024, shell: true, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, out: (((stdout ?? "") + (stderr ?? "")).slice(-4000)) });
    });
    return;
  }
  execFile(cmd, args, { timeout: 600000, maxBuffer: 256 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error?.code ?? 0, out: (((stdout ?? "") + (stderr ?? "")).slice(-4000)) });
  });
});

const tauriBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
if (!existsSync(tauriBin)) {
  push("L6-tauri-cli", "blocked", [], "@tauri-apps/cli not installed.");
  finish({ script: "package", level: "L6", cases, startedUtc });
}

const bundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle");
let built = await run(tauriBin, ["build"], { cwd: path.join(rootDir, "src-tauri"), env: cargoEnv() });
if (!built.ok) {
  // One retry: network/toolchain flakes (e.g. WiX/NSIS bootstrap) are retried
  // once before the failure is recorded.
  await new Promise((r) => setTimeout(r, 5000));
  built = await run(tauriBin, ["build"], { cwd: path.join(rootDir, "src-tauri"), env: cargoEnv() });
}
if (!built.ok || !existsSync(bundleDir)) {
  const blocked = /linker|link\.exe|MSVC|Visual Studio|access is denied|EACCES/i.test(built.out) && !/error\[|panicked/i.test(built.out);
  push("L6-release-bundle", blocked ? "blocked" : "fail", [], (blocked ? "toolchain unavailable: " : "tauri build failed: ") + built.out.slice(-500));
  finish({ script: "package", level: "L6", cases, startedUtc });
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const artifacts = [];
for (const dir of readdirSync(bundleDir)) {
  const sub = path.join(bundleDir, dir);
  if (!statSync(sub).isDirectory()) continue;
  for (const f of readdirSync(sub)) {
    if (!/\.(exe|msi|nsis\.exe|zip|AppImage|dmg)$/i.test(f)) continue;
    const full = path.join(sub, f);
    artifacts.push({ path: path.relative(rootDir, full), bytes: statSync(full).size, sha256: sha256(full) });
  }
}
if (artifacts.length === 0) {
  push("L6-release-bundle", "fail", [], `bundle dir has no installer artefacts: ${bundleDir}`);
  finish({ script: "package", level: "L6", cases, startedUtc });
}
push("L6-release-bundle", "pass", [], `artefacts: ${artifacts.map((a) => `${path.basename(a.path)} (${(a.bytes / 1048576).toFixed(1)} MB)`).join(", ")}`);

finish({ script: "package", level: "L6", cases, startedUtc, extra: { bundle_artifacts: artifacts, build_log_tail: built.out.slice(-1500) } });
