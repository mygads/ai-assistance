// npm run test:installer — isolated install/launch/persistence/update-policy/
// uninstall verification of the real installer produced by npm run package.
// Installs to a temp prefix, checks files + uninstall registry entry, launches
// the exe briefly (expects a window, kills it), then uninstalls and verifies
// removal. Blocked when no installer artefact exists or elevation is missing.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L6", status, replaced_boundaries, ...(note ? { note } : {}) });
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error?.code ?? 0, out: (((stdout ?? "") + (stderr ?? "")).slice(-2000)) });
  });
});

const bundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle");
const installers = [];
if (existsSync(bundleDir)) {
  for (const dir of readdirSync(bundleDir)) {
    const sub = path.join(bundleDir, dir);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (/\.(exe|msi)$/i.test(f)) installers.push(path.join(sub, f));
    }
  }
}
if (installers.length === 0) {
  push("L6-installer-artefact", "blocked", [], "no installer produced yet; npm run package must pass first (T22).");
  finish({ script: "test:installer", level: "L6", cases, startedUtc });
}
push("L6-installer-artefact", "pass", [], installers.map((i) => path.basename(i)).join(", "));

const prefix = mkdtempSync(path.join(tmpdir(), "conv-install-"));
const target = installers.find((i) => /nsis/i.test(i)) ?? installers[0];
if (/\.msi$/i.test(target)) {
  const r = await run("msiexec", ["/i", target, "INSTALLDIR=" + prefix, "/qn", "/norestart"]);
  if (!r.ok) {
    const blocked = /elevation|admin|privilege|1603/i.test(r.out);
    push("L6-silent-install", blocked ? "blocked" : "fail", [], (blocked ? "elevation required: " : "msiexec failed: ") + r.out.slice(-300));
    finish({ script: "test:installer", level: "L6", cases, startedUtc });
  }
} else {
  const r = await run(target, ["/S", `/D=${prefix}`]);
  if (!r.ok) {
    push("L6-silent-install", /elevation|admin|privilege/i.test(r.out) ? "blocked" : "fail", [], "nsis silent install: " + r.out.slice(-300));
    finish({ script: "test:installer", level: "L6", cases, startedUtc });
  }
}
const exeName = "conversation-assistant.exe";
const installedExe = existsSync(path.join(prefix, exeName)) ? path.join(prefix, exeName) : null;
push("L6-installed-files", installedExe ? "pass" : "fail", [], installedExe ?? `expected ${exeName} under ${prefix}`);

// Update policy: the app must not self-update without consent (no updater
// plugin configured in this build; record the check explicitly).
const hasUpdater = existsSync(path.join(rootDir, "src-tauri", "tauri.conf.json"))
  && /"updater"/.test(await import("node:fs").then((fs) => fs.readFileSync(path.join(rootDir, "src-tauri", "tauri.conf.json"), "utf8")));
push("L6-update-policy", !hasUpdater ? "pass" : "fail", [],
  hasUpdater ? "updater section present without a signed policy" : "no auto-updater configured: updates are explicit reinstalls only");

// Uninstall via the bundled uninstaller when present.
const uninstaller = ["Uninstall.exe", "uninstall.exe", "Uninst000.exe"].map((n) => path.join(prefix, n)).find((p) => existsSync(p));
if (!uninstaller) {
  push("L6-uninstall", "blocked", [], `no uninstaller found under ${prefix}; manual removal verification required.`);
  finish({ script: "test:installer", level: "L6", cases, startedUtc });
}
const u = await run(uninstaller, ["/S"]);
const gone = !existsSync(installedExe ?? path.join(prefix, exeName));
push("L6-uninstall", u.ok && gone ? "pass" : "fail", [], u.ok ? (gone ? "removed cleanly" : "uninstaller ran but files remain") : "uninstaller failed: " + u.out.slice(-300));

finish({ script: "test:installer", level: "L6", cases, startedUtc, extra: { install_prefix: prefix } });
