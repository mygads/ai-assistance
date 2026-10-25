// Provenance-preserving compaction (T14/A11): portable mirror of the Rust
// session_summaries rules. Compaction never deletes raw transcript or memory
// rows; a summary must cite original evidence (never only older summaries) and
// its coverage range must move forward, so background summarization cannot
// overwrite newer corrections.
import { buildContextPacket, type ContextItem, type ModelProfile } from "./context.ts";

/** A persisted per-range structured summary, mirroring the Rust row. */
export interface SessionSummary {
  id: string;
  session_id: string;
  /** Revision range this summary covers; ranges only move forward. */
  coverage_start_rev: number;
  coverage_end_rev: number;
  text: string;
  /** Original segment/memory refs; summary-only chains are rejected. */
  source_refs: string[];
}

/** Prefix for summary ids. A summary citing only sum-* refs is ungrounded. */
const SUMMARY_PREFIX = "sum-";

/** At least one ref must be original evidence, not another summary (C18). */
export function isGrounded(refs: string[]): boolean {
  return refs.some((r) => !r.startsWith(SUMMARY_PREFIX));
}

/** Coverage must be a non-empty range that does not move backward. */
export function validateCoverage(
  existingEndRev: number,
  startRev: number,
  endRev: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(startRev) || !Number.isInteger(endRev) || endRev <= startRev) {
    return { ok: false, reason: "coverage must be a non-empty revision range" };
  }
  if (endRev < existingEndRev) {
    return { ok: false, reason: "coverage moves backward over newer corrections" };
  }
  return { ok: true };
}

export interface RetentionSelection {
  /** Segment/memory ids that must survive any repack: active questions, corrections, confirmed facts. */
  mustKeepIds: string[];
  /** Summary items to carry, newest coverage first. */
  summaryItems: ContextItem[];
}

/**
 * Retention selection for a repack: active questions, corrections, and
 * confirmed memory are must-keep refs; structured summaries outrank raw
 * history (priority 50) so smaller profiles keep the summary and drop the
 * raw ranges it covers. Summary item ids use the sum- prefix so grounding
 * checks can tell summaries from original evidence.
 */
export function selectRetention(opts: {
  activeQuestionIds: string[];
  correctionIds: string[];
  confirmedMemoryIds: string[];
  summaries: SessionSummary[];
}): RetentionSelection {
  const mustKeepIds = [...new Set([...opts.activeQuestionIds, ...opts.correctionIds, ...opts.confirmedMemoryIds])];
  const summaryItems: ContextItem[] = [...opts.summaries]
    .sort((a, b) => b.coverage_end_rev - a.coverage_end_rev)
    .map((s) => ({
      id: `sum-${s.id}`,
      kind: "session_summary",
      text: s.text,
      source_refs: s.source_refs,
      priority: 50,
    }));
  return { mustKeepIds, summaryItems };
}

/**
 * A13 slice: repack the same sources for a smaller profile. Summaries and
 * must-keep refs survive; raw history drops first. Returns the repacked
 * packet plus the ids that must never be lost (asserted by the caller).
 */
export function repackWithSummaries(
  profile: ModelProfile,
  rawHistory: ContextItem[],
  retention: RetentionSelection,
): { packet: ReturnType<typeof buildContextPacket>; mustKeepIds: string[] } {
  const packet = buildContextPacket(`compact-${profile.id}`, profile, [...retention.summaryItems, ...rawHistory]);
  return { packet, mustKeepIds: retention.mustKeepIds };
}
