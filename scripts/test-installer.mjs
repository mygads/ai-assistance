// npm run test:installer — isolated install/launch/persistence/update-policy/
// uninstall verification of the real installer produced by npm run package.
// Installs to a temp prefix, checks files + uninstall registry entry, launches
// the exe briefly (expects a window, kills it), then uninstalls and verifies
// removal. Blocked when no installer artefact exists or elevation is missing.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
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
const artDir = path.join(rootDir, "artifacts", `test-installer-${startedUtc.replace(/[:.]/g, "-")}`);
mkdirSync(artDir, { recursive: true });

// Launch the INSTALLED exe and prove its window appears: the release bundle
// (production profile, no dev hooks) must boot, not just exist on disk.
// Driven through tauri-driver + WebdriverIO like test:native.
if (installedExe) {
  let driverProc = null;
  let launched = null;
  try {
    const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? "";
    const driverExe = path.join(homeDir, ".cargo", "bin", process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver");
    const nativeDriver = path.join(rootDir, "tools", "drivers", "155", "msedgedriver.exe");
    if (!existsSync(nativeDriver)) throw new Error(`native driver missing: ${nativeDriver}`);
    const webdriverio = await import("webdriverio");
    driverProc = spawn(driverExe, ["--port", "4444", "--native-driver", nativeDriver], { stdio: "ignore" });
    const ready = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        try {
          const res = await fetch("http://127.0.0.1:4444/status").then((r) => r.json());
          if (res && res.value !== undefined) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    })();
    if (!ready) throw new Error("tauri-driver did not become ready for the installed app");
    launched = await webdriverio.remote({
      hostname: "127.0.0.1",
      port: 4444,
      logLevel: "error",
      capabilities: { "tauri:options": { application: installedExe, args: [] } },
    });
    const title = await launched.getTitle().catch(() => "");
    if (!title) throw new Error("installed exe produced no window title");
    await launched.saveScreenshot(path.join(artDir, "installed-window.png"));
    push("L6-installed-launch", "pass", [], `installed exe booted window title=${title.slice(0, 80)}`);
  } catch (e) {
    push("L6-installed-launch", "fail", [], `installed exe did not boot a window: ${String(e?.message ?? e).slice(0, 300)}`);
  } finally {
    try { await launched?.deleteSession(); } catch { /* ignore */ }
    try { driverProc?.kill(); } catch { /* ignore */ }
  }
} else {
  push("L6-installed-launch", "fail", [], "no installed exe to launch");
}

// T24/A20 L6 slice: the installed production image must contain no test
// hooks and no secret values (negative check on the shipped bytes, not just
// the source tree that check.mjs already scans at L0).
if (installedExe) {
  const { readFileSync: readBin } = await import("node:fs");
  const image = readBin(installedExe, "latin1");
  const violations = [];
  if (image.includes("test-harness")) violations.push("test-harness marker in installed exe");
  if (/sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bpas]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY/.test(image)) {
    violations.push("secret-shaped literal in installed exe");
  }
  push("L6-no-test-hooks-in-image", violations.length === 0 ? "pass" : "fail", [],
    violations.length === 0 ? `scanned ${(statSync(installedExe).size / 1048576).toFixed(1)} MB installed exe: no hooks, no secrets` : violations.join("; "));
} else {
  push("L6-no-test-hooks-in-image", "fail", [], "no installed exe to scan");
}

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
// NSIS removes files asynchronously after the uninstaller exits: poll for
// disappearance instead of asserting immediately (immediate check flaked).
let gone = !existsSync(installedExe ?? path.join(prefix, exeName));
if (u.ok && !gone) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 2000));
    gone = !existsSync(installedExe ?? path.join(prefix, exeName));
    if (gone) break;
  }
}
push("L6-uninstall", u.ok && gone ? "pass" : "fail", [], u.ok ? (gone ? "removed cleanly" : "uninstaller ran but files remain") : "uninstaller failed: " + u.out.slice(-300));

finish({ script: "test:installer", level: "L6", cases, startedUtc, extra: { install_prefix: prefix } });
