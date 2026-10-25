// Overlay teleprompter (T07): mode ringkas + mode membaca.
// - Mode ringkas: dua label sumber, status transkripsi, status generasi, Kirim.
// - Mode membaca: pertanyaan singkat, naskah, reading band, follow/pause,
//   drawer transkrip + instruksi, aksi Kirim/Perbarui/Lanjutkan/Lebih singkat.
// Status transkripsi dan status generasi selalu ditampilkan terpisah.
// Fokus tidak pernah dipindah selama streaming (diuji di L2); drawer yang
// ditutup mengembalikan fokus ke tombol pembukanya. Scroll mengikuti
// prefers-reduced-motion. Klik token = seek manual (follow mati).

import { useEffect, useMemo, useRef, useState } from "react";
import { bridgeMode, cancelFixtureSuggestion, fixtureRemoteFinals } from "./bridge.ts";
import { emitFixtureSuggestion, onSuggestionDelta, onSuggestionDone } from "./events.ts";
import {
  cancel_answer,
  list_sources,
  pause_session,
  resume_session,
  seek_reader,
  send_answer,
  type AudioSource,
  type SendAnswerInput,
  type SessionRecord,
} from "./ipc.ts";
import { buildScript, ReaderSession, type ScriptToken } from "../domain/reader.ts";
import type { StoredSegment } from "../domain/transcript.ts";
import type { OutputLanguage } from "./dashboard.ts";

type OverlayMode = "compact" | "reading";
type SendAction = SendAnswerInput["action"];

const ACTION_LABEL: Record<SendAction, string> = {
  answer: "Kirim",
  revise_unread: "Perbarui",
  continue_unread: "Lanjutkan",
  shorten: "Lebih singkat",
  expand: "Lebih lengkap",
};

interface OverlayProps {
  session: SessionRecord | null;
  finals: StoredSegment[];
  answerScript: string;
  language: OutputLanguage;
  onSessionChange: (s: SessionRecord) => void;
  error: string;
  onError: (msg: string) => void;
}

export default function Overlay(props: OverlayProps) {
  const { session } = props;
  const mode = bridgeMode();
  const [overlayMode, setOverlayMode] = useState<OverlayMode>("reading");
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [answer, setAnswer] = useState("");
  const [answerMeta, setAnswerMeta] = useState("");
  const [genStatus, setGenStatus] = useState("idle");
  const [sending, setSending] = useState(false);
  const [follow, setFollow] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [, setCursorTick] = useState(0);
  // Satu sesi baca stabil untuk seluruh overlay (T08): chunk streaming dan
  // versi saran baru membangun ulang array token, tetapi committed yang
  // sudah dibaca dipertahankan selama prefiksnya bertahan. Versi naik
  // setiap Send; chunk dalam satu stream berbagi versi yang sama.
  const scriptVersionRef = useRef(0);
  const pendingRequest = useRef("");
  const activeRequest = useRef("");
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionRecord | null>(null);
  sessionRef.current = session;

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

  // Naskah yang dibaca = jawaban streaming terakhir, atau materi baku.
  // Versi saran dilacak scriptVersionRef: chunk dalam satu stream berbagi
  // versi yang sama sehingga committed tidak terhapus antar-chunk (T08).
  const scriptSource = answer === "" ? props.answerScript : answer;
  const script: ScriptToken[] = useMemo(() => buildScript(scriptSource), [scriptSource]);
  // Satu sesi baca stabil untuk seluruh overlay (T08): chunk streaming dan
  // versi saran baru membangun ulang array token, tetapi committed yang
  // sudah dibaca dipertahankan selama prefiksnya bertahan.
  const readerBox = useRef<ReaderSession | null>(null);
  if (!readerBox.current) readerBox.current = new ReaderSession();
  const reader = readerBox.current;
  reader.ingestScript(script, scriptVersionRef.current);
  const selfWords = useMemo(
    () =>
      props.finals
        .filter((f) => f.event.role === "self")
        .flatMap((f) => f.event.text.split(/\s+/)),
    [props.finals],
  );
  const selfKey = selfWords.join("\n");
  const lastSelfKey = useRef("");
  if (selfKey !== lastSelfKey.current) {
    lastSelfKey.current = selfKey;
    if (selfWords.length > 0) reader.update(selfWords, true, "self");
  }
  const readerState = reader.state;

  // Follow: gulir band ke tampilan saat committed maju; hormati reduced motion.
  useEffect(() => {
    if (!follow || readerState.committed === 0) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bandRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, [follow, readerState.committed]);

  async function send(action: SendAction) {
    const s = sessionRef.current;
    if (!s || sending) return;
    // Versi saran baru: naskah hasil stream berikutnya di-rebase, prefiks
    // yang sudah dibaca dipertahankan bila bertahan verbatim (T08).
    scriptVersionRef.current += 1;
    setSending(true);
    props.onError("");
    // Lanjutkan = sambung naskah; aksi lain = saran versi baru dari kosong.
    // (Per kontrak: materi belum dibaca yang direvisi menjadi versi baru.)
    if (action !== "continue_unread") setAnswer("");
    setAnswerMeta("");
    setGenStatus("streaming");
    pendingRequest.current = "";
    activeRequest.current = "";
    let settled = false;
    const unsubs: Array<() => void> = [];
    try {
      unsubs.push(
        await onSuggestionDelta((d) => {
          if (pendingRequest.current === "") pendingRequest.current = d.request_id;
          if (d.request_id !== pendingRequest.current) return;
          setAnswer((prev) => prev + d.text_delta);
        }),
      );
      unsubs.push(
        await onSuggestionDone((d) => {
          if (pendingRequest.current === "") pendingRequest.current = d.request_id;
          if (d.request_id !== pendingRequest.current || settled) return;
          settled = true;
          setAnswerMeta(`v${d.suggestion_version} · ${d.request_id.slice(0, 13)}`);
          setGenStatus(d.status === "cancelled" ? "cancelled" : `done v${d.suggestion_version}`);
          setSending(false);
          for (const u of unsubs) u();
        }),
      );
      const r = await send_answer({
        session_id: s.id,
        action,
        target_segment_ids: props.finals.filter((f) => f.event.role === "remote").map((f) => f.event.segment_id),
        ...(instruction.trim() !== "" ? { instruction: instruction.trim() } : {}),
        ...(props.language === "follow" ? {} : { output_language: props.language }),
      });
      pendingRequest.current = r.data.request_id;
      activeRequest.current = r.data.request_id;
      if (mode === "fixture") {
        emitFixtureSuggestion(r.data.request_id, r.data.generation_id, r.data.suggestion_version, fixtureRemoteFinals());
      }
      setTimeout(() => {
        if (!settled) {
          settled = true;
          setSending(false);
          setGenStatus((g) => (g === "streaming" ? "idle" : g));
          for (const u of unsubs) u();
        }
      }, 10000);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
      setSending(false);
      setGenStatus("idle");
      for (const u of unsubs) u();
    }
  }

  async function cancel() {
    const req = activeRequest.current;
    if (req === "") return;
    try {
      if (mode === "fixture") cancelFixtureSuggestion(req);
      else await cancel_answer(req);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    } finally {
      setSending(false);
      setGenStatus("cancelled");
      setAnswerMeta((m) => (m === "" ? "dibatalkan" : m));
    }
  }

  async function togglePause() {
    const s = sessionRef.current;
    if (!s) return;
    props.onError("");
    try {
      const r = s.capture === "live" ? await pause_session(s.id) : await resume_session(s.id);
      props.onSessionChange(r.data);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    }
  }

  async function seekToken(index: number) {
    const s = sessionRef.current;
    // Klik token = seek manual: follow mati, cursor pindah, bertahan.
    setFollow(false);
    reader.seek(index);
    setCursorTick((t) => t + 1);
    if (!s) return;
    try {
      await seek_reader({ session_id: s.id, token_index: index });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : JSON.stringify(e));
    }
  }

  function closeDrawer() {
    setDrawerOpen(false);
    // Satu-satunya pemindahan fokus yang disengaja: kembali ke pembuka drawer.
    drawerToggleRef.current?.focus();
  }

  if (!session) return <p>Belum ada sesi. Mulai sesi dari Dashboard.</p>;

  const question = [...props.finals].reverse().find((f) => f.event.role === "remote")?.event.text ?? "—";
  const bandText =
    readerState.committed === 0
      ? "—"
      : script
          .slice(0, readerState.committed)
          .map((t) => t.word)
          .join(" ");
  const transcription = `transkripsi ${session.capture === "live" ? "berjalan" : session.capture === "paused" ? "dijeda" : session.capture} · ${props.finals.length} segmen final`;

  return (
    <section aria-label="Overlay teleprompter">
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          data-testid="mode-toggle-compact"
          onClick={() => setOverlayMode("compact")}
          aria-pressed={overlayMode === "compact"}
        >
          Ringkas
        </button>
        <button
          data-testid="mode-toggle-reading"
          onClick={() => setOverlayMode("reading")}
          aria-pressed={overlayMode === "reading"}
        >
          Membaca
        </button>
      </div>

      {overlayMode === "compact" && (
        <div data-testid="overlay-mode-compact">
          <h2>Ringkas</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {(["self", "remote"] as const).map((role) => {
              const src = sources.find((x) => x.role === role);
              return (
                <li key={role} data-testid={role === "self" ? "compact-source-self" : "compact-source-remote"}>
                  {role === "self" ? "Mikrofon" : "Loopback"} · {src ? `${src.device_id} · ${src.enabled ? "aktif" : "nonaktif"}` : "memuat…"}
                </li>
              );
            })}
          </ul>
          <p data-testid="transcription-status" role="status">
            {transcription}
          </p>
          <p data-testid="generation-status" role="status">
            generasi {genStatus}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button data-testid="send-answer-compact" onClick={() => void send("answer")} aria-disabled={sending}>
              {sending ? "Mengirim…" : "Kirim"}
            </button>
            <button data-testid="pause-compact" onClick={() => void togglePause()}>
              {session.capture === "live" ? "Pause" : "Sambung"}
            </button>
          </div>
        </div>
      )}

      {overlayMode === "reading" && (
        <div data-testid="overlay-mode-reading">
          <h2>Naskah</h2>
          <p data-testid="latest-question">
            <strong>Tanya:</strong> {question}
          </p>
          <p data-testid="transcription-status" role="status">
            {transcription}
          </p>
          <p data-testid="generation-status" role="status">
            generasi {genStatus}
          </p>
          <p data-testid="reader-state">
            committed={readerState.committed} tentative={readerState.tentative} confidence={readerState.confidence}
          </p>
          <div ref={bandRef} data-testid="reading-band" style={{ border: "2px solid #1971c2", borderRadius: 6, padding: "8px 12px", margin: "8px 0" }}>
            <span style={{ fontSize: 12 }}>BAND BACA: </span>
            {bandText}
          </div>
          <div data-testid="script" style={{ fontSize: 22, lineHeight: 1.6, maxHeight: 320, overflowY: "auto" }}>
            {script.map((t) => (
              <span
                key={t.index}
                data-testid={`token-${t.index}`}
                onClick={() => void seekToken(t.index)}
                title={`Klik untuk lompat ke kata ${t.index + 1}`}
                style={{
                  cursor: "pointer",
                  background: t.index < readerState.committed ? "#d3f9d8" : t.index < readerState.tentative ? "#fff3bf" : "transparent",
                }}
              >
                {script[t.index]?.word ?? ""}{" "}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {(["answer", "revise_unread", "continue_unread", "shorten"] as const).map((a) => (
              <button
                key={a}
                data-testid={a === "answer" ? "send-answer" : `action-${a}`}
                onClick={() => void send(a)}
                // aria-disabled, bukan disabled: tombol yang sedang difokus
                // lalu menjadi disabled akan kehilangan fokus ke <body>.
                // Guard sending di send() yang menolak klik ganda.
                aria-disabled={sending}
              >
                {sending && a === "answer" ? "Mengirim…" : ACTION_LABEL[a]}
              </button>
            ))}
            <button data-testid="cancel-send" onClick={() => void cancel()} aria-disabled={!sending}>
              Batalkan
            </button>
            <button data-testid="follow-toggle" onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
              Follow: {follow ? "aktif" : "mati"}
            </button>
            <button data-testid="pause-toggle" onClick={() => void togglePause()} title="Jeda/sambung tangkapan sesi">
              {session.capture === "live" ? "Pause" : "Sambung"}
            </button>
            {answerMeta !== "" && <span data-testid="answer-meta">Saran {answerMeta}</span>}
          </div>
          <p data-testid="follow-state-text" style={{ fontSize: 12 }}>
            follow {follow ? "mengikuti" : "dijeda (klik Follow untuk lanjut)"} · klik kata pada naskah untuk seek manual
          </p>
          <div style={{ marginTop: 8 }}>
            <button ref={drawerToggleRef} data-testid="drawer-toggle" onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))} aria-expanded={drawerOpen}>
              {drawerOpen ? "Tutup transkrip" : "Buka transkrip"}
            </button>
          </div>
          {drawerOpen && (
            <div data-testid="transcript-drawer" role="region" aria-label="Transkrip dan instruksi" style={{ border: "1px solid #888", borderRadius: 6, padding: 12, marginTop: 8 }}>
              <h3>Transkrip sesi</h3>
              <ul>
                {props.finals.map((f) => (
                  <li key={f.event.segment_id}>
                    <strong>[{f.event.role}]</strong> {f.event.text}
                  </li>
                ))}
              </ul>
              <label htmlFor="instruction-input">Instruksi tambahan: </label>
              <input
                id="instruction-input"
                data-testid="instruction-input"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="mis. gunakan bahasa sederhana…"
                style={{ width: "100%", maxWidth: 480 }}
              />
            </div>
          )}
          {mode === "fixture" && <p style={{ fontSize: 12 }}>Mode fixture: browser saja, bukan bukti IPC native.</p>}
        </div>
      )}
      {props.error !== "" && <p role="alert">{props.error}</p>}
    </section>
  );
}
