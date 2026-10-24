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
const FIXTURE_SCRIPT =
  "Berikut ringkasan jawaban yang bisa diucapkan. Sesuaikan nada bicara dengan konteks percakapan.";

async function fixtureInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  switch (cmd) {
    case "start_session":
      return {
        id: "fixture-session-01",
        workspace_id: (args as { workspace_id: string }).workspace_id,
        capture: "live",
        generation: "idle",
        active_revision: 0,
      } as T;
    case "list_sources":
      return [
        { id: "fixture:self", session_id: "fixture-session-01", device_id: "fixture-mic", role: "self", enabled: true },
        { id: "fixture:remote", session_id: "fixture-session-01", device_id: "fixture-loopback", role: "remote", enabled: true },
      ] as T;
    case "send_answer":
      return { request_id: "req-fixture-1", generation_id: "gen-fixture-1", suggestion_version: 1 } as T;
    case "select_transcript_range":
      return [] as T;
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

export { FIXTURE_SCRIPT };
