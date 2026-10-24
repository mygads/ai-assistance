// Session domain: three independent state machines plus revision/watermark.
// Capture, generation, and prompter evolve concurrently; there is intentionally
// no single LISTENING/ANSWERING global status.

export type CaptureState = "stopped" | "connecting" | "live" | "degraded" | "paused";
export type GenerationState = "idle" | "preparing_context" | "streaming" | "completed" | "cancelled" | "failed";
export type PrompterState = "inactive" | "tracking" | "off_script" | "paused_manual" | "reacquiring";

export interface Watermark {
  /** Furthest session-clock ms captured from the device/loopback. */
  captured_ms: number;
  /** Furthest session-clock ms covered by stored transcript (final or partial). */
  transcribed_ms: number;
}

export interface SessionSnapshotMeta {
  session_id: string;
  /** Monotonic revision; every committed change bumps it. In-flight prompts never mutate. */
  revision: number;
  cutoff_ms: number;
}

const CAPTURE_NEXT: Record<CaptureState, readonly CaptureState[]> = {
  stopped: ["connecting"],
  connecting: ["live", "degraded", "stopped"],
  live: ["degraded", "paused", "stopped"],
  degraded: ["connecting", "live", "stopped"],
  paused: ["live", "stopped"],
};

const GENERATION_NEXT: Record<GenerationState, readonly GenerationState[]> = {
  idle: ["preparing_context"],
  preparing_context: ["streaming", "cancelled", "failed"],
  streaming: ["completed", "cancelled", "failed"],
  completed: ["preparing_context"],
  cancelled: ["preparing_context"],
  failed: ["preparing_context"],
};

const PROMPTER_NEXT: Record<PrompterState, readonly PrompterState[]> = {
  inactive: ["tracking"],
  tracking: ["off_script", "paused_manual", "inactive"],
  off_script: ["reacquiring", "paused_manual", "inactive"],
  reacquiring: ["tracking", "off_script", "inactive"],
  paused_manual: ["tracking", "inactive"],
};

export class SessionMachines {
  capture: CaptureState = "stopped";
  generation: GenerationState = "idle";
  prompter: PrompterState = "inactive";
  revision = 0;
  watermarks = new Map<string, Watermark>();

  private bump(): number {
    this.revision += 1;
    return this.revision;
  }

  setCapture(next: CaptureState): { ok: boolean; revision: number } {
    if (!(CAPTURE_NEXT[this.capture] as readonly CaptureState[]).includes(next)) return { ok: false, revision: this.revision };
    this.capture = next;
    return { ok: true, revision: this.bump() };
  }

  setGeneration(next: GenerationState): { ok: boolean; revision: number } {
    // Terminal states (completed/cancelled/failed) start a new cycle only
    // through preparing_context; the table above already encodes this.
    if (!(GENERATION_NEXT[this.generation] as readonly GenerationState[]).includes(next)) {
      return { ok: false, revision: this.revision };
    }
    this.generation = next;
    return { ok: true, revision: this.bump() };
  }

  setPrompter(next: PrompterState): { ok: boolean; revision: number } {
    if (!(PROMPTER_NEXT[this.prompter] as readonly PrompterState[]).includes(next)) return { ok: false, revision: this.revision };
    this.prompter = next;
    return { ok: true, revision: this.bump() };
  }

  noteCapture(source_id: string, captured_ms: number): void {
    const w = this.watermarks.get(source_id) ?? { captured_ms: 0, transcribed_ms: 0 };
    w.captured_ms = Math.max(w.captured_ms, captured_ms);
    this.watermarks.set(source_id, w);
  }

  noteTranscribed(source_id: string, transcribed_ms: number): void {
    const w = this.watermarks.get(source_id) ?? { captured_ms: 0, transcribed_ms: 0 };
    w.transcribed_ms = Math.max(w.transcribed_ms, transcribed_ms);
    this.watermarks.set(source_id, w);
  }

  /** Session-clock ms of captured audio not yet covered by transcript. */
  lagMs(source_id: string): number {
    const w = this.watermarks.get(source_id);
    if (!w) return 0;
    return Math.max(0, w.captured_ms - w.transcribed_ms);
  }

  meta(session_id: string, cutoff_ms: number): SessionSnapshotMeta {
    return { session_id, revision: this.revision, cutoff_ms };
  }
}
