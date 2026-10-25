# ADR-014: ingest_transcript_event command (T03 vertical slice)

Status: accepted (2026-10-25, coordinator, T03).

## Context

P01 requires the slice "replay self+remote → persisted transcript → click Send →
actual Rust context snapshot". The frozen 12-command surface (P00) has no write
path for transcript segments: `select_transcript_range` reads, `save_correction`
amends, but nothing persists STT output. Without an ingest path, `send_answer`
snapshots an empty database in every native run, and the "actual Rust context
snapshot" acceptance cannot be proven.

## Decision

Add one command, `ingest_transcript_event`, owned by the same contract rules:

- Input: `{ session_id, source_id, role ("self"|"remote"), segment_id, revision,
  start_ms, end_ms, status ("partial"|"final"), text }`.
- Behavior mirrors the TypeScript `TranscriptStore` revision discipline:
  partial replaces hypothesis, final commits, stale/duplicate writes are
  rejected without touching the committed row. Returns
  `{ outcome: "inserted"|"replaced-hypothesis"|"committed"|"stale-ignored",
  stored: boolean }`.
- Source rows are created per `(session_id, source_id)` on first ingest. A
  source id claimed with a different role than recorded is a `Conflict`:
  the two audio paths are never mixed before attribution.
- Returns validation errors as `InvalidInput` before any write, same as the
  `TranscriptSegment::validate` rules already unit-tested in T01.

## Consequences

- Frozen contract grows 12 → 13 commands; `src/ui/ipc.ts` regenerated.
- `save_correction` amends rows ingested this way (correction = new final
  revision + provenance marker, distinct from original speech).
- P02 provider lanes reuse this command for real STT output; no second
  ingest path will be added.
- The deterministic P01 suggestion synthesizer reads only committed finals,
  so partials can never leak into a snapshot.
