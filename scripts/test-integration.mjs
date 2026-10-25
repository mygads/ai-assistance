// npm run test:integration — L1 domain/storage/provider-normalization integration.
// Real components: TS adapters + TranscriptStore, Rust SQLite storage, local
// loopback fixture servers. Replaced boundary: provider networks (loopback
// fixtures). Exit 0 pass / 1 fail / 2 blocked (toolchain missing).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeDeepgram, normalizeSoniox } from "../src/domain/adapters.ts";
import { TranscriptStore } from "../src/domain/transcript.ts";
import { startFixtureServer } from "./lib/fixture-server.mjs";
import { cargoEnv, finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L1", status, replaced_boundaries, ...(note ? { note } : {}) });

const ajv = new Ajv2020({ strict: false, allErrors: true });
const transcriptSchema = JSON.parse(readFileSync(path.join(rootDir, ".agent", "schemas", "transcript-event.schema.json"), "utf8"));
const validateTranscript = ajv.compile(transcriptSchema);

// Case 1: Soniox-like normalization -> valid transcript-events, partial/final.
try {
  const store = new TranscriptStore();
  let rev = 0;
  const ctx = { session_id: "int-01", source_id: "stt-fixture", role: "remote", connection_id: "conn-1", clock_offset_ms: 0, segment_id: "seg-1", revision: rev };
  const partial = normalizeSoniox({ segments: [{ text: "Mengapa memilih", start_ms: 0, end_ms: 500 }], final: false }, ctx, 500);
  if (!validateTranscript(partial.event)) throw new Error("partial failed schema: " + ajv.errorsText(validateTranscript.errors));
  const r1 = store.upsert({ ...partial.event, revision: rev });
  if (r1.outcome !== "inserted") throw new Error(`partial upsert: ${r1.outcome}`);
  const fin = normalizeSoniox(
    { segments: [{ text: "Mengapa memilih arsitektur ini?", start_ms: 0, end_ms: 900 }], final: true },
    { ...ctx, revision: partial.next_revision }, 900);
  if (!validateTranscript(fin.event)) throw new Error("final failed schema");
  const r2 = store.upsert({ ...fin.event, revision: partial.next_revision });
  if (r2.outcome !== "committed") throw new Error(`final upsert: ${r2.outcome}`);
  const finals = store.finals("int-01");
  if (finals.length !== 1 || finals[0].event.text !== "Mengapa memilih arsitektur ini?") {
    throw new Error("partial was not replaced by final");
  }
  push("L1-normalize-soniox", "pass", ["provider network -> loopback canned STT"]);
} catch (e) {
  push("L1-normalize-soniox", "fail", [], String(e?.message ?? e).slice(0, 300));
}

// Case 2: Deepgram-like normalization with word timings.
try {
  const ctx = { session_id: "int-01", source_id: "stt-fixture", role: "remote", connection_id: "conn-1", clock_offset_ms: 0, segment_id: "seg-2", revision: 0 };
  const r = normalizeDeepgram(
    { is_final: true, channel: { alternatives: [{ transcript: "How do you keep context?", words: [{ word: "How", start: 1.45, end: 1.6 }, { word: "context?", start: 1.9, end: 2.0 }] }] } },
    ctx, 2000);
  if (!validateTranscript(r.event)) throw new Error("deepgram event failed schema");
  if (r.event.start_ms !== 1450000 - 1450000 + 1450 || r.event.end_ms !== 2000) throw new Error(`word timing mapping wrong: ${r.event.start_ms}-${r.event.end_ms}`);
  push("L1-normalize-deepgram", "pass", ["provider network -> loopback canned STT"]);
} catch (e) {
  push("L1-normalize-deepgram", "fail", [], String(e?.message ?? e).slice(0, 300));
}

// Case 3: reconnect with provider clock reset -> new offset, no silent overlap.
try {
  const store = new TranscriptStore();
  const old = normalizeSoniox({ segments: [{ text: "First connection tail.", start_ms: 9000, end_ms: 9500 }], final: true },
    { session_id: "int-01", source_id: "stt-fixture", role: "remote", connection_id: "conn-1", clock_offset_ms: 0, segment_id: "seg-9", revision: 0 }, 9600);
  store.upsert({ ...old.event, revision: 0 });
  // Provider reconnected: its clock restarted at 0 while session clock is at ~9600.
  // The connection context carries the fresh offset, so normalization maps
  // provider ms onto the session-monotonic clock exactly once.
  const offset = 9600;
  const dup = normalizeSoniox({ segments: [{ text: "First connection tail.", start_ms: 9000, end_ms: 9500 }], final: true },
    { session_id: "int-01", source_id: "stt-fixture", role: "remote", connection_id: "conn-2", clock_offset_ms: offset, segment_id: "seg-9", revision: 0 }, 9700);
  const mapped = dup.event.start_ms; // 9000 + 9600 = 18600 session ms
  if (mapped !== 18600) throw new Error(`offset mapping wrong: ${mapped}`);
  // Same revision arriving again must not duplicate the final: stale reject.
  const res = store.upsert({ ...dup.event, revision: 0 });
  if (res.outcome !== "rejected-stale") throw new Error(`expected rejected-stale, got ${res.outcome}`);
  push("L1-reconnect-offset", "pass", ["provider network -> loopback canned STT"]);
} catch (e) {
  push("L1-reconnect-offset", "fail", [], String(e?.message ?? e).slice(0, 300));
}

// Case 4: loopback fixture servers serve STT + streaming LLM shapes.
let server;
try {
  server = await startFixtureServer();
  const health = await (await fetch(`${server.url}/health`)).json();
  if (!health.ok) throw new Error("health check failed");
  const soniox = await (await fetch(`${server.url}/stt/soniox?scenario=partial-and-overlap`)).json();
  if (!Array.isArray(soniox.events) || soniox.events.length !== 2) throw new Error("soniox scenario wrong");
  const llmRes = await fetch(`${server.url}/llm/complete`, { method: "POST", body: JSON.stringify({ prompt: "test" }) });
  const sse = await llmRes.text();
  if (!sse.includes('"done":true') || !sse.includes("usage")) throw new Error("LLM SSE shape wrong");
  push("L1-fixture-server", "pass", ["provider network -> 127.0.0.1 loopback"]);
} catch (e) {
  push("L1-fixture-server", "fail", [], String(e?.message ?? e).slice(0, 300));
} finally {
  await server?.close();
}

// Case 5: Rust storage integration (real SQLite temp DB via cargo test).
try {
  const r = spawnSync("cargo test --test storage_integration", {
    cwd: path.join(rootDir, "src-tauri"), encoding: "utf8", timeout: 600000, shell: true, env: cargoEnv(),
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const m = out.match(/test result: ok\. (\d+) passed; (\d+) failed/);
  if (r.status === 0 && m && Number(m[1]) > 0 && Number(m[2]) === 0) {
    push("L1-rust-storage", "pass", []);
  } else {
    throw new Error((out.split("\n").filter((l) => /error|FAILED|panicked/i.test(l)).join(" | ") || `cargo exit ${r.status}`).slice(0, 400));
  }
} catch (e) {
  const msg = String(e?.message ?? e);
  if (/not recognized|not found|No such file/i.test(msg)) push("L1-rust-storage", "blocked", [], "cargo unavailable: " + msg.slice(0, 200));
  else push("L1-rust-storage", "fail", [], msg.slice(0, 300));
}

// Case 6: Rust audio-routing integration (real router/rings/links/fixture
// capture, no hardware). The target name varies per case; keep the runner
// generic so lane tests plug in without rewriting discovery.
for (const target of ["audio_routing"]) {
  try {
    const r = spawnSync(`cargo test --test ${target}`, {
      cwd: path.join(rootDir, "src-tauri"), encoding: "utf8", timeout: 600000, shell: true, env: cargoEnv(),
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const m = out.match(/test result: ok\. (\d+) passed; (\d+) failed/);
    if (r.status === 0 && m && Number(m[1]) > 0 && Number(m[2]) === 0) {
      push("L1-audio-routing", "pass", ["WASAPI hardware -> deterministic fixture capture"]);
    } else {
      throw new Error((out.split("\n").filter((l) => /error|FAILED|panicked/i.test(l)).join(" | ") || `cargo exit ${r.status}`).slice(0, 400));
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/not recognized|not found|No such file/i.test(msg)) push("L1-audio-routing", "blocked", [], "cargo unavailable: " + msg.slice(0, 200));
    else push("L1-audio-routing", "fail", [], msg.slice(0, 300));
  }
}

finish({ script: "test:integration", level: "L1", cases, startedUtc });
