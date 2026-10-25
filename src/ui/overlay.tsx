// Overlay teleprompter (T07): mode ringkas + mode membaca.
// - Mode ringkas: dua label sumber, status transkripsi, status generasi, Kirim.
// - Mode membaca: pertanyaan singkat, naskah, reading band, follow/pause,
//   drawer transkrip + instruksi, aksi Kirim/Perbarui/Lanjutkan/Lebih singkat.
// Status transkripsi dan status generasi selalu ditampilkan terpisah.
// Fokus tidak pernah dipindah selama streaming (diuji di L2); drawer yang
// ditutup mengembalikan fokus ke tombol pembukanya. Scroll mengikuti
// prefers-reduced-motion. Klik token = seek manual (follow mati).

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
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
import {
  BookIcon,
  CancelIcon,
  ContinueIcon,
  FollowIcon,
  LoopbackIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  SendIcon,
  ShortenIcon,
  SparkleIcon,
} from "./icons.tsx";

type OverlayMode = "compact" | "reading";
type SendAction = SendAnswerInput["action"];

const ACTION_LABEL: Record<SendAction, string> = {
  answer: "Kirim",
  revise_unread: "Perbarui",
  continue_unread: "Lanjutkan",
  shorten: "Lebih singkat",
  expand: "Lebih lengkap",
};

const ACTION_ICON: Record<SendAction, (props: { size?: number }) => JSX.Element> = {
  answer: SendIcon,
  revise_unread: RefreshIcon,
  continue_unread: ContinueIcon,
  shorten: ShortenIcon,
  expand: SparkleIcon,
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
        emitFixtureSuggestion(r.data.request_id, r.data.generation_id, r.data.suggestion_version, fixtureRemoteFinals(), action);
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

  if (!session)
    return (
      <div className="ca-empty">
        <BookIcon size={28} />
        <p>Belum ada sesi. Mulai sesi dari Dashboard.</p>
      </div>
    );

  const question = [...props.finals].reverse().find((f) => f.event.role === "remote")?.event.text ?? "—";
  const bandText =
    readerState.committed === 0
      ? "—"
      : script
          .slice(0, readerState.committed)
          .map((t) => t.word)
          .join(" ");
  const transcription = `transkripsi ${session.capture === "live" ? "berjalan" : session.capture === "paused" ? "dijeda" : session.capture} · ${props.finals.length} segmen final`;
  const genTone = genStatus.startsWith("done") ? "is-ok" : genStatus === "streaming" ? "is-info" : genStatus === "cancelled" ? "is-warn" : "";

  return (
    <section aria-label="Overlay teleprompter">
      <div className="ca-card">
        <div className="ca-segmented" role="group" aria-label="Mode overlay">
          <button
            type="button"
            data-testid="mode-toggle-compact"
            onClick={() => setOverlayMode("compact")}
            aria-pressed={overlayMode === "compact"}
          >
            Ringkas
          </button>
          <button
            type="button"
            data-testid="mode-toggle-reading"
            onClick={() => setOverlayMode("reading")}
            aria-pressed={overlayMode === "reading"}
          >
            Membaca
          </button>
        </div>

        {overlayMode === "compact" && (
          <div data-testid="overlay-mode-compact" style={{ marginTop: 12 }}>
            <h2 className="ca-section-head">Ringkas</h2>
            <ul className="ca-list">
              {(["self", "remote"] as const).map((role) => {
                const src = sources.find((x) => x.role === role);
                return (
                  <li key={role} data-testid={role === "self" ? "compact-source-self" : "compact-source-remote"} className="ca-list-item">
                    {role === "self" ? <MicIcon size={16} /> : <LoopbackIcon size={16} />}
                    <span className={`ca-role${role === "self" ? " is-self" : ""}`}>{role}</span>
                    <span>
                      {role === "self" ? "Mikrofon" : "Loopback"} · {src ? `${src.device_id} · ${src.enabled ? "aktif" : "nonaktif"}` : "memuat…"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="ca-status-row">
              <p data-testid="transcription-status" role="status" className="ca-status" style={{ margin: 0 }}>
                <span className="dot" />
                {transcription}
              </p>
              <p data-testid="generation-status" role="status" className={`ca-status ${genTone}`} style={{ margin: 0 }}>
                <span className="dot" />
                generasi {genStatus}
              </p>
            </div>
            <div className="ca-toolbar">
              <button type="button" data-testid="send-answer-compact" className="ca-btn ca-btn-primary" onClick={() => void send("answer")} aria-disabled={sending}>
                <SendIcon size={15} />
                {sending ? "Mengirim…" : "Kirim"}
              </button>
              <button type="button" data-testid="pause-compact" className="ca-btn" onClick={() => void togglePause()}>
                {session.capture === "live" ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
                {session.capture === "live" ? "Pause" : "Sambung"}
              </button>
            </div>
          </div>
        )}

        {overlayMode === "reading" && (
          <div data-testid="overlay-mode-reading" style={{ marginTop: 12 }}>
            <h2 className="ca-section-head">
              <SparkleIcon size={16} />
              Naskah
            </h2>
            <p data-testid="latest-question" className="ca-question">
              <strong>Tanya:</strong> {question}
            </p>
            <div className="ca-status-row">
              <p data-testid="transcription-status" role="status" className="ca-status" style={{ margin: 0 }}>
                <span className="dot" />
                {transcription}
              </p>
              <p data-testid="generation-status" role="status" className={`ca-status ${genTone}`} style={{ margin: 0 }}>
                <span className="dot" />
                generasi {genStatus}
              </p>
              <p data-testid="reader-state" className="ca-pill" style={{ margin: 0 }}>
                committed={readerState.committed} tentative={readerState.tentative} confidence={readerState.confidence}
              </p>
              {follow && (
                <span className="ca-status is-ok" style={{ margin: 0 }}>
                  <FollowIcon size={14} />
                  mengikuti
                </span>
              )}
            </div>
            <div ref={bandRef} data-testid="reading-band" className="ca-band">
              <span className="ca-band-label">BAND BACA</span>
              {bandText}
            </div>
            <div data-testid="script" className="ca-script">
              {script.map((t) => (
                <span
                  key={t.index}
                  data-testid={`token-${t.index}`}
                  onClick={() => void seekToken(t.index)}
                  title={`Klik untuk lompat ke kata ${t.index + 1}`}
                  className={`ca-token${t.index < readerState.committed ? " is-done" : t.index < readerState.tentative ? " is-next" : ""}`}
                >
                  {script[t.index]?.word ?? ""}{" "}
                </span>
              ))}
            </div>
            <div className="ca-toolbar">
              {(["answer", "revise_unread", "continue_unread", "shorten"] as const).map((a) => {
                const Icon = ACTION_ICON[a];
                return (
                  <button
                    key={a}
                    type="button"
                    data-testid={a === "answer" ? "send-answer" : `action-${a}`}
                    className={`ca-btn${a === "answer" ? " ca-btn-primary" : ""}`}
                    onClick={() => void send(a)}
                    // aria-disabled, bukan disabled: tombol yang sedang difokus
                    // lalu menjadi disabled akan kehilangan fokus ke <body>.
                    // Guard sending di send() yang menolak klik ganda.
                    aria-disabled={sending}
                  >
                    <Icon size={15} />
                    {sending && a === "answer" ? "Mengirim…" : ACTION_LABEL[a]}
                  </button>
                );
              })}
              <button type="button" data-testid="cancel-send" className="ca-btn ca-btn-danger" onClick={() => void cancel()} aria-disabled={!sending}>
                <CancelIcon size={15} />
                Batalkan
              </button>
              <button type="button" data-testid="follow-toggle" className="ca-btn ca-btn-quiet" onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
                <FollowIcon size={15} />
                Follow: {follow ? "aktif" : "mati"}
              </button>
              <button type="button" data-testid="pause-toggle" className="ca-btn ca-btn-quiet" onClick={() => void togglePause()} title="Jeda/sambung tangkapan sesi">
                {session.capture === "live" ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
                {session.capture === "live" ? "Pause" : "Sambung"}
              </button>
              {answerMeta !== "" && (
                <span data-testid="answer-meta" className="ca-pill">
                  <SparkleIcon size={13} />
                  Saran {answerMeta}
                </span>
              )}
            </div>
            <p data-testid="follow-state-text" className="ca-muted">
              follow {follow ? "mengikuti" : "dijeda (klik Follow untuk lanjut)"} · klik kata pada naskah untuk seek manual
            </p>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                ref={drawerToggleRef}
                data-testid="drawer-toggle"
                className="ca-btn"
                onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
                aria-expanded={drawerOpen}
              >
                <BookIcon size={15} />
                {drawerOpen ? "Tutup transkrip" : "Buka transkrip"}
              </button>
            </div>
            {drawerOpen && (
              <div data-testid="transcript-drawer" role="region" aria-label="Transkrip dan instruksi" className="ca-drawer">
                <h3 className="ca-section-head">Transkrip sesi</h3>
                <ul className="ca-list">
                  {props.finals.map((f) => (
                    <li key={f.event.segment_id} className="ca-list-item">
                      <span className={`ca-role${f.event.role === "self" ? " is-self" : ""}`}>{f.event.role}</span>
                      <span>{f.event.text}</span>
                    </li>
                  ))}
                </ul>
                <label className="ca-field" htmlFor="instruction-input">
                  Instruksi tambahan
                  <input
                    id="instruction-input"
                    data-testid="instruction-input"
                    className="ca-input"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="mis. gunakan bahasa sederhana…"
                    style={{ width: "100%", maxWidth: 480 }}
                  />
                </label>
              </div>
            )}
            {mode === "fixture" && <p className="ca-muted">Mode fixture: browser saja, bukan bukti IPC native.</p>}
          </div>
        )}
      </div>
      {props.error !== "" && <p role="alert" className="ca-alert">{props.error}</p>}
    </section>
  );
}
