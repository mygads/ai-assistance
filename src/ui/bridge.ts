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

/** Texts ingested through the fixture bridge, in order. Backs the fixture
 *  suggestion synthesis so the browser path mirrors the native snapshot rule. */
export function fixtureRemoteFinals(): string[] {
  return FIXTURE_FINALS.filter((f) => f.role === "remote").map((f) => f.text);
}

async function fixtureInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  // Generated wrappers always send either { session_id } or { input: {...} }.
  const input = (args as { input?: unknown } | undefined)?.input ?? args;
  switch (cmd) {
    case "start_session":
      FIXTURE_FINALS.length = 0;
      return {
        id: FIXTURE_SESSION,
        workspace_id: (input as { workspace_id: string }).workspace_id,
        capture: "live",
        generation: "idle",
        active_revision: 0,
      } as T;
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
    case "send_answer":
      return { request_id: "req-fixture-1", generation_id: "gen-fixture-1", suggestion_version: 1 } as T;
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

