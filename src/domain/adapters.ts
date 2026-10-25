// Provider adapter normalization (fixture-server <-> transcript-event).
// Provider messages NEVER reach React directly; they convert here into the
// frozen transcript-event shape (docs/CONTRACTS.md). Live network calls for
// real providers land in P03 (T11/T19); the live stubs below throw until keys
// and budgets are configured, which test:live reports as blocked, not pass.
import type { TranscriptEvent } from "./transcript.ts";

export type ProviderKind = "soniox" | "deepgram" | "fixture";

export interface ConnectionCtx {
  session_id: string;
  source_id: string;
  role: "self" | "remote";
  connection_id: string;
  /** Added to provider-clock ms to obtain session-monotonic ms. Reset per connection. */
  clock_offset_ms: number;
  segment_id: string;
  revision: number;
}

export interface NormalizedResult {
  event: TranscriptEvent;
  next_revision: number;
}

function base(ctx: ConnectionCtx, status: "partial" | "final", text: string, startMs: number, endMs: number): TranscriptEvent {
  return {
    schema_version: "0.3",
    session_id: ctx.session_id,
    source_id: ctx.source_id,
    role: ctx.role,
    connection_id: ctx.connection_id,
    segment_id: ctx.segment_id,
    revision: ctx.revision,
    start_ms: startMs,
    end_ms: endMs,
    status,
    text,
  };
}

// Soniox-like fixture shape: { segments: [{ text, start_ms, end_ms }], final: boolean }
export interface SonioxLikePayload {
  segments: Array<{ text: string; start_ms: number; end_ms: number }>;
  final: boolean;
}

// Deepgram-like fixture shape: { is_final, channel: { alternatives: [{ transcript, words: [{ word, start, end }] }] } }
export interface DeepgramLikePayload {
  is_final: boolean;
  channel: {
    alternatives: Array<{
      transcript: string;
      words?: Array<{ word: string; start: number; end: number }>;
    }>;
  };
}

export function normalizeSoniox(payload: SonioxLikePayload, ctx: ConnectionCtx, _atMs: number): NormalizedResult {
  if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
    throw new Error("soniox payload has no segments");
  }
  const text = payload.segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("soniox payload produced empty text");
  const starts = payload.segments.map((s) => s.start_ms);
  const ends = payload.segments.map((s) => s.end_ms);
  // Arrival (wall-clock) time lives on the replay envelope / store ingestion
  // record, not on the frozen TranscriptEvent (no at_ms field by contract).
  const event = base(
    ctx,
    payload.final ? "final" : "partial",
    text,
    Math.min(...starts) + ctx.clock_offset_ms,
    Math.max(...ends) + ctx.clock_offset_ms
  );
  return { event, next_revision: ctx.revision + 1 };
}

export function normalizeDeepgram(payload: DeepgramLikePayload, ctx: ConnectionCtx, _atMs: number): NormalizedResult {
  const alt = payload.channel?.alternatives?.[0];
  if (!alt || typeof alt.transcript !== "string" || !alt.transcript.trim()) {
    throw new Error("deepgram payload has no transcript alternative");
  }
  let startMs: number;
  let endMs: number;
  if (alt.words && alt.words.length > 0) {
    startMs = Math.min(...alt.words.map((w) => w.start)) * 1000;
    endMs = Math.max(...alt.words.map((w) => w.end)) * 1000;
  } else {
    startMs = 0;
    endMs = 0;
  }
  const event = base(
    ctx,
    payload.is_final ? "final" : "partial",
    alt.transcript.trim(),
    Math.round(startMs + ctx.clock_offset_ms),
    Math.round(endMs + ctx.clock_offset_ms)
  );
  return { event, next_revision: ctx.revision + 1 };
}

export function normalizeSttEvent(
  kind: ProviderKind,
  payload: SonioxLikePayload | DeepgramLikePayload | { text: string; start_ms: number; end_ms: number; status: "partial" | "final" },
  ctx: ConnectionCtx,
  atMs: number
): NormalizedResult {
  if (kind === "soniox") return normalizeSoniox(payload as SonioxLikePayload, ctx, atMs);
  if (kind === "deepgram") return normalizeDeepgram(payload as DeepgramLikePayload, ctx, atMs);
  const p = payload as { text: string; start_ms: number; end_ms: number; status: "partial" | "final" };
  if (typeof p.text !== "string" || !p.text.trim()) throw new Error("fixture payload has empty text");
  if (p.status !== "partial" && p.status !== "final") throw new Error("fixture payload has bad status");
  return {
    event: base(ctx, p.status, p.text, p.start_ms + ctx.clock_offset_ms, p.end_ms + ctx.clock_offset_ms),
    next_revision: ctx.revision + 1,
  };
}

// Live provider calls. Implemented against real APIs in T11/T19; until then
// they throw so test:live (which only runs with keys + opt-in) fails loudly
// instead of fabricating provider evidence.
export async function liveTranscribeWav(_wav: Uint8Array, _language: "id" | "en"): Promise<never> {
  throw new Error("live STT not configured: requires T11 adapter + provider keys + LIVE_TESTS_ENABLED");
}

export async function liveCompleteStream(_prompt: string, _modelProfile: string): Promise<never> {
  throw new Error("live LLM not configured: requires T11 adapter + provider keys + LIVE_TESTS_ENABLED");
}
