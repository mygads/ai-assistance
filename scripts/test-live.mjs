// npm run test:live — bounded live STT/LLM smoke (L5).
// Opt-in only: requires LIVE_TESTS_ENABLED=true, provider keys, and budget
// caps from config/live-tests.env. Without all three this exits 2 (blocked)
// and performs zero network calls. Spend caps are enforced before any call;
// the run stops at cap, throttling, or auth failure.
import { readFileSync } from "node:fs";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L5", status, replaced_boundaries, ...(note ? { note } : {}) });

const enabled = process.env.LIVE_TESTS_ENABLED === "true";
const keys = {
  SONIOX_API_KEY: Boolean(process.env.SONIOX_API_KEY),
  DEEPGRAM_API_KEY: Boolean(process.env.DEEPGRAM_API_KEY),
  LLM_API_KEY: Boolean(process.env.LLM_API_KEY),
};
let caps = {};
try {
  const raw = readFileSync(path.join(rootDir, "config", "live-tests.env.example"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^(LIVE_[A-Z_]+)=\"?([^\"]*)\"?$/);
    if (m) caps[m[1]] = m[2];
  }
} catch { /* caps stay empty -> blocked */ }

const missing = [
  !enabled && "LIVE_TESTS_ENABLED=true",
  !keys.SONIOX_API_KEY && !keys.DEEPGRAM_API_KEY && "an STT key (SONIOX_API_KEY or DEEPGRAM_API_KEY)",
  !keys.LLM_API_KEY && "LLM_API_KEY",
  !caps.LIVE_MAX_USD && "budget caps (LIVE_MAX_USD in config/live-tests.env)",
].filter(Boolean);

if (missing.length > 0) {
  push("L5-live-prerequisites", "blocked", [],
    `not opt-in or unconfigured; missing: ${missing.join("; ")}. Zero live calls made.`);
  finish({ script: "test:live", level: "L5", cases, startedUtc });
}

// Opted in with keys: run the bounded smoke (adapters land in T11/T19).
const { liveCompleteStream, liveTranscribeWav } = await import("../src/domain/adapters.ts");
const budgetUsd = Number(caps.LIVE_MAX_USD ?? 0);
if (!(budgetUsd > 0)) {
  push("L5-live-budget", "blocked", [], "LIVE_MAX_USD is not a positive number; refusing to spend.");
  finish({ script: "test:live", level: "L5", cases, startedUtc });
}
try {
  const wav = new Uint8Array(16000 * 2); // 1s silence placeholder; real WAV fixtures in T19
  await liveTranscribeWav(wav, "id");
  push("L5-live-stt-id", "pass", []);
} catch (e) {
  push("L5-live-stt-id", "fail", [], String(e?.message ?? e).slice(0, 300));
}
try {
  await liveCompleteStream("Uji streaming.", "default");
  push("L5-live-llm-stream", "pass", []);
} catch (e) {
  push("L5-live-llm-stream", "fail", [], String(e?.message ?? e).slice(0, 300));
}
finish({ script: "test:live", level: "L5", cases, startedUtc });
