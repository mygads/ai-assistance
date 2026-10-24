import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionMachines } from "./session.ts";
import { GenerationRegistry, type SendSnapshot } from "./generation.ts";

function snap(over: Partial<SendSnapshot> = {}): SendSnapshot {
  return {
    request_id: "req-1",
    session_id: "s1",
    action: "answer",
    snapshot_revision: 7,
    cutoff_ms: 2200,
    target_segment_ids: ["remote-01"],
    target_revisions: { "remote-01": 1 },
    self_segment_ids: [],
    context_packet_id: "ctx-1",
    model_profile_id: "fast-id",
    output_language: "id",
    answer_style: "spoken",
    provisional_segments: [],
    read_cursor_token: 0,
    ...over,
  };
}

describe("SessionMachines", () => {
  it("capture, generation and prompter evolve independently", () => {
    const m = new SessionMachines();
    assert.ok(m.setCapture("connecting").ok);
    assert.ok(m.setCapture("live").ok);
    assert.ok(m.setPrompter("tracking").ok);
    // Generation idle->streaming directly is illegal; must prepare first.
    assert.ok(!m.setGeneration("streaming").ok);
    assert.ok(m.setGeneration("preparing_context").ok);
    assert.ok(m.setGeneration("streaming").ok);
    assert.equal(m.capture, "live");
    assert.equal(m.prompter, "tracking");
  });

  it("generation cycles only through preparing_context after terminal states", () => {
    const m = new SessionMachines();
    m.setGeneration("preparing_context");
    m.setGeneration("streaming");
    m.setGeneration("completed");
    assert.ok(!m.setGeneration("streaming").ok);
    assert.ok(m.setGeneration("preparing_context").ok);
  });

  it("watermarks report capture/transcription lag per source", () => {
    const m = new SessionMachines();
    m.noteCapture("loop", 5000);
    m.noteTranscribed("loop", 3200);
    assert.equal(m.lagMs("loop"), 1800);
    assert.equal(m.lagMs("unknown-source"), 0);
  });
});

describe("GenerationRegistry", () => {
  it("late deltas from a cancelled generation never touch the new answer", () => {
    const reg = new GenerationRegistry();
    const a = snap({ request_id: "req-A" });
    const b = snap({ request_id: "req-B", snapshot_revision: 9 });
    reg.start(a, GenerationRegistry.fingerprint(a));
    reg.applyDelta("req-A", "jawaban ");
    reg.start(b, GenerationRegistry.fingerprint(b)); // supersedes A
    const late = reg.applyDelta("req-A", "terlambat");
    assert.equal(late.applied, false);
    const cur = reg.applyDelta("req-B", "baru");
    assert.equal(cur.applied, true);
    assert.equal(cur.visible_text, "baru");
    assert.equal(reg.get("req-A")?.state, "cancelled");
    assert.equal(reg.get("req-A")?.late_deltas_ignored, 1);
  });

  it("identical double-click Send dedups to one generation", () => {
    const reg = new GenerationRegistry();
    const a = snap({ request_id: "req-A" });
    const fp = GenerationRegistry.fingerprint(a);
    const first = reg.start(a, fp);
    const dup = reg.start(a, fp);
    assert.equal(first.duplicate, false);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.record.generation_id, first.record.generation_id);
  });

  it("interrupted text is preserved and failures are explicit", () => {
    const reg = new GenerationRegistry();
    const a = snap({ request_id: "req-A" });
    reg.start(a, GenerationRegistry.fingerprint(a));
    reg.applyDelta("req-A", "sebagian");
    reg.cancel("req-A");
    assert.equal(reg.get("req-A")?.state, "cancelled");
    assert.equal(reg.get("req-A")?.visible_text, "sebagian");
    const b = snap({ request_id: "req-B", snapshot_revision: 10 });
    reg.start(b, GenerationRegistry.fingerprint(b));
    reg.finish("req-B", false);
    assert.equal(reg.get("req-B")?.state, "failed");
  });
});
