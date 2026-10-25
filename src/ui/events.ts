// Streaming suggestion events. These are NOT frozen IPC commands (they are
// Tauri window events emitted by send_answer), so this file is hand-written
// and never overwritten by scripts/gen-ipc-types.mjs.
//
// P01 streams a deterministic fixture synthesis derived from the Send
// snapshot's committed remote finals. The `fixture: true` flag travels in
// every payload so no consumer can mistake it for a model call. P03 replaces
// both the Rust synthesizer and the fixture emitter below with real provider
// streaming; the event names and shapes stay stable.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { bridgeMode } from "./bridge.ts";

export interface SuggestionDelta {
  request_id: string;
  generation_id: string;
  index: number;
  text_delta: string;
  fixture: boolean;
}

export interface SuggestionDone {
  request_id: string;
  generation_id: string;
  suggestion_version: number;
  status: "done" | "cancelled";
  fixture: boolean;
}

/** Mirrors Rust synthesize_suggestion + 6-word chunking exactly. */
export function synthesizeSuggestion(remoteFinalTexts: string[], version: number): string {
  const joined = remoteFinalTexts.map((t) => t.trim()).filter((t) => t.length > 0).join(" ");
  const body = joined.split(/\s+/).filter((w) => w.length > 0).slice(0, 40).join(" ");
  const inner = body === "" ? "belum ada pertanyaan final yang terekam." : body;
  return `Draf jawaban v${version} (fixture): «${inner}»`;
}

export function chunkSuggestion(text: string, wordsPerChunk = 6): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const last = i + wordsPerChunk >= words.length;
    out.push(words.slice(i, i + wordsPerChunk).join(" ") + (last ? "" : " "));
  }
  return out;
}

type DeltaHandler = (d: SuggestionDelta) => void;
type DoneHandler = (d: SuggestionDone) => void;

// Fixture-mode emitter registry. The native path uses real window events;
// the fixture path (browser only) fans out to the same callbacks on timers.
const fixtureDeltaHandlers = new Set<DeltaHandler>();
const fixtureDoneHandlers = new Set<DoneHandler>();

export function emitFixtureSuggestion(
  requestId: string,
  generationId: string,
  version: number,
  remoteFinalTexts: string[],
): void {
  const text = synthesizeSuggestion(remoteFinalTexts, version);
  const chunks = chunkSuggestion(text);
  chunks.forEach((text_delta, index) => {
    setTimeout(() => {
      for (const h of fixtureDeltaHandlers) h({ request_id: requestId, generation_id: generationId, index, text_delta, fixture: true });
      if (index === chunks.length - 1) {
        const done: SuggestionDone = { request_id: requestId, generation_id: generationId, suggestion_version: version, status: "done", fixture: true };
        for (const h of fixtureDoneHandlers) h(done);
      }
    }, index * 40);
  });
}

export async function onSuggestionDelta(handler: DeltaHandler): Promise<UnlistenFn> {
  if (bridgeMode() === "fixture") {
    fixtureDeltaHandlers.add(handler);
    return () => {
      fixtureDeltaHandlers.delete(handler);
    };
  }
  return listen<SuggestionDelta>("suggestion-delta", (e) => handler(e.payload));
}

export async function onSuggestionDone(handler: DoneHandler): Promise<UnlistenFn> {
  if (bridgeMode() === "fixture") {
    fixtureDoneHandlers.add(handler);
    return () => {
      fixtureDoneHandlers.delete(handler);
    };
  }
  return listen<SuggestionDone>("suggestion-done", (e) => handler(e.payload));
}
