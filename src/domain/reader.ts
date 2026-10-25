// Local lexical voice-follow: advance the reading cursor from self speech.
// No LLM is involved. Remote speech never advances the cursor — callers pass
// only self transcript words; passing remote words is rejected.

export interface ScriptToken {
  index: number;
  /** Spoken-form word (citations/markdown stripped, normalized). */
  word: string;
  paragraph: number;
}

export type ReaderConfidence = "tracking" | "uncertain" | "off_script";

const FILLERS = new Set([
  "eh", "anu", "ya", "nah", "gitu", "dong", "sih", "kok", "nih", "tuh",
  "um", "uh", "erm", "like", "anyway",
]);

const DIGIT_WORDS: Record<string, string> = {
  satu: "1", dua: "2", tiga: "3", empat: "4", lima: "5", enam: "6", tujuh: "7",
  delapan: "8", sembilan: "9", sepuluh: "10", sebelas: "11",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};

export function normalizeWord(raw: string): string {
  let w = raw.toLowerCase().replace(/[“”"‘’'«»„()[\]{},.;:!?…—–\-/\\|@#$%^&*+=~`]/g, "");
  w = w.trim();
  if (w.length === 0) return "";
  // Indonesian numeric compounds: "duabelas" is rare in ASR output; handle spaced forms via digit map.
  return DIGIT_WORDS[w] ?? (/^\d+$/.test(w) ? String(Number(w)) : w);
}

/** Strip Markdown/citation/UI chrome to spoken words; keeps paragraph mapping. */
export function buildScript(markdown: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  const paragraphs = markdown.split(/\n\s*\n/);
  let index = 0;
  paragraphs.forEach((para, p) => {
    // Remove citations like [S01]/[1], headings markers, emphasis, code ticks, links keep text.
    const cleaned = para
      .replace(/\[[A-Za-z]*\d+\]/g, " ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`>#|-]/g, " ");
    for (const raw of cleaned.split(/\s+/)) {
      const w = normalizeWord(raw);
      if (w.length === 0 || FILLERS.has(w)) continue;
      tokens.push({ index: index++, word: w, paragraph: p });
    }
  });
  return tokens;
}

export interface CursorState {
  committed: number;
  tentative: number;
  confidence: ReaderConfidence;
}

const WINDOW_BACK = 10;
const WINDOW_FORWARD = 80;
const ANCHOR_MIN = 3;

export class ReaderCursor {
  committed = 0;
  tentative = 0;
  confidence: ReaderConfidence = "tracking";
  private stableRuns = 0;
  private unmatchedRuns = 0;
  private script: ScriptToken[];

  constructor(script: ScriptToken[]) {
    this.script = script;
  }

  get state(): CursorState {
    return { committed: this.committed, tentative: this.tentative, confidence: this.confidence };
  }

  /** Current script (read-only view for versioning decisions). */
  get tokens(): ScriptToken[] {
    return this.script;
  }

  /**
   * Swap in a rebuilt script (streaming growth or a new suggestion version)
   * without inventing movement: positions are clamped, never remapped.
   * Committed never moves here — only update()/seek() move it.
   */
  rescript(tokens: ScriptToken[]): void {
    this.script = tokens;
    this.committed = Math.min(this.committed, tokens.length);
    this.tentative = Math.min(this.tentative, tokens.length);
  }

  /**
   * Advance from newly transcribed self words. `isFinal` marks ASR-confirmed
   * text; partials move only the tentative cursor.
   */
  update(selfWords: string[], isFinal: boolean, role: "self" | "remote"): CursorState {
    if (role !== "self") return this.state; // remote speech never moves the cursor
    const words = selfWords.map(normalizeWord).filter((w) => w.length > 0 && !FILLERS.has(w));
    if (words.length === 0) return this.state;

    const base = this.committed;
    const lo = Math.max(0, base - WINDOW_BACK);
    const hi = Math.min(this.script.length, base + WINDOW_FORWARD);
    let bestPos = -1;
    let bestRun = 0;

    for (let s = lo; s < hi; s++) {
      let run = 0;
      for (let k = 0; k < words.length && s + k < hi; k++) {
        if (this.script[s + k]?.word === words[k]) run++;
        else break;
      }
      if (run > bestRun) {
        bestRun = run;
        bestPos = s;
      }
    }

    if (bestRun >= ANCHOR_MIN && bestPos >= 0) {
      const end = Math.min(bestPos + bestRun, this.script.length);
      // Backward jumps (repeats) are allowed only inside the back window with anchor evidence.
      this.tentative = end;
      this.unmatchedRuns = 0;
      if (isFinal) {
        this.stableRuns += 1;
      } else {
        this.stableRuns = Math.max(this.stableRuns, 1);
      }
      // Commit on final text, or when two consecutive updates agree on progress.
      if (isFinal || (this.stableRuns >= 2 && end >= this.committed)) {
        this.committed = Math.max(this.committed, end);
        if (!isFinal) this.stableRuns = 0;
        this.tentative = this.committed;
      }
      this.confidence = this.tentative === this.committed ? "tracking" : "uncertain";
    } else {
      this.unmatchedRuns += 1;
      this.stableRuns = 0;
      if (this.unmatchedRuns >= 3) this.confidence = "off_script";
    }
    return this.state;
  }

  /** Manual click sets both cursors; manual scroll pauses following (caller-owned). */
  seek(tokenIndex: number): CursorState {
    const clamped = Math.max(0, Math.min(tokenIndex, this.script.length));
    this.committed = clamped;
    this.tentative = clamped;
    this.confidence = "tracking";
    this.stableRuns = 0;
    this.unmatchedRuns = 0;
    return this.state;
  }
}

/**
 * Versioned reading session (T08): one stable cursor across script rebuilds.
 *
 * Streaming chunks and suggestion versions rebuild the token array, but the
 * already-read (committed) text is frozen: a new script keeps the cursor
 * only when the committed prefix survives verbatim, otherwise reading
 * restarts at zero. Same-version growth (streaming chunks) swaps the array
 * via rescript, so committed progress is never wiped mid-stream. Committed
 * still never moves backward except through an explicit seek.
 */
export class ReaderSession {
  private cursor: ReaderCursor | null = null;
  private version = 0;

  get state(): CursorState {
    return this.cursor?.state ?? { committed: 0, tentative: 0, confidence: "tracking" };
  }

  get scriptVersion(): number {
    return this.version;
  }

  ingestScript(tokens: ScriptToken[], version: number): void {
    if (this.cursor === null) {
      this.cursor = new ReaderCursor(tokens);
      this.version = version;
      return;
    }
    if (version === this.version) {
      this.cursor.rescript(tokens);
      return;
    }
    const old = this.cursor.tokens;
    const n = this.cursor.committed;
    const prefixKept =
      n <= tokens.length &&
      old.slice(0, n).every((t, i) => tokens[i]?.word === t.word && tokens[i]?.paragraph === t.paragraph);
    this.version = version;
    if (prefixKept) {
      this.cursor.rescript(tokens);
    } else {
      // A wholly new answer is a new reading: restart, visibly uncertain.
      this.cursor = new ReaderCursor(tokens);
      this.cursor.confidence = "uncertain";
    }
  }

  update(selfWords: string[], isFinal: boolean, role: "self" | "remote"): CursorState {
    if (this.cursor === null) return this.state;
    return this.cursor.update(selfWords, isFinal, role);
  }

  seek(tokenIndex: number): CursorState {
    if (this.cursor === null) return this.state;
    return this.cursor.seek(tokenIndex);
  }
}
