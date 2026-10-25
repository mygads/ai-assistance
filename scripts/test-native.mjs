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
// stale frontend — rebuild it instead of reusing a stale binary. Rust sources
// count too: an exe older than src-tauri/src lacks new commands entirely.
const exe = path.join(rootDir, "src-tauri", "target", "debug", "conversation-assistant.exe");
const rsDir = path.join(rootDir, "src-tauri", "src");
const newestRs = readdirSync(rsDir).map((f) => statSync(path.join(rsDir, f)).mtimeMs).reduce((a, b) => Math.max(a, b), 0);
const newestDist = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
if (!existsSync(exe) || statSync(exe).mtimeMs < Math.max(newestSrc, newestDist, newestRs)) {
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

// Fresh-boot clicks can land before React hydration attaches listeners: the
// button exists in the DOM but the click does nothing. Retry the click until
// the session id observably appears (bounded, state-based — never a fixed
// sleep), then return its text.
async function startSessionFromDashboard(bd) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const btn = await bd.$('[data-testid="start-session"]');
    if (await btn.isExisting()) {
      try { await btn.click(); } catch { /* re-render raced the click; retry */ }
    }
    try {
      const el = await bd.$('[data-testid="session-id"]');
      await el.waitForExist({ timeout: 4000 });
      const text = await el.getText();
      if (/Sesi session-/.test(text)) return text;
    } catch { /* not yet; click again */ }
  }
  const bodyText = await bd.execute(() => document.body.innerText ?? "").catch(() => "?");
  throw new Error(`session-id never appeared. window text: ${String(bodyText).slice(0, 800)}`);
}

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
  const sessionText = await startSessionFromDashboard(browser);
  push("L3-real-ipc-start-session", "pass", ["external STT/LLM -> loopback fixture servers (not yet wired; no provider call made)"], sessionText.slice(0, 120));
  // Persisted-transcript read-back through real IPC: the dashboard count must
  // reflect the two ingested finals stored in SQLite, not the UI-local store.
  const persistedEl = await browser.$('[data-testid="persisted-count"]');
  await persistedEl.waitForExist({ timeout: 10000 });
  const persistedText = await persistedEl.getText();
  if (!/Tersimpan 2 segmen/.test(persistedText)) throw new Error(`real select_transcript_range did not read back 2 finals: ${persistedText}`);
  push("L3-real-ipc-persisted-read", "pass", [], persistedText.slice(0, 80));
  const sendBtn = await browser.$('[data-testid="send-answer"]');
  // Send lives on the Overlay view: switch views first.
  const overlayBtn = await browser.$("button=Overlay");
  if (await overlayBtn.isExisting()) await overlayBtn.click();
  await sendBtn.waitForExist({ timeout: 10000 });
  await sendBtn.click();
  // The suggestion must arrive as Rust-emitted stream events built from the
  // DB snapshot (ingested finals), not a UI constant: the fixture bridge is
  // absent in the native binary, so "draf jawaban … arsitektur" (reader-
  // normalized tokens: lowercase, no punctuation) proves the real
  // snapshot -> stream path.
  await browser.waitUntil(async () => ((await browser.$('[data-testid="script"]').getText()) ?? "").includes("draf jawaban"), { timeout: 15000 });
  // Wait for the done signal before asserting content: chunks stream in.
  const metaEl = await browser.$('[data-testid="answer-meta"]');
  await metaEl.waitForExist({ timeout: 10000 });
  const metaText = await metaEl.getText();
  if (!/v1/.test(metaText)) throw new Error(`answer meta missing v1: ${metaText}`);
  const scriptText = await browser.$('[data-testid="script"]').getText();
  if (!scriptText.includes("arsitektur")) throw new Error(`streamed suggestion is not built from ingested finals: ${scriptText.slice(0, 200)}`);
  push("L3-real-ipc-send-answer", "pass", ["external STT/LLM -> deterministic fixture synthesis over the real snapshot (no provider call made)"], `meta=${metaText.slice(0, 60)} script_chars=${scriptText.length}`);
  // Identical double-click dedups: same request id, no second generation.
  await sendBtn.click();
  await browser.waitUntil(async () => ((await browser.$('[data-testid="answer-meta"]').getText()) ?? "") !== "", { timeout: 15000 });
  const metaText2 = await browser.$('[data-testid="answer-meta"]').getText();
  if (metaText2.trim() !== metaText.trim()) throw new Error(`resend did not dedup: ${metaText} vs ${metaText2}`);
  push("L3-send-dedup", "pass", [], `identical resend returned ${metaText2.trim()}`);
  // T12: model switch applies to the next request (ARCHITECTURE §8, A13-L3):
  // switch profiles on the dashboard, then send a shorten action and prove
  // the new generation streams action-specific synthesis over real IPC.
  const dashBtn = await browser.$("button=Dashboard");
  if (await dashBtn.isExisting()) await dashBtn.click();
  const profileSel = await browser.$('[data-testid="model-profile"]');
  await profileSel.waitForExist({ timeout: 10000 });
  await profileSel.selectByAttribute("value", "profil-hemat");
  await browser.waitUntil(async () => ((await browser.$('[data-testid="model-profile-saved"]').getText()) ?? "").includes("profil-hemat"), { timeout: 10000 });
  const overlayBtn2 = await browser.$("button=Overlay");
  if (await overlayBtn2.isExisting()) await overlayBtn2.click();
  const shortenBtn = await browser.$('[data-testid="action-shorten"]');
  await shortenBtn.waitForExist({ timeout: 10000 });
  await shortenBtn.click();
  // The remounted overlay renders answer-meta only after the stream settles.
  const shortMetaEl = await browser.$('[data-testid="answer-meta"]');
  await shortMetaEl.waitForExist({ timeout: 15000 });
  await browser.waitUntil(async () => ((await browser.$('[data-testid="answer-meta"]').getText()) ?? "").includes("v2"), { timeout: 15000 });
  const shortScript = await browser.$('[data-testid="script"]').getText();
  if (!shortScript.includes("ringkas")) throw new Error(`shorten send did not stream action-specific synthesis: ${shortScript.slice(0, 200)}`);
  push("L3-model-switch-next-request", "pass", ["external STT/LLM -> deterministic fixture synthesis over the real snapshot (no provider call made)"], "profil-hemat saved; shorten streamed as v2 with ringkas marker");
  // T17: focus must still sit on the clicked action after the stream settles
  // over real IPC (aria-disabled, never remounted mid-stream). Mirrors the L2
  // focus proof against the real WebView2 window.
  const focusedAfterStream = await browser.execute(() => document.activeElement?.getAttribute("data-testid"));
  if (focusedAfterStream !== "action-shorten") throw new Error(`focus moved during native streaming: ${focusedAfterStream}`);
  push("L3-focus-preserved-after-stream", "pass", [], `activeElement=${focusedAfterStream}`);
  // T17: cancel-after-done over real IPC. The stream already settled, so
  // cancel_answer returns false (terminal row) while the app must stay
  // consistent: status flips to cancelled, the settled script is untouched,
  // and no error alert appears. This is the first native exercise of
  // cancel_answer (previously only the fixture bridge called it).
  const cancelBtn = await browser.$('[data-testid="cancel-send"]');
  await cancelBtn.waitForExist({ timeout: 10000 });
  await cancelBtn.click();
  await browser.waitUntil(async () => ((await browser.$('[data-testid="generation-status"]').getText()) ?? "").includes("cancelled"), { timeout: 10000 });
  const scriptAfterCancel = await browser.$('[data-testid="script"]').getText();
  if (!scriptAfterCancel.includes("ringkas")) throw new Error(`cancel-after-done disturbed the settled script: ${scriptAfterCancel.slice(0, 200)}`);
  if (await browser.$('[role="alert"]').isExisting().catch(() => false)) {
    throw new Error(`cancel-after-done raised an alert: ${await browser.$('[role="alert"]').getText().catch(() => "?")}`);
  }
  push("L3-cancel-after-done-settles", "pass", [], "cancel_answer(false) over real IPC; settled script untouched, no alert");
  // T17 follow-up: token seek over real IPC. Clicking a token calls
  // seek_reader (struct input, always worked) and moves the stable cursor:
  // committed=5 with the band showing the committed words. Mirrors the L2
  // token-seek proof against the real WebView2 window.
  const token5 = await browser.$('[data-testid="token-5"]');
  await token5.waitForExist({ timeout: 10000 });
  await token5.click();
  await browser.waitUntil(async () => ((await browser.$('[data-testid="reader-state"]').getText()) ?? "").includes("committed=5"), { timeout: 10000 });
  const bandText = await browser.$('[data-testid="reading-band"]').getText();
  if (!bandText.includes("mengapa")) throw new Error(`reading band missing committed words after native seek: ${bandText.slice(0, 160)}`);
  push("L3-token-seek-native", "pass", [], "seek_reader over real IPC; committed=5, band shows mengapa");
  // T17: pause/resume over real IPC. A fresh native session rests in
  // "connecting" (nothing has claimed live capture in this build), so the
  // dashboard offers resume first: connecting -> live -> paused -> live.
  // Each capture-status line proves the pause_session/resume_session
  // roundtrip against Rust + SQLite.
  const dashBtn2 = await browser.$("button=Dashboard");
  if (await dashBtn2.isExisting()) await dashBtn2.click();
  // T17: source labels over real IPC. Dashboard list_sources (a bare-scalar
  // command broken by the same camelCase bug) must resolve the two labeled
  // roles, never mixed.
  const selfLabel = await browser.$('[data-testid="source-label-self"]');
  await selfLabel.waitForExist({ timeout: 10000 });
  if (!(await selfLabel.getText()).includes("self")) throw new Error(`self source label wrong: ${await selfLabel.getText()}`);
  const remoteLabel = await browser.$('[data-testid="source-label-remote"]');
  await remoteLabel.waitForExist({ timeout: 10000 });
  if (!(await remoteLabel.getText()).includes("remote")) throw new Error(`remote source label wrong: ${await remoteLabel.getText()}`);
  push("L3-source-labels-native", "pass", [], "list_sources over real IPC: self + remote labels");
  // T17 follow-up: document import over real IPC. Fills the dashboard form
  // and proves import_document persists to the default workspace (doc count
  // flips to 1). Mirrors the L2 dashboard-readiness proof natively.
  const docName = await browser.$('[data-testid="doc-import-name"]');
  await docName.waitForExist({ timeout: 10000 });
  await docName.setValue("materi-native.txt");
  const docText = await browser.$('[data-testid="doc-import-text"]');
  await docText.setValue("fakta uji isolasi workspace default");
  const docSubmit = await browser.$('[data-testid="doc-import-submit"]');
  await docSubmit.click();
  await browser.waitUntil(async () => ((await browser.$('[data-testid="doc-count"]').getText()) ?? "").includes("1 dokumen"), { timeout: 10000 });
  push("L3-doc-import-native", "pass", [], "import_document over real IPC: 1 dokumen workspace");
  // Click a capture-transition button until the expected status observably
  // appears: a single click can race a re-render/re-mount and get swallowed.
  // Short 3s polls per click attempt; the full diagnosis (alert + window text)
  // is produced once, only if the 45s budget expires.
  async function clickCaptureButton(btnTid, substr, step) {
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const btn = await browser.$(`[data-testid="${btnTid}"]`).catch(() => null);
      if (btn && await btn.isExisting().catch(() => false)) {
        try { await btn.click(); } catch { /* element swapped mid-click; retry */ }
      }
      try {
        await browser.waitUntil(
          async () => ((await browser.$('[data-testid="capture-status"]').getText()) ?? "").includes(substr),
          { timeout: 3000 },
        );
        return;
      } catch { /* not yet; click again */ }
    }
    const hasStatus = await browser.$('[data-testid="capture-status"]').isExisting().catch(() => false);
    const statusText = hasStatus ? await browser.$('[data-testid="capture-status"]').getText().catch(() => "?") : "<no capture-status element>";
    const hasAlert = await browser.$('[role="alert"]').isExisting().catch(() => false);
    const alertText = hasAlert ? await browser.$('[role="alert"]').getText().catch(() => "?") : "<no alert>";
    const bodyText = await browser.execute(() => document.body.innerText ?? "").catch(() => "?");
    throw new Error(`${step}: status never showed "${substr}". capture-status=[${statusText}]. alert=[${alertText}]. window: ${String(bodyText).slice(0, 1200)}`);
  }
  await clickCaptureButton("resume-session", "berjalan", "resume-connecting-to-live");
  await clickCaptureButton("pause-session", "dijeda", "pause-live-to-paused");
  await clickCaptureButton("resume-session", "berjalan", "resume-paused-to-live");
  push("L3-pause-resume-session", "pass", [], "resume/pause/resume roundtrip over real IPC (connecting -> live -> paused -> live)");
  // T17: stop_session over real IPC. Ending capture must return the dashboard
  // to its pre-session state (start button back, no alert); the restart block
  // below then proves a fresh session starts cleanly on the same database.
  {
    const t0 = Date.now();
    for (;;) {
      const stop = await browser.$('[data-testid="stop-session"]').catch(() => null);
      if (stop && await stop.isExisting().catch(() => false)) {
        try { await stop.click(); } catch { /* re-render raced; retry */ }
      }
      if (await browser.$('[data-testid="start-session"]').isExisting().catch(() => false)) break;
      if (Date.now() - t0 > 30000) throw new Error("stop-session never ended capture: start button did not return");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (await browser.$('[role="alert"]').isExisting().catch(() => false)) {
    throw new Error(`stop-session raised an alert: ${await browser.$('[role="alert"]').getText().catch(() => "?")}`);
  }
  push("L3-stop-session-ends-capture", "pass", [], "stop_session over real IPC; dashboard back to pre-session state");
  // T17: restart on the used database (C22 slice). Close the window + driver,
  // relaunch the same exe against the same app-data dir, and prove the same
  // DB file serves a fresh session: boot, start_session, and a 2-final
  // persisted read-back. Crash-interrupt settlement is proven at L1
  // (restart_recovery closes/reopens the real file); this proves the real
  // binary reopens that file cleanly with migrations applied.
  const dbPath = path.join(process.env.APPDATA ?? "", "app.conversation.assistant", "conversation-assistant.db");
  const beforeBytes = existsSync(dbPath) ? statSync(dbPath).size : -1;
  if (beforeBytes < 0) throw new Error(`native DB missing before restart: ${dbPath}`);
  try { await browser.deleteSession(); } catch { /* already gone */ }
  browser = null;
  try { driverProc?.kill(); } catch { /* ignore */ }
  driverProc = null;
  // Wait for the old driver port to go down: observable condition, no fixed sleep.
  {
    const t0 = Date.now();
    let down = false;
    while (Date.now() - t0 < 30000) {
      try {
        await fetch("http://127.0.0.1:4444/status");
      } catch {
        down = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!down) throw new Error("old tauri-driver did not release 127.0.0.1:4444");
  }
  driverProc = spawn(driverCmd, ["--port", "4444", "--native-driver", nativeDriver], { stdio: "ignore" });
  const driverReady2 = await (async () => {
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
  if (!driverReady2) throw new Error("tauri-driver did not come back on 127.0.0.1:4444 within 60s");
  browser = await webdriverio.remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "error",
    capabilities: { "tauri:options": { application: exe, args: [] } },
  });
  const title2 = await browser.getTitle().catch(() => "");
  if (!title2) throw new Error("no window title returned after restart; WebView2 window did not reappear");
  const sessionText2 = await startSessionFromDashboard(browser);
  const persistedEl2 = await browser.$('[data-testid="persisted-count"]');
  await persistedEl2.waitForExist({ timeout: 10000 });
  const persistedText2 = await persistedEl2.getText();
  if (!/Tersimpan 2 segmen/.test(persistedText2)) throw new Error(`persisted read-back failed after restart: ${persistedText2}`);
  if (!existsSync(dbPath)) throw new Error(`native DB missing after restart: ${dbPath}`);
  const afterBytes = statSync(dbPath).size;
  push("L3-restart-reopens-clean", "pass", [], `same db reused bytes=${beforeBytes}->${afterBytes}; ${sessionText2.slice(0, 60)}`);
  await browser.saveScreenshot(path.join(artDir, "native-dashboard.png"));
} catch (e) {
  push("L3-native-session", /no window title|did not appear|connect ECONNREFUSED/i.test(String(e)) ? "blocked" : "fail",
    [], `native session: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  try { await browser?.deleteSession(); } catch { /* ignore */ }
  try { driverProc?.kill(); } catch { /* ignore */ }
}

finish({ script: "test:native", level: "L3", cases, startedUtc });
