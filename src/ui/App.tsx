// Shell aplikasi: navigasi Dashboard ↔ Overlay + state sesi terangkat + tema.
// Logika persiapan ada di dashboard.tsx, teleprompter di overlay.tsx.

import { useEffect, useMemo, useState } from "react";
import { bridgeMode } from "./bridge.ts";
import { TranscriptStore, type TranscriptEvent } from "../domain/transcript.ts";
import type { SessionRecord } from "./ipc.ts";
import Dashboard, { type OutputLanguage } from "./dashboard.tsx";
import Overlay from "./overlay.tsx";
import { AppIcon, MonitorIcon, MoonIcon, SunIcon } from "./icons.tsx";

const SCRIPT_MD = `Terima kasih atas pertanyaannya. Izinkan saya menjelaskan pendekatan kami dalam tiga bagian.

Pertama, kami memisahkan sumber audio agar atribusi tetap jelas. Kedua, transkripsi berjalan terus dan jawaban dibuat saat tombol Kirim ditekan. Ketiga, teleprompter mengikuti ucapan pengguna secara lokal.`;

type Theme = "light" | "dark";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("ca-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* penyimpanan tak tersedia: ikut sistem */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

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
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ca-theme", theme);
    } catch {
      /* abaikan: tema tetap berlaku untuk sesi ini */
    }
  }, [theme]);

  const store = useMemo(() => new TranscriptStore(), []);
  if (session) {
    for (const e of seedEvents(session.id)) store.upsert(e);
  }
  const finals = session ? store.finals(session.id) : [];

  return (
    <div className="ca-shell">
      <header className="ca-header">
        <div className="ca-brand">
          <span className="ca-brand-mark">
            <AppIcon size={22} />
          </span>
          <h1 className="ca-title">Conversation Assistant</h1>
        </div>
        <span data-testid="bridge-mode" className="ca-pill" title="Mode jembatan IPC">
          <span className="dot" />
          bridge: {mode}
        </span>
        <span className="ca-header-spacer" />
        <button
          type="button"
          data-testid="theme-toggle"
          className="ca-icon-btn"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          title={theme === "dark" ? "Ganti ke mode terang" : "Ganti ke mode gelap"}
          aria-label={theme === "dark" ? "Ganti ke mode terang" : "Ganti ke mode gelap"}
          aria-pressed={theme === "dark"}
        >
          {theme === "dark" ? <SunIcon size={17} /> : <MoonIcon size={17} />}
        </button>
        <nav className="ca-segmented" aria-label="Navigasi utama">
          <button type="button" onClick={() => setView("dashboard")} aria-current={view === "dashboard"}>
            <MonitorIcon size={15} />
            Dashboard
          </button>
          <button type="button" onClick={() => setView("overlay")} aria-current={view === "overlay"}>
            <AppIcon size={15} />
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
    </div>
  );
}

// Materi baku sebelum saran pertama di-stream. Setelah streaming, overlay
// memakai teks jawabannya sendiri sebagai naskah baca.
