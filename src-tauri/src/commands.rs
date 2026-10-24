// Tauri command surface. Names follow docs/CONTRACTS.md; each command takes
// typed input, returns a typed Result, and has command-level integration tests
// (tests/native in P01/P03). These handlers own validation + store writes;
// provider streaming and audio capture are separate P02/P03 modules.

use crate::store::{AppState, AudioSource, CommandError, CommandResult, SessionRecord};
use chrono::Utc;
use serde::{Deserialize, Serialize};
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

#[tauri::command]
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
    state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?
        .insert(id, record.clone());
    Ok(record)
}

#[tauri::command]
pub fn pause_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    transition_capture(&session_id, "paused", &state)
}

#[tauri::command]
pub fn resume_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<SessionRecord> {
    transition_capture(&session_id, "live", &state)
}

#[tauri::command]
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
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rec = sessions
        .get_mut(session_id)
        .ok_or_else(|| CommandError::NotFound(format!("session {session_id}")))?;
    rec.capture = next.to_string();
    rec.active_revision += 1;
    Ok(rec.clone())
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
    let sessions = state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    if !sessions.contains_key(&input.session_id) {
        return Err(CommandError::NotFound(format!(
            "session {}",
            input.session_id
        )));
    }
    // Segment resolution runs against SQLite in P01 (test:replay proves the flow).
    Ok(vec![])
}

#[tauri::command]
pub fn send_answer(
    input: SendAnswerInput,
    state: tauri::State<'_, AppState>,
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
            return Ok(existing.clone());
        }
    }
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rec = sessions
        .get_mut(&input.session_id)
        .ok_or_else(|| CommandError::NotFound(format!("session {}", input.session_id)))?;
    if rec.generation == "streaming" || rec.generation == "preparing_context" {
        return Err(CommandError::Conflict(
            "a generation is already active".to_string(),
        ));
    }
    rec.generation = "preparing_context".to_string();
    rec.active_revision += 1;
    let output = SendAnswerOutput {
        request_id: format!("req-{}", Uuid::new_v4().as_simple()),
        generation_id: format!("gen-{}", Uuid::new_v4().as_simple()),
        suggestion_version: 1,
    };
    state
        .answered
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?
        .insert(fingerprint, output.clone());
    Ok(output)
}

#[tauri::command]
pub fn cancel_answer(request_id: String) -> CommandResult<bool> {
    require_non_empty(&request_id, "request_id")?;
    // Generation registry with delta fencing lands in P01; scaffold validates input.
    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct SeekReaderInput {
    pub session_id: String,
    pub token_index: u32,
}

#[tauri::command]
pub fn seek_reader(input: SeekReaderInput) -> CommandResult<u32> {
    require_non_empty(&input.session_id, "session_id")?;
    Ok(input.token_index)
}

#[derive(Debug, Deserialize)]
pub struct SaveCorrectionInput {
    pub session_id: String,
    pub segment_id: String,
    pub corrected_text: String,
}

#[tauri::command]
pub fn save_correction(input: SaveCorrectionInput) -> CommandResult<bool> {
    require_non_empty(&input.session_id, "session_id")?;
    require_non_empty(&input.segment_id, "segment_id")?;
    require_non_empty(&input.corrected_text, "corrected_text")?;
    require_max_len(&input.corrected_text, 20000, "corrected_text")?;
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
pub fn import_document(input: ImportDocumentInput) -> CommandResult<String> {
    require_non_empty(&input.workspace_id, "workspace_id")?;
    require_non_empty(&input.file_name, "file_name")?;
    require_max_len(&input.file_name, 512, "file_name")?;
    if let Some(text) = &input.content_text {
        require_non_empty(text, "content_text")?;
        require_max_len(text, 10_000_000, "content_text")?;
    }
    Ok(format!("doc-{}", Uuid::new_v4().as_simple()))
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
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rec = sessions
        .get_mut(&input.session_id)
        .ok_or_else(|| CommandError::NotFound(format!("session {}", input.session_id)))?;
    if rec.generation == "streaming" {
        return Err(CommandError::Conflict(
            "model switch applies to the next request while streaming".to_string(),
        ));
    }
    rec.active_revision += 1;
    Ok(rec.clone())
}
