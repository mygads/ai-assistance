// T09: context packets never cite documents that were not imported into the
// workspace. retrieved_section / document_full items must carry source_refs
// that resolve against the workspace's imported document id set; other kinds
// (history, pinned briefs/facts, corrections) are out of scope here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSourceRefs, type ContextItem } from "./context.ts";

function item(id: string, kind: string, source_refs: string[]): ContextItem {
  return { id, kind, text: "x", source_refs, priority: 1 };
}

describe("validateSourceRefs", () => {
  it("accepts packets whose citations all resolve", () => {
    const items = [
      item("r1", "retrieved_section", ["doc-a"]),
      item("d1", "document_full", ["doc-b", "doc-a"]),
      item("h1", "history", ["seg-9"]),
    ];
    const v = validateSourceRefs(items, ["doc-a", "doc-b"]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.dangling, []);
    assert.deepEqual(v.missingSource, []);
  });

  it("flags refs to never-imported documents", () => {
    const items = [item("r1", "retrieved_section", ["doc-a", "doc-ghost"])];
    const v = validateSourceRefs(items, new Set(["doc-a"]));
    assert.equal(v.ok, false);
    assert.deepEqual(v.dangling, ["doc-ghost"]);
  });

  it("flags document items carried with no source at all", () => {
    const items = [item("r1", "retrieved_section", [])];
    const v = validateSourceRefs(items, ["doc-a"]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.missingSource, ["r1"]);
  });

  it("ignores source_refs on non-document kinds", () => {
    const items = [
      item("h1", "history", ["seg-9"]),
      item("p1", "pinned_fact", ["memory-1"]),
      item("c1", "correction", ["seg-2"]),
    ];
    const v = validateSourceRefs(items, []);
    assert.equal(v.ok, true);
  });

  it("accepts an empty packet", () => {
    const v = validateSourceRefs([], []);
    assert.equal(v.ok, true);
  });

  it("dedups repeated dangling refs", () => {
    const items = [
      item("r1", "retrieved_section", ["doc-ghost"]),
      item("r2", "retrieved_section", ["doc-ghost"]),
    ];
    const v = validateSourceRefs(items, []);
    assert.deepEqual(v.dangling, ["doc-ghost"]);
  });
});
