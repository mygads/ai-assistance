import { useMemo, useRef, useState } from "react";
import { bridgeMode, fixtureRemoteFinals } from "./bridge.ts";
import { ingest_transcript_event, select_transcript_range, send_answer, start_session, type SessionRecord } from "./ipc.ts";
import { emitFixtureSuggestion, onSuggestionDelta, onSuggestionDone } from "./events.ts";
import { TranscriptStore, type TranscriptEvent } from "../domain/transcript.ts";
import { buildScript, ReaderCursor } from "../domain/reader.ts";

const SCRIPT_MD = `Terima kasih atas pertanyaannya. Izinkan saya menjelaskan pendekatan kami dalam tiga bagian.

Pertama, kami memisahkan sumber audio agar atribusi tetap jelas. Kedua, transkripsi berjalan terus dan jawaban dibuat saat tombol Kirim ditekan. Ketiga, teleprompter mengikuti ucapan pengguna secara lokal.`;

function seedEvents(sessionId: string): TranscriptEvent[] {
  const base = {
    schema_version: "0.3",
    session_id: sessionId,
    connection_id: "conn-1",
  } as const;
  return [
    { ...base, source_id: `${sessionId}:remote`, role: "remote", segment_id: "remote-01", revision: 1, start_ms: 0, end_ms: 900, status: "final", text: "Mengapa memilih arsitektur ini?" },
    { ...base, source_id: `${sessionId}:self`, role: "self", segment_id: "self-01", revision: 0, start_ms: 950, end_ms: 1400, status: "final", text: "Fokus saya adalah respons cepat." },
  ];
}

export default function App() {
  const mode = bridgeMode();
  const [view, setView] = useState<"dashboard" | "overlay">("dashboard");
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [persistedFinals, setPersistedFinals] = useState<number | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [answerMeta, setAnswerMeta] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>("");
  const sessionRef = useRef<SessionRecord | null>(null);
  sessionRef.current = session;
  const pendingRequest = useRef<string>("");

  const store = useMemo(() => new TranscriptStore(), []);
  if (session) {
    for (const e of seedEvents(session.id)) store.upsert(e);
  }
  const finals = session ? store.finals(session.id) : [];
  const script = useMemo(() => buildScript(answer || SCRIPT_MD), [answer]);
  const cursor = useMemo(() => {
    const c = new ReaderCursor(script);
    const selfWords = finals.filter((f) => f.event.role === "self").flatMap((f) => f.event.text.split(/\s+/));
    if (selfWords.length > 0) c.update(selfWords, true, "self");
    return c.state;
  }, [script, finals, store]);

  async function start() {
    setError("");
    try {
      const r = await start_session({ workspace_id: "default" });
      const s = r.data;
      // Persist the seed transcript through the real ingest path so the
      // snapshot below is built from stored finals, not local constants.
      for (const e of seedEvents(s.id)) {
        await ingest_transcript_event({
          session_id: s.id,
          source_id: e.source_id,
          role: e.role,
          segment_id: e.segment_id,
          revision: e.revision,
          start_ms: e.start_ms,
          end_ms: e.end_ms,
          status: e.status,
          text: e.text,
        });
      }
      setSession(s);
      // Read back the persisted finals through real IPC: the dashboard count
      // below proves the DB roundtrip, not just the local in-memory store.
      const range = await select_transcript_range({ session_id: s.id });
      setPersistedFinals(range.data.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : JSON.stringify(e));
    }
  }

  async function send() {
    const s = sessionRef.current;
    if (!s || sending) return;
    setSending(true);
    setError("");
    setAnswer("");
    setAnswerMeta("");
    pendingRequest.current = "";
    // Subscribe before invoking: deltas stream from Rust window events in
    // native mode, from the fixture emitter in browser mode.
    let settled = false;
    const unsubs: Array<() => void> = [];
    try {
      unsubs.push(await onSuggestionDelta((d) => {
        // Sends are serialized by the sending flag, so the first delta of a
        // fresh send adopts its request id even if the invoke response that
        // assigns it has not arrived yet.
        if (pendingRequest.current === "") pendingRequest.current = d.request_id;
        if (d.request_id !== pendingRequest.current) return;
        setAnswer((prev) => prev + d.text_delta);
      }));
      unsubs.push(await onSuggestionDone((d) => {
        if (pendingRequest.current === "") pendingRequest.current = d.request_id;
        if (d.request_id !== pendingRequest.current || settled) return;
        settled = true;
        setAnswerMeta(`v${d.suggestion_version} · ${d.request_id.slice(0, 13)}`);
        setSending(false);
        for (const u of unsubs) u();
      }));
      const r = await send_answer({
        session_id: s.id,
        action: "answer",
        target_segment_ids: finals.filter((f) => f.event.role === "remote").map((f) => f.event.segment_id),
      });
      pendingRequest.current = r.data.request_id;
      if (mode === "fixture") {
        // Browser only: mirror the Rust synthesis rule over ingested texts.
        emitFixtureSuggestion(r.data.request_id, r.data.generation_id, r.data.suggestion_version, fixtureRemoteFinals());
      }
      // Safety: never leave the button stuck if the stream dies silently.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          setSending(false);
          for (const u of unsubs) u();
        }
      }, 10000);
    } catch (e) {
      setError(e instanceof Error ? e.message : JSON.stringify(e));
      setSending(false);
      for (const u of unsubs) u();
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 900 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Conversation Assistant</h1>
        <span data-testid="bridge-mode" style={{ fontSize: 12, border: "1px solid #888", padding: "2px 8px", borderRadius: 4 }}>
          bridge: {mode}
        </span>
        <nav style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setView("dashboard")}>Dashboard</button>
          <button onClick={() => setView("overlay")}>Overlay</button>
        </nav>
      </header>

      {view === "dashboard" && (
        <section>
          <h2>Sesi</h2>
          {!session ? (
            <button data-testid="start-session" onClick={start}>Mulai sesi</button>
          ) : (
            <p data-testid="session-id">Sesi {session.id} · capture {session.capture}</p>
          )}
          <h2>Transkrip</h2>
          {persistedFinals !== null && (
            <p data-testid="persisted-count">Tersimpan {persistedFinals} segmen final</p>
          )}
          <ul data-testid="transcript-list">
            {finals.map((f) => (
              <li key={f.event.segment_id}>
                <strong>[{f.event.role}]</strong> {f.event.text}
              </li>
            ))}
          </ul>
          {finals.length === 0 && <p>Belum ada transkrip. Mulai sesi untuk memuat contoh.</p>}
          {error !== "" && <p role="alert">{error}</p>}
        </section>
      )}

      {view === "overlay" && (
        <section>
          <h2>Naskah</h2>
          <p data-testid="reader-state">committed={cursor.committed} tentative={cursor.tentative} confidence={cursor.confidence}</p>
          <div data-testid="script" style={{ fontSize: 22, lineHeight: 1.6 }}>
            {script.map((t) => (
              <span
                key={t.index}
                style={{
                  background: t.index < cursor.committed ? "#d3f9d8" : t.index < cursor.tentative ? "#fff3bf" : "transparent",
                }}
              >
                {script[t.index]?.word ?? ""}{" "}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
            <button data-testid="send-answer" onClick={send} disabled={!session || sending}>
              {sending ? "Mengirim…" : "Kirim"}
            </button>
            {answerMeta !== "" && <span data-testid="answer-meta">Saran {answerMeta}</span>}
          </div>
          {mode === "fixture" && <p style={{ fontSize: 12 }}>Mode fixture: browser saja, bukan bukti IPC native.</p>}
        </section>
      )}
    </main>
  );
}
