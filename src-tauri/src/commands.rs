// Tauri command surface. Names follow docs/CONTRACTS.md; each command takes
// typed input, returns a typed Result, and has command-level integration tests
// (tests/native in P01/P03). These handlers own validation + store writes;
// provider streaming and audio capture are separate P02/P03 modules.
//
// Argument-key rule: bare-scalar commands MUST carry
// `rename_all = "snake_case"`. The command macro defaults top-level arg keys
// to camelCase, so `session_id: String` would arrive as `sessionId` and fail
// against the frozen snake_case contract (T17 caught pause/resume this way).
// Struct inputs are unaffected: serde matches their snake_case fields exactly.

use crate::providers::LlmAdapter;
use crate::store::{
    AppState, AudioSource, CommandError, CommandResult, FinalSegment, SessionRecord,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct StartSessionInput {
    pub workspace_id: String,
    pub profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptRangeInput {
    pub session_id: String,
    pub source_id: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct IngestTranscriptInput {
    pub session_id: String,
    pub source_id: String,
    pub role: String,
    pub segment_id: String,
    pub revision: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestTranscriptOutput {
    pub outcome: String,
    pub stored: bool,
}

/// Loads a session from memory, falling back to the database (restart
/// persistence), and warms the in-memory cache on a DB hit.
fn load_session_cached(
    session_id: &str,
    state: &tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        if let Some(rec) = sessions.get(session_id) {
            return Ok(rec.clone());
        }
    }
    let conn = state.open_conn()?;
    let rec = crate::store::load_session(&conn, session_id)?
        .ok_or_else(|| CommandError::NotFound(format!("session {session_id}")))?;
    state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?
        .insert(session_id.to_string(), rec.clone());
    Ok(rec)
}

fn persist_session_cached(
    rec: &SessionRecord,
    state: &tauri::State<'_, AppState>,
) -> CommandResult<()> {
    state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?
        .insert(rec.id.clone(), rec.clone());
    let conn = state.open_conn()?;
    crate::store::persist_session(&conn, rec)?;
    Ok(())
}

#[tauri::command]
pub fn ingest_transcript_event(
    input: IngestTranscriptInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<IngestTranscriptOutput> {
    require_non_empty(&input.session_id, "session_id")?;
    require_non_empty(&input.source_id, "source_id")?;
    require_non_empty(&input.segment_id, "segment_id")?;
    require_non_empty(&input.text, "text")?;
    require_max_len(&input.text, 20000, "text")?;
    if input.end_ms < input.start_ms {
        return Err(CommandError::InvalidInput(
            "require start_ms <= end_ms".to_string(),
        ));
    }
    // The session must exist: stray segments for unknown sessions are rejected.
    load_session_cached(&input.session_id, &state)?;
    let seg = crate::store::TranscriptSegment {
        id: input.segment_id,
        session_id: input.session_id,
        source_id: input.source_id,
        revision: input.revision,
        start_ms: input.start_ms,
        end_ms: input.end_ms,
        status: input.status,
        text: input.text,
    };
    let conn = state.open_conn()?;
    let outcome = crate::store::ingest_segment(&conn, &seg, &input.role)?;
    let stored = outcome != crate::store::IngestOutcome::StaleIgnored;
    Ok(IngestTranscriptOutput {
        outcome: outcome.as_str().to_string(),
        stored,
    })
}

#[derive(Debug, Deserialize)]
pub struct SendAnswerInput {
    pub session_id: String,
    pub action: String,
    #[serde(default)]
    pub target_segment_ids: Vec<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub output_language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SendAnswerOutput {
    pub request_id: String,
    pub generation_id: String,
    pub suggestion_version: u32,
}

fn require_non_empty(value: &str, field: &str) -> CommandResult<()> {
    if value.trim().is_empty() {
        return Err(CommandError::InvalidInput(format!(
            "{field} must not be empty"
        )));
    }
    Ok(())
}

fn require_max_len(value: &str, max: usize, field: &str) -> CommandResult<()> {
    if value.len() > max {
        return Err(CommandError::InvalidInput(format!(
            "{field} exceeds {max} characters"
        )));
    }
    Ok(())
}

/// Stable fingerprint of a Send: identical double-clicks dedup to one generation.
fn send_fingerprint(input: &SendAnswerInput) -> String {
    let mut targets = input.target_segment_ids.clone();
    targets.sort();
    serde_json::json!([
        input.session_id,
        input.action,
        targets,
        input.instruction.clone().unwrap_or_default(),
        input.output_language.clone().unwrap_or_default(),
    ])
    .to_string()
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_sources(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<AudioSource>> {
    require_non_empty(&session_id, "session_id")?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    if !sessions.contains_key(&session_id) {
        return Err(CommandError::NotFound(format!("session {session_id}")));
    }
    // P02 wires real WASAPI device enumeration; scaffold returns the two
    // session-bound roles so routing contracts are testable before hardware.
    Ok(vec![
        AudioSource {
            id: format!("{session_id}:self"),
            session_id: session_id.clone(),
            device_id: "default-microphone".to_string(),
            role: "self".to_string(),
            enabled: true,
        },
        AudioSource {
            id: format!("{session_id}:remote"),
            session_id,
            device_id: "default-loopback".to_string(),
            role: "remote".to_string(),
            enabled: true,
        },
    ])
}

#[tauri::command]
pub fn start_session(
    input: StartSessionInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    require_non_empty(&input.workspace_id, "workspace_id")?;
    if let Some(profile) = &input.profile_id {
        require_non_empty(profile, "profile_id")?;
    }
    let id = format!("session-{}", Uuid::new_v4().as_simple());
    let settings_snapshot = serde_json::json!({
        "workspace_id": input.workspace_id,
        "profile_id": input.profile_id,
    })
    .to_string();
    let record = SessionRecord {
        id: id.clone(),
        workspace_id: input.workspace_id,
        started_at: Utc::now().to_rfc3339(),
        active_revision: 0,
        capture: "connecting".to_string(),
        generation: "idle".to_string(),
        prompter: "inactive".to_string(),
        settings_snapshot,
    };
    // Seed the two session-bound sources so role attribution exists before the
    // first ingest; roles are fixed here and enforced by ingest_segment.
    // persist_session_cached runs first: audio_sources references sessions(id).
    persist_session_cached(&record, &state)?;
    {
        let conn = state.open_conn()?;
        for (suffix, device, role) in [
            ("self", "default-microphone", "self"),
            ("remote", "default-loopback", "remote"),
        ] {
            conn.execute(
                "INSERT OR IGNORE INTO audio_sources(id,session_id,device_id,role) VALUES(?1,?2,?3,?4)",
                rusqlite::params![
                    format!("{id}:{suffix}"),
                    id,
                    device,
                    role
                ],
            )
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        }
    }
    Ok(record)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pause_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    transition_capture(&session_id, "paused", &state)
}

#[tauri::command(rename_all = "snake_case")]
pub fn resume_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    transition_capture(&session_id, "live", &state)
}

#[tauri::command(rename_all = "snake_case")]
pub fn stop_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    transition_capture(&session_id, "stopped", &state)
}

fn transition_capture(
    session_id: &str,
    next: &str,
    state: &tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    let mut rec = load_session_cached(session_id, state)?;
    rec.capture = next.to_string();
    rec.active_revision += 1;
    persist_session_cached(&rec, state)?;
    Ok(rec)
}

#[tauri::command]
pub fn select_transcript_range(
    input: TranscriptRangeInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    require_non_empty(&input.session_id, "session_id")?;
    if let Some(source) = &input.source_id {
        require_non_empty(source, "source_id")?;
    }
    if let (Some(from), Some(to)) = (input.from_ms, input.to_ms) {
        if from > to {
            return Err(CommandError::InvalidInput(
                "from_ms must not exceed to_ms".to_string(),
            ));
        }
    }
    // Committed finals only: partials/hypotheses never enter a snapshot.
    load_session_cached(&input.session_id, &state)?;
    let conn = state.open_conn()?;
    let finals = crate::store::final_segments(
        &conn,
        &input.session_id,
        input.source_id.as_deref(),
        input.from_ms,
        input.to_ms,
    )?;
    Ok(finals.into_iter().map(|f| f.text).collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestionDelta {
    pub request_id: String,
    pub generation_id: String,
    pub index: u32,
    pub text_delta: String,
    /// P01 streams a deterministic fixture synthesis, never a model call.
    /// The flag travels in every payload so no consumer can mistake it.
    pub fixture: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestionDone {
    pub request_id: String,
    pub generation_id: String,
    pub suggestion_version: u32,
    pub status: String,
    pub fixture: bool,
}

/// Deterministic P01 suggestion synthesis. It formats the snapshot's committed
/// remote finals — the question being answered — into speakable lines. The
/// same rule is mirrored by the UI fixture bridge (src/ui/events.ts); P03
/// replaces both with real provider streaming.
/// T12: the action only changes the label word and (for shorten) the word cap:
/// `answer` output is byte-stable so existing L2/L3 assertions keep proving
/// the snapshot path, while shorten/expand/continue/revise are visibly distinct.
fn synthesize_suggestion(finals: &[FinalSegment], version: u32, action: &str) -> String {
    let joined = finals
        .iter()
        .filter(|f| f.role == "remote")
        .map(|f| f.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let (label, cap) = match action {
        "shorten" => ("ringkas", 12),
        "expand" => ("lengkap", 40),
        "continue_unread" => ("lanjutan", 40),
        "revise_unread" => ("revisi", 40),
        _ => ("jawaban", 40),
    };
    let words: Vec<&str> = joined.split_whitespace().take(cap).collect();
    let body = if words.is_empty() {
        "belum ada pertanyaan final yang terekam.".to_string()
    } else {
        words.join(" ")
    };
    format!("Draf {label} v{version} (fixture): «{body}»")
}

#[tauri::command]
pub fn send_answer(
    input: SendAnswerInput,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<SendAnswerOutput> {
    require_non_empty(&input.session_id, "session_id")?;
    const ACTIONS: &[&str] = &[
        "answer",
        "shorten",
        "expand",
        "continue_unread",
        "revise_unread",
    ];
    if !ACTIONS.contains(&input.action.as_str()) {
        return Err(CommandError::InvalidInput(format!(
            "unknown action {}",
            input.action
        )));
    }
    if let Some(lang) = &input.output_language {
        if lang != "id" && lang != "en" {
            return Err(CommandError::InvalidInput(
                "output_language must be id|en".to_string(),
            ));
        }
    }
    if let Some(instruction) = &input.instruction {
        require_max_len(instruction, 4000, "instruction")?;
    }
    for target in &input.target_segment_ids {
        require_non_empty(target, "target_segment_ids[]")?;
    }
    let fingerprint = send_fingerprint(&input);
    {
        let answered = state
            .answered
            .lock()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        if let Some(existing) = answered.get(&fingerprint) {
            // Identical double-click: no new generation, no new snapshot. The
            // UI already subscribed to events, so re-emit done for the settled
            // generation instead of leaving the sender waiting on a stream
            // that will never come.
            let _ = app.emit(
                "suggestion-done",
                &SuggestionDone {
                    request_id: existing.request_id.clone(),
                    generation_id: existing.generation_id.clone(),
                    suggestion_version: existing.suggestion_version,
                    status: "done".to_string(),
                    fixture: true,
                },
            );
            return Ok(existing.clone());
        }
    }
    let mut rec = load_session_cached(&input.session_id, &state)?;
    if rec.generation == "streaming" || rec.generation == "preparing_context" {
        return Err(CommandError::Conflict(
            "a generation is already active".to_string(),
        ));
    }
    // Freeze the snapshot from committed finals: later transcripts or edits
    // can never mutate this in-flight prompt.
    let conn = state.open_conn()?;
    let finals = crate::store::final_segments(&conn, &input.session_id, None, None, None)?;
    let targets: Vec<&FinalSegment> = if input.target_segment_ids.is_empty() {
        finals.iter().collect()
    } else {
        finals
            .iter()
            .filter(|f| input.target_segment_ids.contains(&f.segment_id))
            .collect()
    };
    let snapshot = {
        // T12: the snapshot carries the session's selected profile (durable in
        // settings_snapshot), never a hardcoded fixture id. Unknown ids fall
        // back to the balanced budget inside context::profile_budget.
        let settings: serde_json::Value =
            serde_json::from_str(&rec.settings_snapshot).unwrap_or(serde_json::json!({}));
        let profile_id = settings
            .get("model_profile_id")
            .and_then(|v| v.as_str())
            .unwrap_or("profil-seimbang")
            .to_string();
        let target_pairs: Vec<(&str, &str)> = targets
            .iter()
            .map(|f| (f.segment_id.as_str(), f.text.as_str()))
            .collect();
        let self_pairs: Vec<(&str, &str)> = finals
            .iter()
            .filter(|f| f.role == "self")
            .map(|f| (f.segment_id.as_str(), f.text.as_str()))
            .collect();
        // Retrieval-backed context (A08/A09 at Send time): user speech is
        // query data, sanitized by build_retrieval_query — never raw FTS
        // syntax. A query that still fails maps to InvalidInput inside
        // retrieve_sections, so Send falls back to no excerpts instead of
        // failing the request.
        let retrieval_query = crate::context::build_retrieval_query(
            &target_pairs.iter().map(|(_, t)| *t).collect::<Vec<_>>(),
        );
        let retrieved = if retrieval_query.is_empty() {
            Vec::new()
        } else {
            crate::store::retrieve_sections(&conn, &rec.workspace_id, &retrieval_query, 3)
                .unwrap_or_default()
        };
        let packet = crate::context::assemble_send_context(
            &profile_id,
            &target_pairs,
            &self_pairs,
            &retrieved,
            &retrieval_query,
        );
        serde_json::json!({
            "session_id": input.session_id,
            "action": input.action,
            "snapshot_revision": rec.active_revision,
            "target_segment_ids": targets.iter().map(|f| &f.segment_id).collect::<Vec<_>>(),
            "target_revisions": targets.iter().map(|f| (&f.segment_id, f.revision)).collect::<std::collections::HashMap<_, _>>(),
            "target_texts": targets.iter().map(|f| &f.text).collect::<Vec<_>>(),
            "instruction": input.instruction.clone().unwrap_or_default(),
            "model_profile_id": profile_id,
            "retrieval_query": retrieval_query,
            "retrieved": retrieved.iter().map(|s| serde_json::json!({
                "doc_id": s.doc_id, "file_name": s.file_name, "excerpt": s.excerpt,
            })).collect::<Vec<_>>(),
            "context_packet": packet,
            "output_language": input.output_language.clone().unwrap_or_else(|| "id".to_string()),
        })
    };
    let suggestion_version = crate::store::next_suggestion_version(&conn, &input.session_id)?;
    let request_id = format!("req-{}", Uuid::new_v4().as_simple());
    let generation_id = format!("gen-{}", Uuid::new_v4().as_simple());
    crate::store::insert_generation(
        &conn,
        &request_id,
        &input.session_id,
        &generation_id,
        &snapshot.to_string(),
        &input.action,
        suggestion_version,
    )?;
    rec.generation = "preparing_context".to_string();
    rec.active_revision += 1;
    persist_session_cached(&rec, &state)?;
    let output = SendAnswerOutput {
        request_id: request_id.clone(),
        generation_id: generation_id.clone(),
        suggestion_version,
    };
    state
        .answered
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?
        .insert(fingerprint, output.clone());
    // Stream through the LLM adapter seam on a worker thread. The fixture
    // adapter yields the same deterministic deltas the P01 worker emitted
    // inline, so no observable event changes; the seam now owns chunking,
    // cancel propagation, single-provider enforcement, retry policy, and
    // usage. Late deltas after done/cancel are never emitted, never merged.
    let worker_session = input.session_id.clone();
    let worker_action = input.action.clone();
    std::thread::spawn(move || {
        let finals: Vec<FinalSegment> = app
            .state::<AppState>()
            .open_conn()
            .ok()
            .and_then(|c| crate::store::final_segments(&c, &worker_session, None, None, None).ok())
            .unwrap_or_default();
        let text = synthesize_suggestion(&finals, suggestion_version, &worker_action);
        let prompt_chars = app
            .state::<AppState>()
            .open_conn()
            .ok()
            .and_then(|c| crate::store::generation_snapshot(&c, &request_id).ok())
            .flatten()
            .map(|s| s.len())
            .unwrap_or(0);
        let make_adapter = || -> Box<dyn LlmAdapter> {
            Box::new(crate::providers::FixtureLlmAdapter::for_suggestion(&text))
        };
        let should_cancel = || {
            app.state::<AppState>()
                .open_conn()
                .ok()
                .and_then(|c| crate::store::generation_status(&c, &request_id).ok())
                .map(|s| s.map(|(_, st)| st == "cancelled").unwrap_or(true))
                .unwrap_or(true)
        };
        let mut on_delta = |index: u32, delta: &str| {
            if index > 0 {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            app.emit(
                "suggestion-delta",
                &SuggestionDelta {
                    request_id: request_id.clone(),
                    generation_id: generation_id.clone(),
                    index,
                    text_delta: delta.to_string(),
                    fixture: true,
                },
            )
            .is_ok()
        };
        let outcome = crate::providers::drive_stream(
            make_adapter,
            prompt_chars,
            &should_cancel,
            &mut on_delta,
            1,
        );
        if let Ok(c) = app.state::<AppState>().open_conn() {
            let _ = crate::store::set_generation_status(&c, &request_id, outcome.status);
            let _ = crate::store::set_generation_usage(
                &c,
                &request_id,
                outcome.usage.prompt_tokens,
                outcome.usage.completion_tokens,
            );
        }
        // Release the single-generation fence: the row is settled and the
        // snapshot was frozen at Send, so the next distinct Send may start. A
        // newer generation (restart-after-cancel) is never overwritten here:
        // versions are dense per session, so settling only applies when this
        // request is still the latest row.
        {
            let st = app.state::<AppState>();
            let still_latest = st
                .open_conn()
                .ok()
                .and_then(|c| crate::store::next_suggestion_version(&c, &worker_session).ok())
                .map(|next| suggestion_version + 1 == next)
                .unwrap_or(false);
            if still_latest {
                if let Ok(mut rec) = load_session_cached(&worker_session, &st) {
                    if rec.generation == "streaming" || rec.generation == "preparing_context" {
                        rec.generation = match outcome.status {
                            "done" => "completed",
                            "cancelled" => "cancelled",
                            _ => "failed",
                        }
                        .to_string();
                        let _ = persist_session_cached(&rec, &st);
                    }
                }
            }
        }
        let _ = app.emit(
            "suggestion-done",
            &SuggestionDone {
                request_id: request_id.clone(),
                generation_id: generation_id.clone(),
                suggestion_version,
                status: outcome.status.to_string(),
                fixture: true,
            },
        );
    });
    rec.generation = "streaming".to_string();
    let _ = persist_session_cached(&rec, &state);
    Ok(output)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cancel_answer(request_id: String, state: tauri::State<'_, AppState>) -> CommandResult<bool> {
    require_non_empty(&request_id, "request_id")?;
    let conn = state.open_conn()?;
    let row = crate::store::generation_status(&conn, &request_id)?;
    let (session_id, status) =
        row.ok_or_else(|| CommandError::NotFound(format!("generation {request_id}")))?;
    if status == "done" || status == "failed" {
        return Ok(false);
    }
    if status == "cancelled" {
        return Ok(false);
    }
    crate::store::set_generation_status(&conn, &request_id, "cancelled")?;
    // Release the single-generation fence so a corrected Send can start once
    // the worker thread observes the cancelled row and stops emitting.
    if let Ok(mut rec) = load_session_cached(&session_id, &state) {
        if rec.generation == "streaming" || rec.generation == "preparing_context" {
            rec.generation = "idle".to_string();
            let _ = persist_session_cached(&rec, &state);
        }
    }
    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct SeekReaderInput {
    pub session_id: String,
    pub token_index: u32,
}

#[tauri::command]
pub fn seek_reader(
    input: SeekReaderInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<u32> {
    require_non_empty(&input.session_id, "session_id")?;
    // The cursor itself stays UI-local (P02 prompter lane); the command proves
    // the session exists and echoes the validated position.
    load_session_cached(&input.session_id, &state)?;
    Ok(input.token_index)
}

#[derive(Debug, Deserialize)]
pub struct SaveCorrectionInput {
    pub session_id: String,
    pub segment_id: String,
    pub corrected_text: String,
}

#[tauri::command]
pub fn save_correction(
    input: SaveCorrectionInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<bool> {
    require_non_empty(&input.session_id, "session_id")?;
    require_non_empty(&input.segment_id, "segment_id")?;
    require_non_empty(&input.corrected_text, "corrected_text")?;
    require_max_len(&input.corrected_text, 20000, "corrected_text")?;
    load_session_cached(&input.session_id, &state)?;
    let conn = state.open_conn()?;
    let updated = crate::store::apply_correction(
        &conn,
        &input.session_id,
        &input.segment_id,
        &input.corrected_text,
    )?;
    if !updated {
        return Err(CommandError::NotFound(format!(
            "segment {} in session {}",
            input.segment_id, input.session_id
        )));
    }
    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct ImportDocumentInput {
    pub workspace_id: String,
    pub file_name: String,
    #[serde(default)]
    pub content_text: Option<String>,
}

#[tauri::command]
pub fn import_document(
    input: ImportDocumentInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<String> {
    require_non_empty(&input.workspace_id, "workspace_id")?;
    require_non_empty(&input.file_name, "file_name")?;
    require_max_len(&input.file_name, 512, "file_name")?;
    if let Some(text) = &input.content_text {
        require_non_empty(text, "content_text")?;
        require_max_len(text, 10_000_000, "content_text")?;
    }
    // T09: a real persisted document, not an echo. The row carries workspace
    // scope + provenance; retrieval only cites rows from the same workspace.
    let id = format!("doc-{}", Uuid::new_v4().as_simple());
    let conn = state.open_conn()?;
    let doc = crate::store::import_document_row(
        &conn,
        &id,
        &input.workspace_id,
        &input.file_name,
        input.content_text.as_deref().unwrap_or(""),
    )?;
    Ok(doc.id)
}

#[derive(Debug, Deserialize)]
pub struct SelectModelProfileInput {
    pub session_id: String,
    pub model_profile_id: String,
}

#[tauri::command]
pub fn select_model_profile(
    input: SelectModelProfileInput,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    require_non_empty(&input.session_id, "session_id")?;
    require_non_empty(&input.model_profile_id, "model_profile_id")?;
    let mut rec = load_session_cached(&input.session_id, &state)?;
    // ARCHITECTURE §8: a switch while a generation is active is accepted and
    // applies to the NEXT request — the in-flight stream keeps its frozen
    // snapshot. The explicit restart path is cancel + resend (cancel_answer).
    // The profile choice is durable session settings, not a bare echo: it is
    // written into settings_snapshot and therefore survives restarts.
    let mut settings: serde_json::Value =
        serde_json::from_str(&rec.settings_snapshot).unwrap_or(serde_json::json!({}));
    settings["model_profile_id"] = serde_json::Value::String(input.model_profile_id);
    rec.settings_snapshot = settings.to_string();
    rec.active_revision += 1;
    persist_session_cached(&rec, &state)?;
    Ok(rec)
}
