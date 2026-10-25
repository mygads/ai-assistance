// T14 unit tests: compaction keeps durable evidence (A11) and repacks it for
// smaller profiles (A13 slice). Mirrors the Rust session_summaries rules:
// grounded refs only, forward-moving coverage, summaries outrank raw history.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGrounded,
  repackWithSummaries,
  selectRetention,
  validateCoverage,
  type SessionSummary,
} from "./compaction.ts";
import type { ContextItem } from "./context.ts";

const HEMAT = { id: "hemat", provider: "fixture", model: "hemat", context_limit: 2000, input_limit: 2000, output_limit: 500, streaming: true };
const DETAIL = { id: "detail", provider: "fixture", model: "detail", context_limit: 12000, input_limit: 12000, output_limit: 4000, streaming: true };

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  session_id: "sess",
  coverage_start_rev: 0,
  coverage_end_rev: 10,
  text: "Ringkasan: pengguna bertanya tentang arsitektur.",
  source_refs: ["seg-1", "seg-2"],
  ...over,
});

describe("isGrounded (C18)", () => {
  it("accepts summaries citing original segments or memory", () => {
    assert.equal(isGrounded(["seg-1", "sum-old"]), true);
    assert.equal(isGrounded(["mem-1"]), true);
  });
  it("rejects summary-of-summary chains and empty refs", () => {
    assert.equal(isGrounded(["sum-old", "sum-older"]), false);
    assert.equal(isGrounded([]), false);
  });
});

describe("validateCoverage", () => {
  it("accepts forward-moving non-empty ranges", () => {
    assert.deepEqual(validateCoverage(0, 0, 10), { ok: true });
    assert.deepEqual(validateCoverage(10, 10, 25), { ok: true });
  });
  it("rejects empty ranges and backward moves", () => {
    assert.equal(validateCoverage(0, 5, 5).ok, false);
    assert.equal(validateCoverage(0, 8, 3).ok, false);
    assert.equal(validateCoverage(20, 0, 10).ok, false);
  });
});

describe("selectRetention + repackWithSummaries (A11/A13)", () => {
  const big = (id: string, n: number): ContextItem => ({
    id, kind: "history", text: "kata ".repeat(n), source_refs: [id], priority: 1,
  });
  it("keeps the summary and drops raw history on a small profile", () => {
    const retention = selectRetention({
      activeQuestionIds: ["seg-q"],
      correctionIds: ["seg-c"],
      confirmedMemoryIds: ["mem-1"],
      summaries: [summary()],
    });
    assert.deepEqual(retention.mustKeepIds.sort(), ["mem-1", "seg-c", "seg-q"]);
    const { packet } = repackWithSummaries(HEMAT, [big("h1", 600), big("h2", 600)], retention);
    const ids = packet.items.map((i) => i.id);
    assert.ok(ids.includes("sum-s1"), `summary survives hemat repack: ${ids}`);
    assert.ok(packet.dropped_item_ids.length > 0, "raw history drops under hemat");
    assert.ok(packet.estimated_input_tokens <= packet.budget_input_tokens, "within budget");
  });
  it("recovers dropped raw history on the larger profile from the same sources", () => {
    const retention = selectRetention({ activeQuestionIds: [], correctionIds: [], confirmedMemoryIds: [], summaries: [summary()] });
    const raw = [big("h1", 200), big("h2", 200)];
    const small = repackWithSummaries(HEMAT, raw, retention).packet;
    const large = repackWithSummaries(DETAIL, raw, retention).packet;
    assert.ok(large.items.length >= small.items.length, "detail keeps at least what hemat kept");
    assert.ok(large.items.some((i) => i.id === "sum-s1"), "summary present on detail too");
  });
  it("orders newest coverage first", () => {
    const retention = selectRetention({
      activeQuestionIds: [], correctionIds: [], confirmedMemoryIds: [],
      summaries: [summary({ id: "old", coverage_end_rev: 5 }), summary({ id: "new", coverage_end_rev: 30 })],
    });
    assert.deepEqual(retention.summaryItems.map((i) => i.id), ["sum-new", "sum-old"]);
  });
});
