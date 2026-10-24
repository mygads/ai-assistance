import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TranscriptStore, type TranscriptEvent } from "./transcript.ts";

function ev(partial: Partial<TranscriptEvent> & { segment_id: string }): TranscriptEvent {
  return {
    schema_version: "0.3",
    session_id: "s1",
    source_id: "mic",
    role: "self",
    connection_id: "c1",
    revision: 0,
    start_ms: 0,
    end_ms: 100,
    status: "partial",
    text: "",
    ...partial,
  };
}

describe("TranscriptStore", () => {
  it("partial revisions replace one hypothesis; final commits a single copy", () => {
    const store = new TranscriptStore();
    assert.equal(store.upsert(ev({ segment_id: "a", text: "halo", revision: 0 })).outcome, "inserted");
    assert.equal(store.upsert(ev({ segment_id: "a", text: "halo semua", revision: 1 })).outcome, "replaced-hypothesis");
    assert.equal(store.upsert(ev({ segment_id: "a", text: "halo semuanya", revision: 2, status: "final" })).outcome, "committed");
    assert.equal(store.finals("s1").length, 1);
    assert.equal(store.countFinalTextOccurrences("s1", "halo semuanya"), 1);
  });

  it("rejects stale revisions and duplicate finals (reconnect replay)", () => {
    const store = new TranscriptStore();
    store.upsert(ev({ segment_id: "a", text: "v2", revision: 2, status: "final" }));
    assert.equal(store.upsert(ev({ segment_id: "a", text: "v1-late", revision: 1 })).outcome, "rejected-stale");
    assert.equal(store.upsert(ev({ segment_id: "a", text: "v2", revision: 2, status: "final" })).outcome, "rejected-stale");
    assert.equal(store.finals("s1").length, 1);
  });

  it("records provider corrections as new versions, not silent edits", () => {
    const store = new TranscriptStore();
    store.upsert(ev({ segment_id: "a", text: "saya pergi", revision: 1, status: "final" }));
    const r = store.upsert(ev({ segment_id: "a", text: "saya pergi pagi", revision: 2, status: "final", corrects_revision: 1 }));
    assert.equal(r.outcome, "corrected");
    assert.equal(store.countFinalTextOccurrences("s1", "saya pergi pagi"), 1);
  });

  it("maps reconnected provider timestamps onto the session clock", () => {
    const store = new TranscriptStore();
    store.setConnectionOffset("c1", 0);
    store.upsert(ev({ segment_id: "a", text: "awal", start_ms: 0, end_ms: 500, status: "final" }));
    store.setConnectionOffset("c1", 5000); // provider clock reset on reconnect
    const r = store.upsert(ev({ segment_id: "b", text: "lanjut", start_ms: 0, end_ms: 400, status: "final" }));
    assert.equal(r.stored?.session_start_ms, 5000);
    assert.equal(r.stored?.session_end_ms, 5400);
    const finals = store.finals("s1");
    assert.equal(finals.length, 2);
    assert.ok(finals[0]!.session_start_ms <= finals[1]!.session_start_ms);
  });

  it("keeps overlapping self/remote segments with role attribution", () => {
    const store = new TranscriptStore();
    store.upsert(ev({ segment_id: "r1", source_id: "loop", role: "remote", start_ms: 900, end_ms: 1400, text: "question?", status: "final" }));
    store.upsert(ev({ segment_id: "s1", source_id: "mic", role: "self", start_ms: 950, end_ms: 1300, text: "jawaban", status: "final" }));
    const finals = store.finals("s1");
    assert.equal(finals.length, 2);
    assert.deepEqual(finals.map((f) => f.event.role).sort(), ["remote", "self"]);
  });

  it("rejects invalid events without fabricating fields", () => {
    const store = new TranscriptStore();
    const bad = ev({ segment_id: "a", start_ms: 500, end_ms: 100, confidence: 2 });
    const r = store.upsert(bad);
    assert.equal(r.outcome, "rejected-stale");
    assert.ok(r.errors.length >= 2);
  });
});
