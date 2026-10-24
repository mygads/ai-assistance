import { useMemo, useState } from "react";
import { bridgeInvoke, bridgeMode, FIXTURE_SCRIPT, type SessionInfo } from "./bridge.ts";
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
    { ...base, source_id: "loop", role: "remote", segment_id: "remote-01", revision: 1, start_ms: 0, end_ms: 900, status: "final", text: "Mengapa memilih arsitektur ini?" },
    { ...base, source_id: "mic", role: "self", segment_id: "self-01", revision: 0, start_ms: 950, end_ms: 1400, status: "final", text: "Fokus saya adalah respons cepat." },
  ];
}

export default function App() {
  const mode = bridgeMode();
  const [view, setView] = useState<"dashboard" | "overlay">("dashboard");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>("");

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
      const r = await bridgeInvoke<SessionInfo>("start_session", { workspace_id: "default" });
      setSession(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function send() {
    if (!session || sending) return;
    setSending(true);
    setError("");
    try {
      const r = await bridgeInvoke<{ request_id: string }>("send_answer", {
        session_id: session.id,
        action: "answer",
        target_segment_ids: finals.filter((f) => f.event.role === "remote").map((f) => f.event.segment_id),
      });
      void r;
      // Fixture/non-streaming path shows the deterministic script; the real
      // streaming adapter (P03) replaces this with text_delta events.
      setAnswer((prev) => (prev === "" ? FIXTURE_SCRIPT : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
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
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button data-testid="send-answer" onClick={send} disabled={!session || sending}>
              {sending ? "Mengirim…" : "Kirim"}
            </button>
          </div>
          {mode === "fixture" && <p style={{ fontSize: 12 }}>Mode fixture: browser saja, bukan bukti IPC native.</p>}
        </section>
      )}
    </main>
  );
}
