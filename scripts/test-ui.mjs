// npm run test:ui — L2 browser component/journey checks (Playwright + Chromium).
// The native bridge is REPLACED by the labeled fixture bridge in the browser;
// this proves browser-visible interactions only, never native IPC (TESTING §5).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries, note) => cases.push({ id, level: "L2", status, replaced_boundaries, ...(note ? { note } : {}) });
const NATIVE_BRIDGE_REPLACED = "native Tauri IPC -> labeled in-browser fixture bridge (browser proof only)";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  push("L2-playwright-available", "blocked", [], "playwright npm package not installed; run the T02 toolchain setup first.");
  finish({ script: "test:ui", level: "L2", cases, startedUtc });
}
const chromiumPath = playwright.chromium.executablePath?.() ?? null;
if (chromiumPath && !existsSync(chromiumPath)) {
  push("L2-chromium-available", "blocked", [], `chromium binary missing at ${chromiumPath}; run 'npx playwright install chromium'.`);
  finish({ script: "test:ui", level: "L2", cases, startedUtc });
}

// Serve the production UI build (vite build output) over loopback. dist/ must
// exist AND be newer than every src/ui file: a stale bundle would test
// yesterday's frontend (the same staleness class test-native guards for the
// embedded binary).
const distDir = path.join(rootDir, "dist");
const distIndex = path.join(distDir, "index.html");
const uiDir = path.join(rootDir, "src", "ui");
const newestUi = readdirSync(uiDir).map((f) => statSync(path.join(uiDir, f)).mtimeMs).reduce((a, b) => Math.max(a, b), 0);
if (!existsSync(distIndex) || statSync(distIndex).mtimeMs < newestUi) {
  const build = await new Promise((resolve) => {
    // .cmd shims cannot be spawn-ed directly on Windows (EINVAL); route
    // through the shell as one literal-only command (same rule as test-native).
    const p = spawn("npx vite build", { cwd: rootDir, shell: true });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    p.on("close", (code) => resolve({ code, err }));
  });
  if (build.code !== 0 || !existsSync(path.join(distDir, "index.html"))) {
    push("L2-ui-build", "fail", [], `vite build failed: ${build.err.slice(0, 300)}`);
    finish({ script: "test:ui", level: "L2", cases, startedUtc });
  }
}
push("L2-ui-build", "pass", []);

const { createServer } = await import("node:http");
const { readFile } = await import("node:fs/promises");
const server = createServer(async (req, res) => {
  try {
    const urlPath = (req.url ?? "/").split("?")[0];
    const file = path.join(distDir, urlPath === "/" ? "index.html" : urlPath.slice(1));
    const data = await readFile(file);
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const artDir = path.join(rootDir, "artifacts", `test-ui-${startedUtc.replace(/[:.]/g, "-")}`);
mkdirSync(artDir, { recursive: true });

let browser = null;
try {
  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });
  const mode = await page.getByTestId("bridge-mode").textContent();
  if (!mode?.includes("fixture")) throw new Error(`expected fixture bridge label, saw: ${mode}`);
  push("L2-dashboard-renders", "pass", [NATIVE_BRIDGE_REPLACED], `bridge label: ${mode.trim()}`);
  await page.getByTestId("start-session").click();
  await page.getByTestId("session-id").waitFor({ timeout: 10000 });
  const sessionText = await page.getByTestId("session-id").textContent();
  const items = await page.getByTestId("transcript-list").locator("li").count();
  if (items < 2) throw new Error(`expected >=2 seeded transcript rows, saw ${items}`);
  const persisted = await page.getByTestId("persisted-count").textContent();
  if (!/Tersimpan 2 segmen/.test(persisted ?? "")) throw new Error(`persisted finals read-back missing: ${persisted}`);
  push("L2-start-session-journey", "pass", [NATIVE_BRIDGE_REPLACED], `${sessionText?.trim() ?? ""} | ${persisted?.trim() ?? ""}`);
  await page.screenshot({ path: path.join(artDir, "dashboard.png") });
  await page.getByRole("button", { name: "Overlay" }).click();
  await page.getByTestId("send-answer").click();
  // The suggestion must arrive as streamed deltas (fixture emitter), not as a
  // constant stamped into the UI: assert the synthesis marker + remote words.
  // NOTE: the overlay renders reader-normalized tokens (lowercase, no
  // punctuation), so assertions use the normalized form. waitForFunction takes
  // (fn, arg, options): the arg slot must be filled to pass options.
  await page.waitForFunction(() => document.querySelector('[data-testid="script"]')?.textContent?.includes("draf jawaban") ?? false, undefined, { timeout: 10000 });
  // Wait for the done signal before asserting content: chunks stream in.
  await page.getByTestId("answer-meta").waitFor({ timeout: 10000 });
  const meta = await page.getByTestId("answer-meta").textContent().catch(() => "");
  if (!/v1/.test(meta ?? "")) throw new Error(`answer meta missing v1: ${meta}`);
  const scriptText = await page.getByTestId("script").textContent();
  if (!scriptText || scriptText.length < 20) throw new Error("suggestion script did not render");
  if (!scriptText.includes("arsitektur")) throw new Error("streamed suggestion is not built from ingested finals");
  // Reader follows self speech only: the streamed naskah answers the remote
  // question, so the seeded self words legitimately match nothing — assert
  // the cursor does not hallucinate a jump (real advancement is proven at L1
  // with a coherent script; see test:replay slice-reader-follows-self).
  const readerState = await page.getByTestId("reader-state").textContent();
  if (!/committed=0/.test(readerState ?? "")) throw new Error(`reader jumped on unrelated naskah: ${readerState}`);
  await page.screenshot({ path: path.join(artDir, "overlay.png") });
  push("L2-overlay-send-journey", "pass", [NATIVE_BRIDGE_REPLACED], `script_chars=${scriptText.length} meta=${(meta ?? "").trim()} reader=${(readerState ?? "").trim()}`);
  // Fokus tidak boleh pindah selama streaming: tombol Kirim yang diklik
  // harus tetap memegang fokus setelah done (regresi = node di-remount).
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focused !== "send-answer") throw new Error(`focus moved during streaming: ${focused}`);
  push("L2-focus-preserved-during-stream", "pass", [NATIVE_BRIDGE_REPLACED], `activeElement=${focused}`);
  // Aksi Perbarui/Lanjutkan/Lebih singkat = send berbeda: versi naik ke v2.
  await page.getByTestId("action-shorten").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="answer-meta"]')?.textContent ?? "").includes("v2"), undefined, { timeout: 10000 });
  push("L2-send-action-shorten", "pass", [NATIVE_BRIDGE_REPLACED], "second send streamed as v2");
  // Drawer: buka, isi terlihat, tutup mengembalikan fokus ke pemicunya.
  await page.getByTestId("drawer-toggle").click();
  await page.getByTestId("transcript-drawer").waitFor({ timeout: 5000 });
  const drawerItems = await page.getByTestId("transcript-drawer").locator("li").count();
  if (drawerItems < 2) throw new Error(`drawer transcript missing rows: ${drawerItems}`);
  await page.getByTestId("instruction-input").fill("gunakan bahasa sederhana");
  await page.getByTestId("drawer-toggle").click();
  const focusAfterDrawer = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focusAfterDrawer !== "drawer-toggle") throw new Error(`drawer close did not return focus: ${focusAfterDrawer}`);
  push("L2-drawer-focus-return", "pass", [NATIVE_BRIDGE_REPLACED], `rows=${drawerItems} focus=${focusAfterDrawer}`);
  // Seek manual: klik token indeks 5 → committed=5, band menampilkan katanya.
  // Saran v2 ternormalisasi: draf(0) jawaban(1) v2(2) fixture(3) mengapa(4) …
  await page.getByTestId("token-5").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="reader-state"]')?.textContent ?? "").includes("committed=5"), undefined, { timeout: 5000 });
  const band = await page.getByTestId("reading-band").textContent();
  if (!/mengapa/.test(band ?? "")) throw new Error(`reading band missing committed words: ${band}`);
  push("L2-token-seek-band", "pass", [NATIVE_BRIDGE_REPLACED], `band=${(band ?? "").trim().slice(0, 60)}`);
  await page.screenshot({ path: path.join(artDir, "overlay.png") });
  // Mode ringkas: dua label sumber + status terpisah + Kirim + Pause.
  await page.getByTestId("mode-toggle-compact").click();
  await page.getByTestId("overlay-mode-compact").waitFor({ timeout: 5000 });
  for (const [tid, want] of [["compact-source-self", "Mikrofon"], ["compact-source-remote", "Loopback"]]) {
    const t = await page.getByTestId(tid).textContent();
    if (!t?.includes(want)) throw new Error(`${tid} missing label: ${t}`);
  }
  for (const tid of ["transcription-status", "generation-status", "send-answer-compact", "pause-compact"]) {
    await page.getByTestId(tid).waitFor({ timeout: 5000 });
  }
  push("L2-overlay-compact-mode", "pass", [NATIVE_BRIDGE_REPLACED], "compact labels + separate statuses present");
  await page.getByTestId("mode-toggle-reading").click();
  await page.getByTestId("overlay-mode-reading").waitFor({ timeout: 5000 });
  // Kembali ke dashboard kesiapan: label sumber, profil, bahasa, materi, jeda.
  await page.getByRole("button", { name: "Dashboard" }).click();
  const selfLabel = await page.getByTestId("source-label-self").textContent();
  const remoteLabel = await page.getByTestId("source-label-remote").textContent();
  if (!selfLabel?.includes("self") || !remoteLabel?.includes("remote")) throw new Error(`source labels wrong: ${selfLabel} | ${remoteLabel}`);
  await page.getByTestId("model-profile").selectOption("profil-hemat");
  await page.waitForFunction(() => (document.querySelector('[data-testid="model-profile-saved"]')?.textContent ?? "").includes("profil-hemat"), undefined, { timeout: 5000 });
  await page.getByTestId("language-lock").selectOption("en");
  await page.getByTestId("doc-import-name").fill("materi.txt");
  await page.getByTestId("doc-import-text").fill("halo dunia");
  await page.getByTestId("doc-import-submit").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="doc-count"]')?.textContent ?? "").includes("1 dokumen"), undefined, { timeout: 5000 });
  await page.getByTestId("pause-session").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="capture-status"]')?.textContent ?? "").includes("dijeda"), undefined, { timeout: 5000 });
  await page.getByTestId("resume-session").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="capture-status"]')?.textContent ?? "").includes("berjalan"), undefined, { timeout: 5000 });
  push("L2-dashboard-readiness", "pass", [NATIVE_BRIDGE_REPLACED], "sources + profile + language + docs + pause/resume");
  await page.screenshot({ path: path.join(artDir, "dashboard.png") });
  if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
} catch (e) {
  const msg = String(e?.message ?? e);
  if (/Executable doesn't exist|browser has not been found/i.test(msg)) {
    push("L2-chromium-launch", "blocked", [], `chromium unavailable: ${msg.slice(0, 250)}`);
  } else {
    push("L2-browser-journey", "fail", [NATIVE_BRIDGE_REPLACED], msg.slice(0, 300));
  }
} finally {
  await browser?.close();
  server.close();
}

finish({ script: "test:ui", level: "L2", cases, startedUtc, extra: { screenshots: ["dashboard.png", "overlay.png"] } });
