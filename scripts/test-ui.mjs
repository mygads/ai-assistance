// npm run test:ui — L2 browser component/journey checks (Playwright + Chromium).
// The native bridge is REPLACED by the labeled fixture bridge in the browser;
// this proves browser-visible interactions only, never native IPC (TESTING §5).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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

// Serve the production UI build (vite build output) over loopback.
const distDir = path.join(rootDir, "dist");
if (!existsSync(path.join(distDir, "index.html"))) {
  const build = await new Promise((resolve) => {
    const p = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "build"], { cwd: rootDir, shell: false });
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
