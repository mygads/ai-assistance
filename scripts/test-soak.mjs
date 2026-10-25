// npm run test:soak — long-run stability: replay fixture scenarios against the
// real domain pipeline on a schedule and measure drift (heap, lag, loss).
// Modes: --realtime (default; gate-worthy) replays on wall-clock schedule;
// --accelerated is a labeled fast path and NEVER satisfies the soak gate.
// --minutes=N (default 30 for the gate; use 1 for smoke).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SessionMachines } from "../src/domain/session.ts";
import { TranscriptStore } from "../src/domain/transcript.ts";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.+))?$/);
  return m ? [m[1], m[2] ?? "true"] : [];
}));
const minutes = Math.max(1, Number(args.minutes ?? 30));
const realtime = args.accelerated !== "true";
const label = realtime ? "realtime" : "accelerated";

const fixtures = readdirSync(path.join(rootDir, "tests", "fixtures", "replay"))
  .filter((f) => f.endsWith(".json") && f !== "MANIFEST.json")
  .map((f) => JSON.parse(readFileSync(path.join(rootDir, "tests", "fixtures", "replay", f), "utf8")));

const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L2", status, replaced_boundaries, ...(note ? { note } : {}) });
// NOTE: level is recorded as L2 only because the harness schema has no soak
// level; the note on every case states the true gate (real-time long-run).

const deadline = Date.now() + minutes * 60 * 1000;
const tickMs = realtime ? 100 : 0;
let cycles = 0;
let processed = 0;
let errors = 0;
const heapStart = process.memoryUsage().heapUsed;
let heapMax = heapStart;
let maxTickLag = 0;
const store = new TranscriptStore();
const machines = new SessionMachines();
machines.setCapture("connecting");
machines.setCapture("live");

let fi = 0;
let ei = 0;
const t0 = Date.now();
while (Date.now() < deadline) {
  const tickStart = Date.now();
  const fx = fixtures[fi % fixtures.length];
  const ordered = [...fx.events].sort((a, b) => a.at_ms - b.at_ms);
  const row = ordered[ei % ordered.length];
  try {
    store.upsert(row.transcript);
    machines.noteCapture(row.transcript.source_id, row.at_ms + cycles * 100000);
    machines.noteTranscribed(row.transcript.source_id, row.transcript.end_ms);
    processed += 1;
  } catch {
    errors += 1;
  }
  ei += 1;
  if (ei % ordered.length === 0) { fi += 1; cycles += 1; }
  heapMax = Math.max(heapMax, process.memoryUsage().heapUsed);
  maxTickLag = Math.max(maxTickLag, Date.now() - tickStart - tickMs);
  if (realtime) await new Promise((r) => setTimeout(r, tickMs));
}
const wallMin = (Date.now() - t0) / 60000;
const heapGrowthMb = (heapMax - heapStart) / 1048576;

push(`soak-${label}-no-exceptions`, errors === 0 ? "pass" : "fail",
  realtime ? [] : ["wall-clock time -> as-fast-as-possible loop"],
  `errors=${errors} processed=${processed} cycles=${cycles} wall_min=${wallMin.toFixed(2)} (true gate: real-time long-run)`);
push(`soak-${label}-heap-bounded`, heapGrowthMb < 100 ? "pass" : "fail",
  realtime ? [] : ["wall-clock time -> as-fast-as-possible loop"],
  `heap_growth_mb=${heapGrowthMb.toFixed(1)} (true gate: real-time long-run)`);
push(`soak-${label}-tick-lag`, maxTickLag < 5000 ? "pass" : "fail",
  realtime ? [] : ["wall-clock time -> as-fast-as-possible loop"],
  `max_tick_lag_ms=${maxTickLag} (true gate: real-time long-run)`);

if (!realtime) {
  push("soak-mode-label", "blocked", ["wall-clock time -> as-fast-as-possible loop"],
    "accelerated mode is diagnostic only; the soak gate requires --realtime --minutes>=30");
}

finish({
  script: "test:soak", level: "L2", cases, startedUtc,
  extra: { note: "Soak provenance: realtime mode is the gate; accelerated mode is labeled non-gate. L2 is the closest schema level; these cases assert long-run stability, not browser behavior." },
});
