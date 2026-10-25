// npm run test:native — L3 built-app verification: real Tauri binary, real
// WebView2/IPC/Rust/storage. External STT/LLM stay on loopback fixtures.
// Driven through tauri-driver + WebdriverIO against the actual window.
// Exit 0 pass / 1 fail / 2 blocked (driver, build, or desktop missing).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { cargoEnv, finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L3", status, replaced_boundaries, ...(note ? { note } : {}) });
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  // .cmd shims (npx/tauri on Windows) cannot be execFile-spawned directly
  // (EINVAL); run them through the shell as one literal-only command string.
  // All call sites pass fixed literals — no caller input reaches the shell.
  if (cmd.endsWith(".cmd")) {
    execFile(`${cmd} ${args.join(" ")}`, { timeout: 600000, maxBuffer: 64 * 1024 * 1024, shell: true, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, out: ((stdout ?? "") + (stderr ?? "")).slice(-3000) });
    });
    return;
  }
  execFile(cmd, args, { timeout: 600000, maxBuffer: 64 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error?.code ?? 0, out: ((stdout ?? "") + (stderr ?? "")).slice(-3000) });
  });
});

const tauriBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
if (!existsSync(tauriBin)) {
  push("L3-tauri-cli", "blocked", [], "@tauri-apps/cli not installed; run the T02 toolchain setup first.");
  finish({ script: "test:native", level: "L3", cases, startedUtc });
}

// Frontend dist must exist AND be newer than every src/ui file.
const uiDir = path.join(rootDir, "src", "ui");
const distIndex = path.join(rootDir, "dist", "index.html");
const newestSrc = readdirSync(uiDir).map((f) => statSync(path.join(uiDir, f)).mtimeMs).reduce((a, b) => Math.max(a, b), 0);
if (!existsSync(distIndex) || statSync(distIndex).mtimeMs < newestSrc) {
  const b = await run(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "build"], { cwd: rootDir });
  if (!b.ok) {
    push("L3-ui-build", "fail", [], `vite build failed: ${b.out.slice(-300)}`);
    finish({ script: "test:native", level: "L3", cases, startedUtc });
  }
}

// Debug binary without bundling (fast path; packaging is test:installer).
// Tauri embeds dist/ at COMPILE time, so an exe older than dist/src carries a
// stale frontend — rebuild it instead of reusing a stale binary.
const exe = path.join(rootDir, "src-tauri", "target", "debug", "conversation-assistant.exe");
const newestDist = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
if (!existsSync(exe) || statSync(exe).mtimeMs < Math.max(newestSrc, newestDist)) {
  const b = await run(tauriBin, ["build", "--debug", "--no-bundle"], { cwd: path.join(rootDir, "src-tauri"), env: cargoEnv() });
  if (!existsSync(exe)) {
    const blocked = /linker|link\.exe|MSVC|Visual Studio/i.test(b.out);
    push("L3-debug-binary", blocked ? "blocked" : "fail", [], (blocked ? "MSVC linker unavailable: " : "tauri build --debug failed: ") + b.out.slice(-400));
    finish({ script: "test:native", level: "L3", cases, startedUtc });
  }
}
push("L3-debug-binary", "pass", [], exe);

// tauri-driver must exist: cargo bin dir first, then PATH.
const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? "";
const driverExe = path.join(homeDir, ".cargo", "bin", process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver");
let driverCmd = existsSync(driverExe) ? driverExe : "tauri-driver";
const driverProbe = await run(process.platform === "win32" ? "where" : "which", [driverCmd]);
if (!driverProbe.ok && !existsSync(driverExe)) {
  push("L3-tauri-driver", "blocked", [], "tauri-driver not on PATH; 'cargo install tauri-driver' first (T02 toolchain setup).");
  finish({ script: "test:native", level: "L3", cases, startedUtc });
}
let webdriverio = null;
try {
  webdriverio = await import("webdriverio");
} catch {
  push("L3-webdriverio", "blocked", [], "webdriverio npm package not installed; run the T02 toolchain setup first.");
  finish({ script: "test:native", level: "L3", cases, startedUtc });
}

const artDir = path.join(rootDir, "artifacts", `test-native-${startedUtc.replace(/[:.]/g, "-")}`);
mkdirSync(artDir, { recursive: true });

let driverProc = null;
let browser = null;
try {
  // On Windows tauri-driver fronts the Edge WebDriver (msedgedriver) that
  // drives WebView2. The driver binary is version-pinned to the WebView2
  // runtime (not the Edge browser) under tools/drivers.
  const nativeDriver = path.join(rootDir, "tools", "drivers", "155", "msedgedriver.exe");
  if (!existsSync(nativeDriver)) throw new Error(`native driver missing: ${nativeDriver}`);
  driverProc = spawn(driverCmd, ["--port", "4444", "--native-driver", nativeDriver], { stdio: "ignore" });
  // Poll the driver until it accepts sessions (no fixed-sleep guessing).
  const driverReady = await (async () => {
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
  if (!driverReady) throw new Error("tauri-driver did not become ready on 127.0.0.1:4444 within 60s");
  browser = await webdriverio.remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "error",
    capabilities: { "tauri:options": { application: exe, args: [] } },
  });
  const title = await browser.getTitle().catch(() => "");
  if (!title) throw new Error("no window title returned; WebView2 window did not appear");
  push("L3-window-launches", "pass", [], `title=${title.slice(0, 80)}`);
  // Drive the real IPC surface through the actual window: start a session.
  const startBtn = await browser.$('[data-testid="start-session"]');
  await startBtn.waitForExist({ timeout: 15000 });
  await startBtn.click();
  const sessionEl = await browser.$('[data-testid="session-id"]');
  const sessionText = await (async () => {
    try {
      await sessionEl.waitForExist({ timeout: 15000 });
      return await sessionEl.getText();
    } catch {
      const bodyText = await browser.execute(() => document.body.innerText ?? "").catch(() => "?");
      throw new Error(`session-id never appeared. window text: ${String(bodyText).slice(0, 400)}`);
    }
  })();
  if (!/Sesi session-/.test(sessionText)) throw new Error(`real start_session did not return a session id: ${sessionText}`);
  push("L3-real-ipc-start-session", "pass", ["external STT/LLM -> loopback fixture servers (not yet wired; no provider call made)"], sessionText.slice(0, 120));
  const sendBtn = await browser.$('[data-testid="send-answer"]');
  // Send lives on the Overlay view: switch views first.
  const overlayBtn = await browser.$("button=Overlay");
  if (await overlayBtn.isExisting()) await overlayBtn.click();
  await sendBtn.waitForExist({ timeout: 10000 });
  await sendBtn.click();
  await browser.waitUntil(async () => ((await browser.$('[data-testid="script"]').getText()) ?? "").length > 20, { timeout: 15000 });
  push("L3-real-ipc-send-answer", "pass", ["external STT/LLM -> loopback fixture servers (not yet wired; no provider call made)"], "suggestion rendered from real IPC start_session + send_answer");
  await browser.saveScreenshot(path.join(artDir, "native-dashboard.png"));
} catch (e) {
  push("L3-native-session", /no window title|did not appear|connect ECONNREFUSED/i.test(String(e)) ? "blocked" : "fail",
    [], `native session: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  try { await browser?.deleteSession(); } catch { /* ignore */ }
  try { driverProc?.kill(); } catch { /* ignore */ }
}

finish({ script: "test:native", level: "L3", cases, startedUtc });
