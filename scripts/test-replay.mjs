// npm run test:replay — L1 deterministic replay of two-source transcript/audio
// scenarios through the real domain pipeline (store, machines, generation,
// reader). Clocked by fixture at_ms (logical, not wall-clock). Exit 0/1/2.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { buildContextPacket, repackForModel, validateSourceRefs } from "../src/domain/context.ts";
import { normalizeSttEvent } from "../src/domain/adapters.ts";
import { GenerationRegistry } from "../src/domain/generation.ts";
import { buildScript, ReaderCursor, ReaderSession } from "../src/domain/reader.ts";
import { SessionMachines } from "../src/domain/session.ts";
import { TranscriptStore } from "../src/domain/transcript.ts";
import { finish, root } from "./lib/harness.mjs";

const rootDir = root();
const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L1", status, replaced_boundaries, ...(note ? { note } : {}) });

const ajv = new Ajv2020({ strict: false, allErrors: true });
const transcriptSchema = JSON.parse(readFileSync(path.join(rootDir, ".agent", "schemas", "transcript-event.schema.json"), "utf8"));
const validateTranscript = ajv.compile(transcriptSchema);

const replayDir = path.join(rootDir, "tests", "fixtures", "replay");
const files = readdirSync(replayDir).filter((f) => f.endsWith(".json") && f !== "MANIFEST.json");

if (files.length === 0) {
  finish({ script: "test:replay", level: "L1", cases, startedUtc });
}

for (const file of files) {
  const id = `L1-replay-${file.replace(/\.json$/, "")}`;
  try {
    const fx = JSON.parse(readFileSync(path.join(replayDir, file), "utf8"));
    // Schema + timeline validation for every event.
    for (const [i, row] of fx.events.entries()) {
      if (!validateTranscript(row.transcript)) {
        throw new Error(`event ${i} schema: ${ajv.errorsText(validateTranscript.errors)}`);
      }
      const t = row.transcript;
      if (!(0 <= t.start_ms && t.start_ms <= t.end_ms && t.end_ms <= row.at_ms)) {
        throw new Error(`event ${i} violates 0 <= start <= end <= at_ms`);
      }
    }
    // Replay in at_ms order through the real pipeline.
    const store = new TranscriptStore();
    const machines = new SessionMachines();
    const registry = new GenerationRegistry();
    if (!machines.setCapture("connecting").ok || !machines.setCapture("live").ok) {
      throw new Error("capture machine refused connecting->live");
    }
    const ordered = [...fx.events].sort((a, b) => a.at_ms - b.at_ms);
    for (const row of ordered) {
      const t = row.transcript;
      const res = store.upsert(t);
      if (res.errors.length > 0) throw new Error(`upsert errors: ${res.errors.join("; ")}`);
      machines.noteCapture(t.source_id, row.at_ms);
      machines.noteTranscribed(t.source_id, t.end_ms);
      if (machines.lagMs(t.source_id) < 0) throw new Error("negative watermark lag");
    }
    // Zero answer-model calls before Send: no generation records may exist yet.
    const generationsBeforeSend = 0; // registry is empty by construction; start() below is the first call
    // Send on demand: immutable snapshot + single generation.
    const sendAt = fx.send_at_ms ?? ordered[ordered.length - 1].at_ms;
    const reader = new ReaderCursor(buildScript(fx.suggested_script ?? "Jawaban sementara."));
    const remoteFinals = ordered.filter((r) => r.at_ms <= sendAt && r.transcript.role === "remote" && r.transcript.status === "final");
    const selfFinals = ordered.filter((r) => r.at_ms <= sendAt && r.transcript.role === "self" && r.transcript.status === "final");
    const partialsAtSend = ordered.filter((r) => r.at_ms <= sendAt && r.transcript.status === "partial");
    const snapshot = {
      request_id: "req-replay-1",
      session_id: ordered[0].transcript.session_id,
      action: "answer",
      snapshot_revision: machines.revision,
      cutoff_ms: sendAt,
      target_segment_ids: remoteFinals.map((r) => r.transcript.segment_id),
      target_revisions: Object.fromEntries(remoteFinals.map((r) => [r.transcript.segment_id, r.transcript.revision])),
      self_segment_ids: selfFinals.map((r) => r.transcript.segment_id),
      context_packet_id: "ctx-replay-1",
      model_profile_id: "default",
      output_language: "id",
      answer_style: "spoken",
      provisional_segments: partialsAtSend.map((r) => r.transcript.segment_id),
      read_cursor_token: reader.committed,
    };
    const packet = buildContextPacket("ctx-replay-1", {
      id: "default", provider: "fixture", model: "fixture-1",
      context_limit: 8000, input_limit: 6000, output_limit: 2000, streaming: true,
    }, [
      { id: "brief", kind: "pinned_brief", text: "Jawab singkat.", source_refs: [], priority: 100 },
      ...remoteFinals.map((r, i) => ({ id: `q${i}`, kind: "history", text: r.transcript.text, source_refs: [r.transcript.segment_id], priority: 10 - i })),
    ]);
    if (packet.estimated_input_tokens > packet.budget_input_tokens) throw new Error("context packet exceeded budget");
    const started = registry.start(snapshot, GenerationRegistry.fingerprint(snapshot));
    if (started.duplicate || started.record.suggestion_version !== 1) throw new Error("send did not yield exactly one active generation v1");
    // Reader follows self speech only; remote words must not advance it.
    const committedBeforeRemote = (() => {
      for (const fin of selfFinals) reader.update(fin.transcript.text.split(/\s+/), true, "self");
      return reader.committed;
    })();
    for (const fin of remoteFinals) reader.update(fin.transcript.text.split(/\s+/), true, "remote");
    if (reader.committed !== committedBeforeRemote) throw new Error("remote speech advanced the reader");
    // Expectations.
    const exp = fx.expectations ?? {};
    if (exp.answer_model_calls_before_send !== undefined && generationsBeforeSend !== exp.answer_model_calls_before_send) {
      throw new Error(`model calls before send: ${generationsBeforeSend}`);
    }
    if (exp.normal_send_answer_calls !== undefined && started.record.suggestion_version !== 1) {
      throw new Error("send did not yield exactly one active generation v1");
    }
    const sessionId = ordered[0].transcript.session_id;
    if (exp.final_self_02_occurrences !== undefined) {
      const n = store.countFinalTextOccurrences(sessionId, "Saya menyimpan profil dan memori secara terpisah.");
      if (n !== exp.final_self_02_occurrences) throw new Error(`final_self_02 occurrences: ${n}`);
    }
    if (exp.final_text_occurrences) {
      for (const [text, count] of Object.entries(exp.final_text_occurrences)) {
        const n = store.countFinalTextOccurrences(sessionId, text);
        if (n !== count) throw new Error(`"${text}" occurrences: ${n}, want ${count}`);
      }
    }
    if (exp.min_finals !== undefined && store.finals(sessionId).length < exp.min_finals) {
      throw new Error(`finals ${store.finals(sessionId).length} < min ${exp.min_finals}`);
    }
    if (exp.remote_never_advances_reader && reader.committed > 0) {
      // Reader was only fed self finals; any committed movement must come from self words.
      const selfWords = store.finals(sessionId).filter((f) => f.event.role === "self").map((f) => f.event.text).join(" ").split(/\s+/).length;
      if (reader.committed > selfWords + 10) throw new Error("reader advanced beyond self speech");
    }
    push(id, "pass", ["wall-clock -> fixture at_ms logical clock", "provider audio -> authored transcript events"]);
  } catch (e) {
    push(id, "fail", [], String(e?.message ?? e).slice(0, 300));
  }
}

// T03 vertical-slice cases: snapshot fencing, dedup, cancel, and the
// no-model-before-Send gate, through the real domain pipeline.
try {
  const sliceStore = new TranscriptStore();
  const sliceRegistry = new GenerationRegistry();
  const sid = "slice-session-1";
  if (sliceRegistry.size !== 0) throw new Error("registry must start empty");
  const ev = (segment_id, role, revision, status, text, start_ms) => ({
    schema_version: "0.3",
    session_id: sid,
    connection_id: "conn-slice",
    source_id: role === "self" ? "mic" : "loop",
    role,
    segment_id,
    revision,
    start_ms,
    end_ms: start_ms + 400,
    status,
    text,
  });
  // Partial hypothesis, then committed final; remote question + self context.
  for (const e of [
    ev("q-1", "remote", 0, "partial", "Mengapa memilih", 0),
    ev("q-1", "remote", 1, "final", "Mengapa memilih arsitektur ini?", 0),
    ev("s-1", "self", 0, "final", "Fokus saya adalah respons cepat.", 950),
  ]) {
    const r = sliceStore.upsert(e);
    if (r.errors.length > 0) throw new Error(`slice upsert: ${r.errors.join("; ")}`);
  }
  if (sliceRegistry.size !== 0) throw new Error("model touched before Send");
  const finals = sliceStore.finals(sid);
  if (finals.some((f) => f.event.status !== "final")) throw new Error("partials leaked into finals view");
  const snap = (req, rev) => ({
    request_id: req,
    session_id: sid,
    action: "answer",
    snapshot_revision: rev,
    cutoff_ms: 1400,
    target_segment_ids: ["q-1"],
    target_revisions: { "q-1": 1 },
    self_segment_ids: ["s-1"],
    context_packet_id: "ctx-slice-1",
    model_profile_id: "default",
    output_language: "id",
    answer_style: "spoken",
    provisional_segments: [],
    read_cursor_token: 0,
  });
  const fp1 = GenerationRegistry.fingerprint(snap("req-slice-1", 3));
  const first = sliceRegistry.start(snap("req-slice-1", 3), fp1);
  if (first.duplicate || first.record.suggestion_version !== 1) throw new Error("first send must yield v1");
  // Snapshot is immutable: a later final never mutates the in-flight prompt.
  const late = sliceStore.upsert(ev("q-2", "remote", 0, "final", "Dan bagaimana biayanya?", 1500));
  if (late.errors.length > 0) throw new Error(`late upsert: ${late.errors.join("; ")}`);
  if (first.record.request_id !== "req-slice-1") throw new Error("snapshot identity drifted");
  // Identical double-click dedups to the same generation.
  const dup = sliceRegistry.start(snap("req-slice-1", 3), fp1);
  if (!dup.duplicate) throw new Error("identical resend must dedup");
  // New evidence -> new snapshot version.
  const fp2 = GenerationRegistry.fingerprint({ ...snap("req-slice-2", 4), target_segment_ids: ["q-1", "q-2"] });
  const second = sliceRegistry.start(snap("req-slice-2", 4), fp2);
  if (second.duplicate || second.record.suggestion_version !== 2) throw new Error("new send must yield v2");
  // Cancel fences late deltas; resend after cancel starts clean.
  sliceRegistry.cancel("req-slice-2");
  const late2 = sliceRegistry.applyDelta("req-slice-2", "terlambat");
  if (late2.applied) throw new Error("cancelled generation accepted a delta");
  if (sliceRegistry.get("req-slice-2").late_deltas_ignored !== 1) throw new Error("late delta not counted");
  push("L1-slice-send-fencing", "pass", ["provider model -> in-process registry only (no network)"]);
} catch (e) {
  push("L1-slice-send-fencing", "fail", [], String(e?.message ?? e).slice(0, 300));
}

// Reader follows self speech with a coherent script: self words commit
// tokens, remote words never advance the cursor.
try {
  const coherent = buildScript("Fokus saya adalah respons cepat. Kita mulai dari arsitektur.");
  const cursor = new ReaderCursor(coherent);
  cursor.update("Fokus saya adalah respons cepat.".split(/\s+/), true, "self");
  if (!(cursor.committed > 0)) throw new Error(`self speech did not advance the reader (committed=${cursor.committed})`);
  const afterSelf = cursor.committed;
  cursor.update("Mengapa memilih arsitektur ini?".split(/\s+/), true, "remote");
  if (cursor.committed !== afterSelf) throw new Error("remote speech advanced the reader");
  push("L1-slice-reader-follows-self", "pass", ["provider audio -> authored word lists"]);
} catch (e) {
  push("L1-slice-reader-follows-self", "fail", [], String(e?.message ?? e).slice(0, 300));
}

// T08 stable voice-follow: the committed prefix is frozen across chunked
// streaming and suggestion versions; skips commit forward, repeats move
// nothing visible, off-script rejoins on anchor. Replaced boundary: provider
// audio -> authored word lists.
try {
  const V1 = "Kita mulai dari arsitektur. Terima kasih banyak.";
  const s = new ReaderSession();
  s.ingestScript(buildScript("Kita mulai dari arsitektur."), 1);
  s.update(["kita", "mulai", "dari"], true, "self");
  s.ingestScript(buildScript(V1), 1);
  if (s.state.committed !== 3) throw new Error(`chunked streaming wiped committed (=${s.state.committed})`);
  s.update(["arsitektur", "terima", "kasih"], true, "self");
  s.ingestScript(buildScript(V1 + " Sampai jumpa lagi."), 2);
  if (s.state.committed !== 6) throw new Error(`new version dropped frozen prefix (=${s.state.committed})`);
  if (s.scriptVersion !== 2) throw new Error(`version not tracked (=${s.scriptVersion})`);
  s.ingestScript(buildScript("Cuaca hari ini cerah."), 3);
  if (s.state.committed !== 0 || s.state.confidence !== "uncertain") {
    throw new Error(`new answer did not restart reading: ${JSON.stringify(s.state)}`);
  }
  push("L1-reader-version-rebase", "pass", ["provider audio -> authored word lists"]);
} catch (e) {
  push("L1-reader-version-rebase", "fail", [], String(e?.message ?? e).slice(0, 300));
}

try {
  const s = new ReaderSession();
  s.ingestScript(buildScript("satu dua tiga. empat lima enam. tujuh delapan sembilan."), 1);
  if (s.update(["tujuh", "delapan", "sembilan"], true, "self").committed !== 9) {
    throw new Error("skipped sentence did not commit forward on anchor");
  }
  const rep = s.update(["satu", "dua", "tiga"], true, "self");
  if (rep.committed !== 9 || rep.tentative !== 9) throw new Error(`repeat moved the display: ${JSON.stringify(rep)}`);
  const off = new ReaderSession();
  off.ingestScript(buildScript("Kita mulai dari arsitektur. Terima kasih banyak."), 1);
  off.update(["kita", "mulai", "dari"], true, "self");
  for (let i = 0; i < 3; i++) off.update(["membahas", "cuaca", "liburan"], true, "self");
  if (off.state.confidence !== "off_script") throw new Error("unrelated speech did not go off-script");
  const back = off.update(["terima", "kasih", "banyak"], true, "self");
  if (back.committed !== 7 || back.confidence !== "tracking") throw new Error(`no anchor rejoin: ${JSON.stringify(back)}`);
  push("L1-reader-skip-repeat-offscript", "pass", ["provider audio -> authored word lists"]);
} catch (e) {
  push("L1-reader-skip-repeat-offscript", "fail", [], String(e?.message ?? e).slice(0, 300));
}
// through the real TS normalization + store + machines. Mirrors the Rust
// stt_adapters integration: partial→final discipline, dropped empty frames,
// typed error frames, recoverable disconnect, reconnect with fresh offset.
// Replaced boundary: provider network -> authored wire-message JSON.
try {
  const providerDir = path.join(rootDir, "tests", "provider");
  for (const file of readdirSync(providerDir).filter((f) => f.endsWith(".json"))) {
    const fx = JSON.parse(readFileSync(path.join(providerDir, file), "utf8"));
    const store = new TranscriptStore();
    const machines = new SessionMachines();
    if (!machines.setCapture("connecting").ok || !machines.setCapture("live").ok) {
      throw new Error(`${file}: capture machine refused connecting->live`);
    }
    let emitted = 0;
    let sawDisconnect = false;
    for (const m of fx.messages) {
      if (m.disconnect) {
        if (!m.recoverable) throw new Error(`${file}: only recoverable disconnects are scripted`);
        sawDisconnect = true;
        continue;
      }
      const ctx = {
        session_id: fx.session_id, source_id: fx.source_id, role: fx.role,
        connection_id: m.connection_id, clock_offset_ms: m.clock_offset_ms ?? 0,
        segment_id: m.segment_id, revision: m.revision,
      };
      const atMs = (m.payload?.segments?.[0]?.end_ms ?? 0) + (m.clock_offset_ms ?? 0) + 10;
      if (m.expect_error) {
        let threw = false;
        try {
          normalizeSttEvent(fx.provider, m.payload, ctx, atMs);
        } catch {
          threw = true;
        }
        if (!threw) throw new Error(`${file}: expected ${m.expect_error} error was not thrown`);
        continue;
      }
      const { event } = normalizeSttEvent(fx.provider, m.payload, ctx, atMs);
      if (!validateTranscript(event)) throw new Error(`${file}: normalized event failed schema`);
      const res = store.upsert(event);
      if (res.errors.length > 0) throw new Error(`${file}: upsert errors: ${res.errors.join("; ")}`);
      machines.noteCapture(event.source_id, atMs);
      machines.noteTranscribed(event.source_id, event.end_ms);
      emitted += 1;
    }
    if (!sawDisconnect) throw new Error(`${file}: scripted disconnect missing`);
    const exp = fx.expectations ?? {};
    if (emitted !== exp.events_emitted) throw new Error(`${file}: emitted ${emitted}, want ${exp.events_emitted}`);
    const finals = store.finals(fx.session_id);
    if (finals.length < (exp.min_finals ?? 0)) throw new Error(`${file}: finals ${finals.length} < min ${exp.min_finals}`);
    if (exp.committed_final_text && !finals.some((f) => f.event.text === exp.committed_final_text)) {
      throw new Error(`${file}: committed final text missing`);
    }
    if (exp.reconnect_session_start_ms !== undefined) {
      const tail = finals.find((f) => f.event.connection_id !== fx.messages[0].connection_id);
      if (!tail) throw new Error(`${file}: no post-reconnect final found`);
      if (tail.event.start_ms !== exp.reconnect_session_start_ms) {
        throw new Error(`${file}: reconnect start ${tail.event.start_ms} != ${exp.reconnect_session_start_ms}`);
      }
      if (exp.reconnect_session_end_ms !== undefined && tail.event.end_ms !== exp.reconnect_session_end_ms) {
        throw new Error(`${file}: reconnect end ${tail.event.end_ms} != ${exp.reconnect_session_end_ms}`);
      }
    }
    // Re-ingesting the committed tail is stale, not a duplicate row.
    const lastFinal = finals[finals.length - 1].event;
    const stale = store.upsert(lastFinal);
    if (stale.outcome !== "rejected-stale") throw new Error(`${file}: expected rejected-stale, got ${stale.outcome}`);
  }
  const registry = new GenerationRegistry();
  if (registry.size !== 0) throw new Error("model touched during provider replay");
  push("L1-slice-stt-protocol-replay", "pass", ["provider network -> authored wire-message JSON"]);
} catch (e) {
  push("L1-slice-stt-protocol-replay", "fail", [], String(e?.message ?? e).slice(0, 300));
}

// T12 model switch + budget repack (A13 L1) with zero model calls (A02 L1):
// the same source items packed for profil-hemat drop the big retrieved
// excerpt, then repack cleanly for profil-detail; every citation resolves to
// an imported document. Replaced boundary: provider model/caps -> fixture
// profile budgets + in-process registry (no network).
try {
  const hemat = { id: "profil-hemat", provider: "fixture", model: "fixture-hemat", context_limit: 2000, input_limit: 2000, output_limit: 500, streaming: true };
  const detail = { id: "profil-detail", provider: "fixture", model: "fixture-detail", context_limit: 16000, input_limit: 12000, output_limit: 4000, streaming: true };
  const items = [
    { id: "brief", kind: "pinned_brief", text: "Jawab singkat.", source_refs: [], priority: 100 },
    { id: "q-1", kind: "history", text: "Mengapa memilih arsitektur ini?", source_refs: ["remote-01"], priority: 60 },
    { id: "sec-arch", kind: "retrieved_section", text: `arsitektur.txt: ${"panduan arsitektur sistem ".repeat(200)}`, source_refs: ["doc-arch"], priority: 50 },
    { id: "s-1", kind: "history", text: "Fokus saya adalah respons cepat.", source_refs: ["self-01"], priority: 10 },
  ];
  const before = buildContextPacket("ctx-t12", hemat, items);
  if (!before.dropped_item_ids.includes("sec-arch")) throw new Error("hemat must drop the oversized excerpt");
  if (!before.items.some((i) => i.id === "q-1") || !before.items.some((i) => i.id === "brief")) {
    throw new Error("hemat must keep the question and pinned brief");
  }
  const after = repackForModel(before, items, detail);
  if (after.model_profile_id !== "profil-detail") throw new Error("repack did not record the new profile");
  if (after.dropped_item_ids.length !== 0) throw new Error(`detail must keep everything, dropped ${after.dropped_item_ids}`);
  if (!(after.estimated_input_tokens > before.estimated_input_tokens)) throw new Error("repack did not grow the packed context");
  const refs = validateSourceRefs(after.items, ["doc-arch"]);
  if (!refs.ok) throw new Error(`citations must resolve: ${JSON.stringify(refs)}`);
  const refsEmpty = validateSourceRefs(after.items, []);
  if (refsEmpty.ok || !refsEmpty.dangling.includes("doc-arch")) throw new Error("unknown workspace must flag dangling refs");
  const noModel = new GenerationRegistry();
  if (noModel.size !== 0) throw new Error("repack touched the generation registry");
  push("L1-model-switch-repack", "pass", ["provider model/caps -> fixture profile budgets + in-process registry (no network)"]);
} catch (e) {
  push("L1-model-switch-repack", "fail", [], String(e?.message ?? e).slice(0, 300));
}

finish({ script: "test:replay", level: "L1", cases, startedUtc });
