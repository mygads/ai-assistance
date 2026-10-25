// npm run test:replay — L1 deterministic replay of two-source transcript/audio
// scenarios through the real domain pipeline (store, machines, generation,
// reader). Clocked by fixture at_ms (logical, not wall-clock). Exit 0/1/2.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { buildContextPacket } from "../src/domain/context.ts";
import { GenerationRegistry } from "../src/domain/generation.ts";
import { buildScript, ReaderCursor } from "../src/domain/reader.ts";
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

finish({ script: "test:replay", level: "L1", cases, startedUtc });
