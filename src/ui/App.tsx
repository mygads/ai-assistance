// Shell aplikasi: navigasi Dashboard ↔ Overlay + state sesi terangkat.
// Logika persiapan ada di dashboard.tsx, teleprompter di overlay.tsx.

import { useMemo, useState } from "react";
import { bridgeMode } from "./bridge.ts";
import { TranscriptStore, type TranscriptEvent } from "../domain/transcript.ts";
import type { SessionRecord } from "./ipc.ts";
import Dashboard, { type OutputLanguage } from "./dashboard.tsx";
import Overlay from "./overlay.tsx";

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
  const [language, setLanguage] = useState<OutputLanguage>("follow");
  const [error, setError] = useState<string>("");

  const store = useMemo(() => new TranscriptStore(), []);
  if (session) {
    for (const e of seedEvents(session.id)) store.upsert(e);
  }
  const finals = session ? store.finals(session.id) : [];

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 900 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Conversation Assistant</h1>
        <span data-testid="bridge-mode" style={{ fontSize: 12, border: "1px solid #888", padding: "2px 8px", borderRadius: 4 }}>
          bridge: {mode}
        </span>
        <nav style={{ marginLeft: "auto", display: "flex", gap: 8 }} aria-label="Navigasi utama">
          <button onClick={() => setView("dashboard")} aria-current={view === "dashboard"}>
            Dashboard
          </button>
          <button onClick={() => setView("overlay")} aria-current={view === "overlay"}>
            Overlay
          </button>
        </nav>
      </header>

      {view === "dashboard" && (
        <Dashboard
          session={session}
          finals={finals}
          persistedFinals={persistedFinals}
          language={language}
          onLanguageChange={setLanguage}
          onSessionChange={(s, persisted) => {
            setSession(s);
            setPersistedFinals(persisted);
          }}
          seedEventsFor={seedEvents}
          error={error}
          onError={setError}
        />
      )}

      {view === "overlay" && (
        <Overlay
          session={session}
          finals={finals}
          answerScript={SCRIPT_MD}
          language={language}
          onSessionChange={setSession}
          error={error}
          onError={setError}
        />
      )}
    </main>
  );
}

// Materi baku sebelum saran pertama di-stream. Setelah streaming, overlay
// memakai teks jawabannya sendiri sebagai naskah baca.
