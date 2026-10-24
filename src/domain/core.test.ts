import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildContextPacket, repackForModel, estimateTokens, type ContextItem, type ModelProfile } from "./context.ts";
import { buildScript, ReaderCursor, normalizeWord } from "./reader.ts";
import { MemoryStore } from "./memory.ts";

const PROFILE: ModelProfile = {
  id: "fast-id",
  provider: "fixture",
  model: "fixture-fast",
  context_limit: 32000,
  input_limit: 28000,
  output_limit: 2048,
  streaming: true,
};

function item(id: string, kind: string, priority: number, len = 400): ContextItem {
  return { id, kind, text: "x".repeat(len), source_refs: [id], priority };
}

describe("context budget", () => {
  it("pinned facts survive while history is dropped under a tight budget", () => {
    const items = [
      item("pinned-1", "pinned_fact", 100, 400),
      item("hist-1", "history", 1, 4000),
      item("hist-2", "history", 1, 4000),
    ];
    const packet = buildContextPacket("ctx-1", PROFILE, items, { activeContextTarget: 500 });
    assert.ok(packet.items.some((i) => i.id === "pinned-1"));
    assert.ok(packet.dropped_item_ids.length > 0);
    assert.ok(packet.estimated_input_tokens <= packet.budget_input_tokens + estimateTokens("x".repeat(400)));
  });

  it("repacks the same sources for a smaller model with output reserve", () => {
    const items = [item("pinned-1", "pinned_brief", 100, 800), item("sec-1", "retrieved_section", 50, 2000)];
    const full = buildContextPacket("ctx-1", PROFILE, items);
    const small: ModelProfile = { ...PROFILE, id: "tiny", context_limit: 4096, input_limit: 3072, output_limit: 512 };
    const repacked = repackForModel(full, items, small);
    assert.equal(repacked.model_profile_id, "tiny");
    assert.ok(repacked.reserved_output_tokens >= 512 || repacked.reserved_output_tokens > 0);
    assert.ok(repacked.estimated_input_tokens <= repacked.budget_input_tokens + estimateTokens("x".repeat(800)));
  });
});

describe("reader", () => {
  const script = buildScript(
    "Saya menyimpan profil dan memori secara terpisah.\n\nDokumen menjadi sumber bukti, sedangkan skill mengatur cara menyusun jawaban.",
  );

  it("builds spoken tokens without markdown/citation chrome", () => {
    const md = buildScript("# Judul\n\nBaca ini [S01] dan *lanjutkan*.");
    assert.ok(md.length > 0);
    assert.ok(md.every((t) => !/[*#[\]]/.test(t.word)));
  });

  it("normalizes digits across Indonesian/English words", () => {
    assert.equal(normalizeWord("Dua"), "2");
    assert.equal(normalizeWord("two"), "2");
    assert.equal(normalizeWord("12"), "12");
  });

  it("follows self speech locally; remote speech never moves the cursor", () => {
    const cursor = new ReaderCursor(script);
    const before = cursor.update(["dokumen", "menjadi"], false, "remote");
    assert.equal(before.committed, 0);
    const after = cursor.update(["saya", "menyimpan", "profil"], true, "self");
    assert.ok(after.committed > 0);
  });

  it("a single common word cannot jump the cursor across the script", () => {
    const cursor = new ReaderCursor(script);
    cursor.seek(0);
    const st = cursor.update(["dan"], true, "self");
    assert.equal(st.committed, 0);
    assert.equal(st.confidence, "tracking");
  });

  it("partial moves tentative only; final commits", () => {
    const cursor = new ReaderCursor(script);
    const p = cursor.update(["saya", "menyimpan", "profil"], false, "self");
    assert.ok(p.tentative > p.committed || p.tentative === p.committed);
    const f = cursor.update(["saya", "menyimpan", "profil"], true, "self");
    assert.ok(f.committed > 0);
  });

  it("goes off-script on unrelated speech and reacquires on anchor", () => {
    const cursor = new ReaderCursor(script);
    cursor.update(["saya", "menyimpan", "profil"], true, "self");
    cursor.update(["membahas", "cuaca", "liburan"], true, "self");
    cursor.update(["membahas", "cuaca", "liburan"], true, "self");
    const off = cursor.update(["membahas", "cuaca", "liburan"], true, "self");
    assert.equal(off.confidence, "off_script");
    const back = cursor.update(["dokumen", "menjadi", "sumber"], true, "self");
    assert.ok(back.tentative > 0 || back.committed > 0);
  });
});

describe("memory", () => {
  it("suggestions, remote speech and read-aloud never become confirmed facts", () => {
    const store = new MemoryStore();
    for (const ev of ["ai_suggestion", "remote_speech", "read_aloud"] as const) {
      const { item, promoted } = store.propose({
        id: `m-${ev}`,
        scope: "profile",
        workspace_id: null,
        session_id: null,
        kind: "fact",
        text: "Pengguna adalah insinyur senior",
        evidence: ev,
        source_refs: ["suggestion-1"],
        created_at: "2026-10-25T00:00:00Z",
      });
      assert.equal(promoted, false);
      assert.equal(item.status, "draft");
    }
    assert.equal(store.recall({ workspace_id: null, session_id: null, include_drafts: false }).length, 0);
  });

  it("explicit correction applies immediately and supersedes with history", () => {
    const store = new MemoryStore();
    store.propose({
      id: "m1",
      scope: "workspace",
      workspace_id: "w1",
      session_id: "s1",
      kind: "fact",
      text: "Nama proyek: Alpha",
      evidence: "user_confirmation",
      source_refs: ["user"],
      created_at: "2026-10-25T00:00:00Z",
    });
    const next = store.correct("m1", {
      id: "m2",
      scope: "workspace",
      workspace_id: "w1",
      session_id: "s1",
      kind: "fact",
      text: "Nama proyek: Beta",
      evidence: "user_correction",
      source_refs: ["user"],
      created_at: "2026-10-25T00:01:00Z",
    });
    assert.ok(next);
    assert.equal(store.get("m1")?.status, "superseded");
    const rolled = store.rollback("m1", "m3", "2026-10-25T00:02:00Z");
    assert.ok(rolled);
    assert.equal(rolled?.text, "Nama proyek: Alpha");
  });

  it("recall never leaks facts across workspaces", () => {
    const store = new MemoryStore();
    store.propose({
      id: "mw",
      scope: "workspace",
      workspace_id: "w-other",
      session_id: null,
      kind: "fact",
      text: "Rahasia proyek lain",
      evidence: "user_confirmation",
      source_refs: [],
      created_at: "2026-10-25T00:00:00Z",
    });
    assert.equal(store.recall({ workspace_id: "w1", session_id: "s1", include_drafts: false }).length, 0);
    assert.equal(store.recall({ workspace_id: "w-other", session_id: null, include_drafts: false }).length, 1);
  });
});
