// Native bridge: real Tauri IPC when the app runs inside Tauri, otherwise a
// clearly labeled fixture bridge for browser development (L2 only).
// The fixture bridge is NEVER proof of native IPC (see docs/TESTING.md).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type BridgeMode = "native" | "fixture";

export function bridgeMode(): BridgeMode {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "native" : "fixture";
}

export interface SessionInfo {
  id: string;
  workspace_id: string;
  capture: string;
  generation: string;
  active_revision: number;
}

export interface AnswerResult {
  request_id: string;
  generation_id: string;
  suggestion_version: number;
}

// Deterministic fixture answers for browser-only development.
const FIXTURE_SESSION = "fixture-session-01";
const FIXTURE_FINALS: Array<{ role: string; text: string }> = [];
let FIXTURE_SEND_SEQ = 0;
let FIXTURE_DOC_SEQ = 0;
const FIXTURE_CANCELLED = new Set<string>();
const FIXTURE_REC = {
  id: FIXTURE_SESSION,
  workspace_id: "default",
  started_at: new Date(0).toISOString(),
  active_revision: 0,
  capture: "connecting",
  generation: "idle",
  prompter: "inactive",
  settings_snapshot: JSON.stringify({ workspace_id: "default", profile_id: null }),
};

/** Texts ingested through the fixture bridge, in order. Backs the fixture
 *  suggestion synthesis so the browser path mirrors the native snapshot rule. */
export function fixtureRemoteFinals(): string[] {
  return FIXTURE_FINALS.filter((f) => f.role === "remote").map((f) => f.text);
}

/** Request ids cancelled through the fixture bridge. The timed emitter below
 *  checks this set before every chunk so a cancel stops the visible stream. */
export function cancelFixtureSuggestion(requestId: string): void {
  FIXTURE_CANCELLED.add(requestId);
}

export function isFixtureCancelled(requestId: string): boolean {
  return FIXTURE_CANCELLED.has(requestId);
}

async function fixtureInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  // Generated wrappers always send either { session_id } or { input: {...} }.
  const input = (args as { input?: unknown } | undefined)?.input ?? args;
  switch (cmd) {
    case "start_session":
      FIXTURE_FINALS.length = 0;
      FIXTURE_SEND_SEQ = 0;
      FIXTURE_CANCELLED.clear();
      FIXTURE_REC.workspace_id = (input as { workspace_id: string }).workspace_id;
      FIXTURE_REC.active_revision = 0;
      FIXTURE_REC.capture = "live";
      FIXTURE_REC.generation = "idle";
      return { ...FIXTURE_REC } as T;
    case "ingest_transcript_event": {
      const e = input as { role: string; status: string; text: string };
      if (e.status === "final") FIXTURE_FINALS.push({ role: e.role, text: e.text });
      return { outcome: "inserted", stored: true } as T;
    }
    case "list_sources":
      return [
        { id: "fixture:self", session_id: "fixture-session-01", device_id: "fixture-mic", role: "self", enabled: true },
        { id: "fixture:remote", session_id: "fixture-session-01", device_id: "fixture-loopback", role: "remote", enabled: true },
      ] as T;
    case "send_answer": {
      FIXTURE_SEND_SEQ += 1;
      return {
        request_id: `req-fixture-${FIXTURE_SEND_SEQ}`,
        generation_id: `gen-fixture-${FIXTURE_SEND_SEQ}`,
        suggestion_version: FIXTURE_SEND_SEQ,
      } as T;
    }
    case "pause_session":
      FIXTURE_REC.capture = "paused";
      FIXTURE_REC.active_revision += 1;
      return { ...FIXTURE_REC } as T;
    case "resume_session":
      FIXTURE_REC.capture = "live";
      FIXTURE_REC.active_revision += 1;
      return { ...FIXTURE_REC } as T;
    case "stop_session":
      FIXTURE_REC.capture = "stopped";
      FIXTURE_REC.active_revision += 1;
      return { ...FIXTURE_REC } as T;
    case "cancel_answer":
      FIXTURE_CANCELLED.add((input as { request_id: string }).request_id);
      return true as T;
    case "select_model_profile": {
      const settings = JSON.parse(FIXTURE_REC.settings_snapshot) as Record<string, unknown>;
      settings["model_profile_id"] = (input as { model_profile_id: string }).model_profile_id;
      FIXTURE_REC.settings_snapshot = JSON.stringify(settings);
      FIXTURE_REC.active_revision += 1;
      return { ...FIXTURE_REC } as T;
    }
    case "seek_reader":
      return (input as { token_index: number }).token_index as T;
    case "import_document":
      FIXTURE_DOC_SEQ += 1;
      return `doc-fixture-${FIXTURE_DOC_SEQ}` as T;
    case "select_transcript_range":
      return [...FIXTURE_FINALS] as T;
    default:
      throw new Error(`fixture bridge has no implementation for ${cmd}`);
  }
}

export async function bridgeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<{ mode: BridgeMode; data: T }> {
  const mode = bridgeMode();
  if (mode === "native") {
    return { mode, data: await tauriInvoke<T>(cmd, args) };
  }
  return { mode, data: await fixtureInvoke<T>(cmd, args) };
}

