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
import {
  BookIcon,
  CheckIcon,
  CpuIcon,
  DocIcon,
  GlobeIcon,
  LoopbackIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "./icons.tsx";

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
  const captureTone = session?.capture === "live" ? "is-ok" : session?.capture === "paused" ? "is-warn" : "is-info";
  const captureWord = session?.capture === "live" ? "berjalan" : session?.capture === "paused" ? "dijeda" : (session?.capture ?? "");

  return (
    <section aria-label="Dashboard persiapan">
      <div className="ca-card">
        <h2 className="ca-section-head">
          <PlayIcon size={16} />
          Sesi
        </h2>
        {!live ? (
          <button type="button" data-testid="start-session" className="ca-btn ca-btn-primary" onClick={start} disabled={busy}>
            <PlayIcon size={15} />
            {busy ? "Menyiapkan…" : "Mulai sesi"}
          </button>
        ) : (
          <div className="ca-status-row">
            <p data-testid="session-id" className="ca-status is-info" style={{ margin: 0 }}>
              <span className="dot" />
              Sesi {session.id} · tangkapan {session.capture}
            </p>
            {session.capture === "live" ? (
              <button type="button" data-testid="pause-session" className="ca-btn" onClick={() => void run(() => pause_session(session.id))} disabled={busy}>
                <PauseIcon size={15} />
                Jeda
              </button>
            ) : (
              <button type="button" data-testid="resume-session" className="ca-btn" onClick={() => void run(() => resume_session(session.id))} disabled={busy}>
                <PlayIcon size={15} />
                Lanjutkan sesi
              </button>
            )}
            <button type="button" data-testid="stop-session" className="ca-btn ca-btn-danger" onClick={() => void run(() => stop_session(session.id))} disabled={busy}>
              <StopIcon size={15} />
              Hentikan
            </button>
          </div>
        )}
        {session && (
          <p data-testid="capture-status" role="status" className={`ca-status ${captureTone}`} style={{ marginTop: 10 }}>
            <span className="dot" />
            Status transkripsi: {captureWord}
            {props.persistedFinals !== null && <> · {props.persistedFinals} segmen final tersimpan</>}
          </p>
        )}
      </div>

      <div className="ca-card">
        <h2 className="ca-section-head">
          <MicIcon size={16} />
          Audio
        </h2>
        {sources.length === 0 ? (
          <p className="ca-muted">Belum ada sumber. Mulai sesi untuk memuat dua jalur berlabel.</p>
        ) : (
          <ul className="ca-list">
            {sources.map((s) => (
              <li
                key={s.id}
                data-testid={s.role === "self" ? "source-label-self" : "source-label-remote"}
                className="ca-list-item"
              >
                {s.role === "self" ? <MicIcon size={16} /> : <LoopbackIcon size={16} />}
                <span className={`ca-role${s.role === "self" ? " is-self" : ""}`}>{s.role}</span>
                <span>
                  {s.role === "self" ? "Mikrofon pengguna" : "Loopback lawan bicara"} · peran {s.role} · perangkat {s.device_id} ·{" "}
                  {s.enabled ? "aktif" : "nonaktif"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="ca-muted">Meter suara live menyusul integrasi audio (T10). Label jalur tidak pernah dicampur sebelum atribusi.</p>
      </div>

      <div className="ca-card">
        <h2 className="ca-section-head">
          <CpuIcon size={16} />
          Model
        </h2>
        <div className="ca-input-row">
          <label className="ca-field" htmlFor="model-profile">
            Profil model
            <select
              id="model-profile"
              data-testid="model-profile"
              className="ca-input"
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
          </label>
        </div>
        {session && (
          <p data-testid="model-profile-saved" className="ca-status is-ok" style={{ marginTop: 10 }}>
            <CheckIcon size={14} />
            Profil model: {profile} · tersimpan (revisi {session.active_revision})
          </p>
        )}
        <p className="ca-muted">Anggaran live: tidak aktif — kunci provider belum dikonfigurasi (B02).</p>
      </div>

      <div className="ca-card">
        <h2 className="ca-section-head">
          <GlobeIcon size={16} />
          Bahasa jawaban
        </h2>
        <div className="ca-input-row">
          <label className="ca-field" htmlFor="language-lock">
            Kunci bahasa
            <select
              id="language-lock"
              data-testid="language-lock"
              className="ca-input"
              value={props.language}
              onChange={(e) => props.onLanguageChange(e.target.value as OutputLanguage)}
            >
              <option value="follow">Ikuti lawan bicara</option>
              <option value="id">Indonesia</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
      </div>

      <div className="ca-card">
        <h2 className="ca-section-head">
          <DocIcon size={16} />
          Materi
        </h2>
        <p data-testid="doc-count" role="status" className="ca-status" style={{ marginTop: 0 }}>
          <DocIcon size={14} />
          {docs.length} dokumen workspace
        </p>
        {docs.length > 0 && (
          <ul className="ca-list">
            {docs.map((d) => (
              <li key={d.id} className="ca-list-item">
                <DocIcon size={16} />
                {d.name} <span className="ca-muted">({d.id})</span>
              </li>
            ))}
          </ul>
        )}
        <div className="ca-input-row">
          <label className="ca-field" htmlFor="doc-name">
            Nama berkas
            <input
              id="doc-name"
              data-testid="doc-import-name"
              className="ca-input"
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              placeholder="materi.txt"
            />
          </label>
          <label className="ca-field" htmlFor="doc-text">
            Isi
            <input
              id="doc-text"
              data-testid="doc-import-text"
              className="ca-input"
              value={docText}
              onChange={(e) => setDocText(e.target.value)}
              placeholder="teks materi…"
              style={{ minWidth: 220 }}
            />
          </label>
          <button type="button" data-testid="doc-import-submit" className="ca-btn" onClick={() => void importDoc()} disabled={docName.trim() === ""}>
            <DocIcon size={15} />
            Lampirkan
          </button>
        </div>
        <p className="ca-muted">Pengambilan dan provenance menyusul di T09; di sini dokumen dilampirkan ke workspace.</p>
      </div>

      <div className="ca-card">
        <h2 className="ca-section-head">
          <BookIcon size={16} />
          Transkrip
        </h2>
        {props.persistedFinals !== null && (
          <p data-testid="persisted-count" className="ca-status is-info">
            <span className="dot" />
            Tersimpan {props.persistedFinals} segmen final
          </p>
        )}
        <ul data-testid="transcript-list" className="ca-list">
          {props.finals.map((f) => (
            <li key={f.event.segment_id} className="ca-list-item">
              <span className={`ca-role${f.event.role === "self" ? " is-self" : ""}`}>{f.event.role}</span>
              <span>{f.event.text}</span>
            </li>
          ))}
        </ul>
        {props.finals.length === 0 && <p className="ca-muted">Belum ada transkrip. Mulai sesi untuk memuat contoh.</p>}
      </div>
      {props.error !== "" && <p role="alert" className="ca-alert">{props.error}</p>}
    </section>
  );
}
