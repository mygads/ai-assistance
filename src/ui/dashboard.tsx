// Dashboard persiapan sesi (T07): halaman kesiapan sebelum live.
// Menampilkan label kedua sumber audio, status tangkapan, profil model,
// kunci bahasa, materi workspace, dan tombol utama Mulai sesi.
// Tidak ada meter suara palsu: level audio live menyusul integrasi T10;
// yang ditampilkan adalah label + status yang nyata dari perintah beku.

import { useEffect, useState } from "react";
import {
  import_document,
  ingest_transcript_event,
  list_sources,
  pause_session,
  resume_session,
  select_model_profile,
  select_transcript_range,
  start_session,
  stop_session,
  type AudioSource,
  type SessionRecord,
} from "./ipc.ts";
import type { StoredSegment, TranscriptEvent } from "../domain/transcript.ts";

export type OutputLanguage = "follow" | "id" | "en";

const MODEL_PROFILES = ["profil-hemat", "profil-seimbang", "profil-detail"];

/** Profil model aktif dari settings_snapshot sesi (dipersisten native). */
export function modelProfileOf(session: SessionRecord | null): string {
  if (!session) return "profil-seimbang";
  try {
    const s = JSON.parse(session.settings_snapshot) as { model_profile_id?: unknown };
    return typeof s.model_profile_id === "string" ? s.model_profile_id : "profil-seimbang";
  } catch {
    return "profil-seimbang";
  }
}

interface DashboardProps {
  session: SessionRecord | null;
  finals: StoredSegment[];
  persistedFinals: number | null;
  language: OutputLanguage;
  onLanguageChange: (l: OutputLanguage) => void;
  onSessionChange: (s: SessionRecord | null, persisted: number | null) => void;
  seedEventsFor: (sessionId: string) => TranscriptEvent[];
  error: string;
  onError: (msg: string) => void;
}

export default function Dashboard(props: DashboardProps) {
  const { session } = props;
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docName, setDocName] = useState("");
  const [docText, setDocText] = useState("");

  // Muat label sumber begitu sesi ada: dua jalur berlabel, tidak pernah campur.
  useEffect(() => {
    let cancelled = false;
    if (!session) {
      setSources([]);
      return;
    }
    list_sources(session.id)
      .then((r) => {
        if (!cancelled) setSources(r.data);
      })
      .catch((e) => {
        if (!cancelled) props.onError(e instanceof Error ? e.message : JSON.stringify(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  async function start() {
    props.onError("");
    setBusy(true);
    try {
      const r = await start_session({ workspace_id: "default" });
      const s = r.data;
      for (const e of props.seedEventsFor(s.id)) {
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
      // Baca balik final yang tersimpan lewat IPC nyata: angka dashboard
      // membuktikan roundtrip DB, bukan store lokal.
      const range = await select_transcript_range({ session_id: s.id });
      props.onSessionChange(s, range.data.length);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<{ data: SessionRecord }>) {
    props.onError("");
    setBusy(true);
    try {
      const r = await fn();
      props.onSessionChange(r.data, props.persistedFinals);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeProfile(model_profile_id: string) {
    if (!session) return;
    props.onError("");
    try {
      const r = await select_model_profile({ session_id: session.id, model_profile_id });
      props.onSessionChange(r.data, props.persistedFinals);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    }
  }

  async function importDoc() {
    if (docName.trim() === "") return;
    props.onError("");
    try {
      const r = await import_document({ workspace_id: "default", file_name: docName.trim(), content_text: docText });
      setDocs((prev) => [...prev, { id: r.data, name: docName.trim() }]);
      setDocName("");
      setDocText("");
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    }
  }

  const live = session !== null && session.capture !== "stopped";
  const profile = modelProfileOf(session);

  return (
    <section aria-label="Dashboard persiapan">
      <h2>Sesi</h2>
      {!live ? (
        <button data-testid="start-session" onClick={start} disabled={busy}>
          {busy ? "Menyiapkan…" : "Mulai sesi"}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <p data-testid="session-id" style={{ margin: 0 }}>
            Sesi {session.id} · tangkapan {session.capture}
          </p>
          {session.capture === "live" ? (
            <button data-testid="pause-session" onClick={() => void run(() => pause_session(session.id))} disabled={busy}>
              Jeda
            </button>
          ) : (
            <button data-testid="resume-session" onClick={() => void run(() => resume_session(session.id))} disabled={busy}>
              Lanjutkan sesi
            </button>
          )}
          <button data-testid="stop-session" onClick={() => void run(() => stop_session(session.id))} disabled={busy}>
            Hentikan
          </button>
        </div>
      )}
      {session && (
        <p data-testid="capture-status" role="status">
          Status transkripsi: {session.capture === "live" ? "berjalan" : session.capture === "paused" ? "dijeda" : session.capture}
          {props.persistedFinals !== null && <> · {props.persistedFinals} segmen final tersimpan</>}
        </p>
      )}

      <h2>Audio</h2>
      {sources.length === 0 ? (
        <p>Belum ada sumber. Mulai sesi untuk memuat dua jalur berlabel.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {sources.map((s) => (
            <li
              key={s.id}
              data-testid={s.role === "self" ? "source-label-self" : "source-label-remote"}
              style={{ border: "1px solid #888", borderRadius: 4, padding: "6px 10px", marginBottom: 6 }}
            >
              {s.role === "self" ? "Mikrofon pengguna" : "Loopback lawan bicara"} · peran {s.role} · perangkat {s.device_id} ·{" "}
              {s.enabled ? "aktif" : "nonaktif"}
            </li>
          ))}
        </ul>
      )}
      <p style={{ fontSize: 12 }}>Meter suara live menyusul integrasi audio (T10). Label jalur tidak pernah dicampur sebelum atribusi.</p>

      <h2>Model</h2>
      <label htmlFor="model-profile">Profil model: </label>
      <select
        id="model-profile"
        data-testid="model-profile"
        value={profile}
        disabled={!live}
        onChange={(e) => void changeProfile(e.target.value)}
      >
        {MODEL_PROFILES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      {session && <p data-testid="model-profile-saved">Profil model: {profile} · tersimpan (revisi {session.active_revision})</p>}
      <p style={{ fontSize: 12 }}>Anggaran live: tidak aktif — kunci provider belum dikonfigurasi (B02).</p>

      <h2>Bahasa jawaban</h2>
      <label htmlFor="language-lock">Kunci bahasa: </label>
      <select
        id="language-lock"
        data-testid="language-lock"
        value={props.language}
        onChange={(e) => props.onLanguageChange(e.target.value as OutputLanguage)}
      >
        <option value="follow">Ikuti lawan bicara</option>
        <option value="id">Indonesia</option>
        <option value="en">English</option>
      </select>

      <h2>Materi</h2>
      <p data-testid="doc-count" role="status">
        {docs.length} dokumen workspace
      </p>
      <ul>
        {docs.map((d) => (
          <li key={d.id}>
            {d.name} <span style={{ fontSize: 12 }}>({d.id})</span>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label htmlFor="doc-name" style={{ fontSize: 12 }}>
          Nama berkas
        </label>
        <input
          id="doc-name"
          data-testid="doc-import-name"
          value={docName}
          onChange={(e) => setDocName(e.target.value)}
          placeholder="materi.txt"
        />
        <label htmlFor="doc-text" style={{ fontSize: 12 }}>
          Isi
        </label>
        <input
          id="doc-text"
          data-testid="doc-import-text"
          value={docText}
          onChange={(e) => setDocText(e.target.value)}
          placeholder="teks materi…"
        />
        <button data-testid="doc-import-submit" onClick={() => void importDoc()} disabled={docName.trim() === ""}>
          Lampirkan
        </button>
      </div>
      <p style={{ fontSize: 12 }}>Pengambilan dan provenance menyusul di T09; di sini dokumen dilampirkan ke workspace.</p>

      <h2>Transkrip</h2>
      {props.persistedFinals !== null && <p data-testid="persisted-count">Tersimpan {props.persistedFinals} segmen final</p>}
      <ul data-testid="transcript-list">
        {props.finals.map((f) => (
          <li key={f.event.segment_id}>
            <strong>[{f.event.role}]</strong> {f.event.text}
          </li>
        ))}
      </ul>
      {props.finals.length === 0 && <p>Belum ada transkrip. Mulai sesi untuk memuat contoh.</p>}
      {props.error !== "" && <p role="alert">{props.error}</p>}
    </section>
  );
}
