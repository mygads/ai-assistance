// Transcript domain: normalized STT events, upsert store, session clock.
// Mirrors .agent/schemas/transcript-event.schema.json (contract v0.3).
// Partial replaces the prior hypothesis for the same (source, segment) identity;
// final commits it. Provider timestamps are remapped onto the session-monotonic
// clock through a per-connection offset established at (re)connect.

export type Role = "self" | "remote";
export type TranscriptStatus = "partial" | "final";

export interface WordTiming {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface TranscriptEvent {
  schema_version: "0.3";
  session_id: string;
  source_id: string;
  role: Role;
  connection_id: string;
  segment_id: string;
  revision: number;
  start_ms: number;
  end_ms: number;
  status: TranscriptStatus;
  text: string;
  language?: string | null;
  confidence?: number | null;
  words?: WordTiming[];
  /** Present only when a provider amends an already-final segment. */
  corrects_revision?: number;
}

export interface ConnectionClock {
  connection_id: string;
  /** provider_time_ms + offset_ms = session_time_ms */
  offset_ms: number;
}

export interface StoredSegment {
  event: TranscriptEvent;
  /** Session-clock start/end after offset mapping. */
  session_start_ms: number;
  session_end_ms: number;
  /** How many times this segment identity was upserted. */
  upserts: number;
}

export type UpsertOutcome = "inserted" | "replaced-hypothesis" | "committed" | "corrected" | "rejected-stale";

const SCHEMA_VERSION = "0.3" as const;

export function validateTranscriptEvent(e: TranscriptEvent): string[] {
  const errors: string[] = [];
  if (e.schema_version !== SCHEMA_VERSION) errors.push("schema_version must be 0.3");
  for (const f of ["session_id", "source_id", "connection_id", "segment_id"] as const) {
    if (typeof e[f] !== "string" || e[f].length === 0) errors.push(`${f} must be a non-empty string`);
  }
  if (e.role !== "self" && e.role !== "remote") errors.push("role must be self|remote");
  if (e.status !== "partial" && e.status !== "final") errors.push("status must be partial|final");
  if (!Number.isInteger(e.revision) || e.revision < 0) errors.push("revision must be a non-negative integer");
  if (!(e.start_ms >= 0) || !(e.end_ms >= e.start_ms)) errors.push("require 0 <= start_ms <= end_ms");
  if (typeof e.text !== "string") errors.push("text must be a string");
  if (e.confidence !== undefined && e.confidence !== null) {
    if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1) {
      errors.push("confidence must be within [0,1] when present; never fabricate it");
    }
  }
  for (const w of e.words ?? []) {
    if (!(w.start_ms >= 0) || !(w.end_ms >= w.start_ms)) errors.push("word timings must satisfy 0 <= start <= end");
  }
  return errors;
}

export class TranscriptStore {
  private segments = new Map<string, StoredSegment>();
  private clocks = new Map<string, ConnectionClock>();
  /** Highest committed (final) revision per segment identity. */
  private committed = new Map<string, number>();

  private static identity(session_id: string, source_id: string, segment_id: string): string {
    return `${session_id}\u0000${source_id}\u0000${segment_id}`;
  }

  /** Establish or reset the provider→session offset for a connection (call on connect/reconnect). */
  setConnectionOffset(connection_id: string, offset_ms: number): void {
    this.clocks.set(connection_id, { connection_id, offset_ms });
  }

  upsert(raw: TranscriptEvent): { outcome: UpsertOutcome; stored: StoredSegment | null; errors: string[] } {
    const errors = validateTranscriptEvent(raw);
    if (errors.length > 0) return { outcome: "rejected-stale", stored: null, errors };
    const key = TranscriptStore.identity(raw.session_id, raw.source_id, raw.segment_id);
    const offset = this.clocks.get(raw.connection_id)?.offset_ms ?? 0;
    const current = this.segments.get(key);

    if (current && raw.revision < current.event.revision) {
      return { outcome: "rejected-stale", stored: current, errors: [] };
    }
    if (current && raw.revision === current.event.revision && current.event.status === "final" && raw.status === "final") {
      // Duplicate delivery of the same final (e.g. reconnect replay): keep one copy.
      return { outcome: "rejected-stale", stored: current, errors: [] };
    }

    const stored: StoredSegment = {
      event: raw.words ? { ...raw, words: raw.words.map((w) => ({ ...w })) } : { ...raw },
      session_start_ms: raw.start_ms + offset,
      session_end_ms: raw.end_ms + offset,
      upserts: (current?.upserts ?? 0) + 1,
    };
    this.segments.set(key, stored);

    if (raw.status === "final") {
      const prevCommitted = this.committed.get(key);
      this.committed.set(key, raw.revision);
      if (prevCommitted !== undefined && raw.corrects_revision === prevCommitted) {
        return { outcome: "corrected", stored, errors: [] };
      }
      if (current && current.event.status === "partial") return { outcome: "committed", stored, errors: [] };
      if (current && current.event.status === "final") return { outcome: "corrected", stored, errors: [] };
      return { outcome: "inserted", stored, errors: [] };
    }
    return { outcome: current ? "replaced-hypothesis" : "inserted", stored, errors: [] };
  }

  /** Final segments only, ordered by session-clock start (overlap preserved). */
  finals(session_id: string): StoredSegment[] {
    return [...this.segments.values()]
      .filter((s) => s.event.session_id === session_id && s.event.status === "final")
      .sort((a, b) => a.session_start_ms - b.session_start_ms || a.session_end_ms - b.session_end_ms);
  }

  countFinalTextOccurrences(session_id: string, text: string): number {
    return this.finals(session_id).filter((s) => s.event.text === text).length;
  }

  get(session_id: string, source_id: string, segment_id: string): StoredSegment | undefined {
    return this.segments.get(TranscriptStore.identity(session_id, source_id, segment_id));
  }
}
