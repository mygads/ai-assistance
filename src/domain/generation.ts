// Send snapshot + generation lifecycle.
// A snapshot is immutable: later transcripts append to session state but never
// mutate an in-flight prompt. Exactly one generation is active per request;
// late deltas from cancelled/superseded generations are ignored, never merged.

export type AnswerAction = "answer" | "shorten" | "expand" | "continue_unread" | "revise_unread";

export interface SendSnapshot {
  request_id: string;
  session_id: string;
  action: AnswerAction;
  snapshot_revision: number;
  cutoff_ms: number;
  /** Remote segment ids (+revisions) forming the question target. */
  target_segment_ids: string[];
  target_revisions: Record<string, number>;
  /** Relevant self segment ids (+revisions) attached as context. */
  self_segment_ids: string[];
  context_packet_id: string;
  model_profile_id: string;
  output_language: "id" | "en";
  answer_style: "spoken" | "bullets" | "detailed";
  provisional_segments: string[];
  /** Session-clock cursor of the reader when Send was pressed. */
  read_cursor_token: number;
}

export interface GenerationRecord {
  request_id: string;
  generation_id: string;
  suggestion_version: number;
  state: "active" | "completed" | "cancelled" | "failed";
  /** Text already shown on screen; preserved as interrupted content on cancel. */
  visible_text: string;
  deltas_applied: number;
  late_deltas_ignored: number;
}

export class GenerationRegistry {
  private records = new Map<string, GenerationRecord>();
  private activeRequestId: string | null = null;
  private generationSeq = 0;
  private versionSeq = 0;
  /** Fingerprints of completed answer requests for double-click dedup. */
  private seen = new Set<string>();

  static fingerprint(s: Omit<SendSnapshot, "request_id" | "context_packet_id">): string {
    return JSON.stringify([
      s.session_id,
      s.action,
      s.snapshot_revision,
      [...s.target_segment_ids].sort(),
      s.target_revisions,
      [...s.self_segment_ids].sort(),
      s.model_profile_id,
      s.output_language,
      s.answer_style,
      [...s.provisional_segments].sort(),
    ]);
  }

  /** Returns {duplicate:true} when an identical click was already answered. */
  start(snapshot: SendSnapshot, fingerprint: string): { duplicate: boolean; record: GenerationRecord } {
    if (this.seen.has(fingerprint)) {
      const existing = [...this.records.values()].find((r) => r.request_id === snapshot.request_id);
      if (existing) return { duplicate: true, record: existing };
    }
    this.generationSeq += 1;
    this.versionSeq += 1;
    const record: GenerationRecord = {
      request_id: snapshot.request_id,
      generation_id: `gen-${String(this.generationSeq).padStart(4, "0")}`,
      suggestion_version: this.versionSeq,
      state: "active",
      visible_text: "",
      deltas_applied: 0,
      late_deltas_ignored: 0,
    };
    // Starting a new generation supersedes the previous active one.
    if (this.activeRequestId && this.activeRequestId !== snapshot.request_id) {
      const prev = this.records.get(this.activeRequestId);
      if (prev && prev.state === "active") prev.state = "cancelled";
    }
    this.records.set(snapshot.request_id, record);
    this.activeRequestId = snapshot.request_id;
    this.seen.add(fingerprint);
    return { duplicate: false, record };
  }

  /** Applies a delta only when it belongs to the currently active generation. */
  applyDelta(request_id: string, text_delta: string): { applied: boolean; visible_text: string } {
    const rec = this.records.get(request_id);
    if (!rec || rec.state !== "active" || this.activeRequestId !== request_id) {
      if (rec) rec.late_deltas_ignored += 1;
      return { applied: false, visible_text: rec?.visible_text ?? "" };
    }
    rec.visible_text += text_delta;
    rec.deltas_applied += 1;
    return { applied: true, visible_text: rec.visible_text };
  }

  finish(request_id: string, ok: boolean): GenerationRecord | null {
    const rec = this.records.get(request_id);
    if (!rec) return null;
    rec.state = ok ? "completed" : "failed";
    if (this.activeRequestId === request_id) this.activeRequestId = null;
    return rec;
  }

  cancel(request_id: string): GenerationRecord | null {
    const rec = this.records.get(request_id);
    if (!rec) return null;
    if (rec.state === "active") rec.state = "cancelled";
    if (this.activeRequestId === request_id) this.activeRequestId = null;
    return rec;
  }

  get(request_id: string): GenerationRecord | undefined {
    return this.records.get(request_id);
  }
}
