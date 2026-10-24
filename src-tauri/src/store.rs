// Session store: workspaces, sessions, sources, transcript segments.
// SQLite via rusqlite; all writes go through this module on short transactions.
// Audio capture threads never touch this lock (bounded channel in P02).

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum CommandError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("storage unavailable: {0}")]
    Storage(String),
}

pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioSource {
    pub id: String,
    pub session_id: String,
    pub device_id: String,
    pub role: String,
    pub enabled: bool,
}

// P01 (T03) wires this into replay→SQLite transcript ingestion; the struct and
// its validation already have unit tests below. The allows are scoped to this
// scaffold item and go away once the ingestion path constructs it.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub session_id: String,
    pub source_id: String,
    pub revision: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: String,
    pub text: String,
}

impl TranscriptSegment {
    /// Mirrors the TypeScript TranscriptStore validation (partial/final, timeline).
    #[allow(dead_code)]
    pub fn validate(&self) -> Result<(), CommandError> {
        if self.id.trim().is_empty()
            || self.session_id.trim().is_empty()
            || self.source_id.trim().is_empty()
        {
            return Err(CommandError::InvalidInput(
                "segment/session/source ids must not be empty".to_string(),
            ));
        }
        if self.status != "partial" && self.status != "final" {
            return Err(CommandError::InvalidInput(
                "status must be partial|final".to_string(),
            ));
        }
        if self.end_ms < self.start_ms {
            return Err(CommandError::InvalidInput(
                "require start_ms <= end_ms".to_string(),
            ));
        }
        Ok(())
    }
}

pub struct AppState {
    pub db_path: Mutex<Option<PathBuf>>,
    pub sessions: Mutex<HashMap<String, SessionRecord>>,
    /// Completed/answered Send fingerprints for double-click dedup (P01 adds persistence).
    pub answered: Mutex<HashMap<String, crate::commands::SendAnswerOutput>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRecord {
    pub id: String,
    pub workspace_id: String,
    pub started_at: String,
    pub active_revision: u64,
    pub capture: String,
    pub generation: String,
    pub prompter: String,
    pub settings_snapshot: String,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            db_path: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            answered: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS workspaces(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, profile_id TEXT, policy_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  started_at TEXT NOT NULL, ended_at TEXT, active_revision INTEGER NOT NULL DEFAULT 0,
  settings_snapshot TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS audio_sources(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  device_id TEXT NOT NULL, role TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'pcm16-16k-mono',
  enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS transcript_segments(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, text TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS generation_requests(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  model_profile TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL);
";

pub fn open_db(path: &std::path::Path) -> Result<Connection, CommandError> {
    let conn = Connection::open(path).map_err(|e| CommandError::Storage(e.to_string()))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(conn)
}

pub async fn init_db<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> Result<(), CommandError> {
    let dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Storage(e.to_string()))?;
    let db_path = dir.join("conversation-assistant.db");
    let path = db_path.clone();
    tauri::async_runtime::spawn_blocking(move || open_db(&path).map(|_| ()))
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))??;
    if let Some(state) = handle.try_state::<AppState>() {
        *state
            .db_path
            .lock()
            .map_err(|e| CommandError::Storage(e.to_string()))? = Some(db_path);
    }
    Ok(())
}

#[allow(dead_code)]
fn touch_session(conn: &Connection, id: &str, workspace_id: &str) -> Result<(), CommandError> {
    conn.execute(
        "INSERT OR IGNORE INTO sessions(id, workspace_id, started_at) VALUES(?1,?2,?3)",
        params![id, workspace_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_applies_to_in_memory_db() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(SCHEMA_SQL).expect("schema applies");
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .expect("query")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("names");
        for expected in [
            "sessions",
            "audio_sources",
            "transcript_segments",
            "generation_requests",
            "workspaces",
        ] {
            assert!(
                tables.contains(&expected.to_string()),
                "missing table {expected}"
            );
        }
    }

    fn sample_segment() -> TranscriptSegment {
        TranscriptSegment {
            id: "seg-1".to_string(),
            session_id: "session-1".to_string(),
            source_id: "mic".to_string(),
            revision: 1,
            start_ms: 950,
            end_ms: 1400,
            status: "final".to_string(),
            text: "Fokus saya adalah respons cepat.".to_string(),
        }
    }

    #[test]
    fn segment_validation_accepts_partial_and_final() {
        let mut seg = sample_segment();
        seg.status = "partial".to_string();
        assert!(seg.validate().is_ok());
        seg.status = "final".to_string();
        assert!(seg.validate().is_ok());
    }

    #[test]
    fn segment_validation_rejects_bad_status_and_timeline() {
        let mut seg = sample_segment();
        seg.status = "draft".to_string();
        assert!(seg.validate().is_err());
        seg.status = "final".to_string();
        seg.start_ms = 2000;
        seg.end_ms = 1000;
        assert!(seg.validate().is_err());
    }
}
