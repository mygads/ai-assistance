// T13 unit tests: the contamination guard and scoped recall behind the
// MemoryStore API (authoritative enforcement lives in store.rs / the store
// itself). Complements core.test.ts: session summaries never confirm,
// curated imports do, drafts stay hidden by default, and null-paths are safe.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, type EvidenceKind } from "./memory.ts";

const AT = "2026-10-25T00:00:00Z";

function propose(store: MemoryStore, over: { id?: string; evidence?: EvidenceKind; scope?: "profile" | "workspace" | "session" | "episodic"; workspace_id?: string | null; session_id?: string | null }) {
  return store.propose({
    id: over.id ?? "m",
    scope: over.scope ?? "workspace",
    workspace_id: over.workspace_id ?? "w1",
    session_id: over.session_id ?? "s1",
    kind: "fact",
    text: "teks fakta",
    evidence: over.evidence ?? "user_confirmation",
    source_refs: ["user"],
    created_at: AT,
  });
}

describe("contamination guard (C16)", () => {
  it("session summaries join suggestions as non-confirming evidence", () => {
    const store = new MemoryStore();
    const { item, promoted } = propose(store, { id: "m-sum", evidence: "session_summary" });
    assert.equal(promoted, false);
    assert.equal(item.status, "draft");
  });
  it("curated imports confirm, like explicit corrections", () => {
    const store = new MemoryStore();
    const { item, promoted } = propose(store, { id: "m-cur", evidence: "curated_import" });
    assert.equal(promoted, true);
    assert.equal(item.status, "confirmed");
  });
});

describe("draft visibility (A09)", () => {
  it("drafts are hidden unless explicitly included", () => {
    const store = new MemoryStore();
    propose(store, { id: "m-draft", evidence: "ai_suggestion" });
    assert.equal(store.recall({ workspace_id: "w1", session_id: "s1", include_drafts: false }).length, 0);
    assert.equal(store.recall({ workspace_id: "w1", session_id: "s1", include_drafts: true }).length, 1);
  });
  it("session scope isolates sessions within a workspace", () => {
    const store = new MemoryStore();
    propose(store, { id: "m-sess", scope: "session", session_id: "s1" });
    assert.equal(store.recall({ workspace_id: "w1", session_id: "s2", include_drafts: false }).length, 0);
    assert.equal(store.recall({ workspace_id: "w1", session_id: "s1", include_drafts: false }).length, 1);
  });
});

describe("supersede chain safety (C17)", () => {
  it("correct() on a missing id returns null instead of creating rows", () => {
    const store = new MemoryStore();
    assert.equal(
      store.correct("missing", {
        id: "m-new",
        scope: "workspace",
        workspace_id: "w1",
        session_id: "s1",
        kind: "fact",
        text: "x",
        evidence: "user_correction",
        source_refs: [],
        created_at: AT,
      }),
      null,
    );
  });
  it("rollback() on a non-superseded row returns null", () => {
    const store = new MemoryStore();
    propose(store, { id: "m-live" });
    assert.equal(store.rollback("m-live", "m-rb", AT), null);
    assert.equal(store.rollback("missing", "m-rb", AT), null);
  });
});
