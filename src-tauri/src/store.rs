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

    /// Opens a short-lived connection to the app database. Every command uses a
    /// fresh connection + short transaction; capture threads never touch these.
    pub fn open_conn(&self) -> Result<Connection, CommandError> {
        let guard = self
            .db_path
            .lock()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        let path = guard.as_ref().ok_or_else(|| {
            CommandError::Storage("database not initialized yet; retry".to_string())
        })?;
        open_db(path).map_err(|e| CommandError::Storage(e.to_string()))
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
  model_profile TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
  generation_id TEXT NOT NULL DEFAULT '', snapshot_json TEXT NOT NULL DEFAULT '{}',
  suggestion_version INTEGER NOT NULL DEFAULT 1);
";

/// Best-effort migration for dev databases created before a column existed.
/// Duplicate-column errors are ignored; any other error is returned.
fn add_column(conn: &Connection, table: &str, column_ddl: &str) -> Result<(), CommandError> {
    match conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column_ddl}"), []) {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("duplicate column") {
                Ok(())
            } else {
                Err(CommandError::Storage(msg))
            }
        }
    }
}

pub fn migrate(conn: &Connection) -> Result<(), CommandError> {
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    add_column(
        conn,
        "generation_requests",
        "generation_id TEXT NOT NULL DEFAULT ''",
    )?;
    add_column(
        conn,
        "generation_requests",
        "snapshot_json TEXT NOT NULL DEFAULT '{}'",
    )?;
    add_column(
        conn,
        "generation_requests",
        "suggestion_version INTEGER NOT NULL DEFAULT 1",
    )?;
    Ok(())
}

pub fn open_db(path: &std::path::Path) -> Result<Connection, CommandError> {
    let conn = Connection::open(path).map_err(|e| CommandError::Storage(e.to_string()))?;
    migrate(&conn)?;
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

/// Session + segment + generation persistence used by the P01 Send slice.
/// Runtime machine states (capture/generation/prompter) are intentionally NOT
/// persisted: after a restart they come back in safe states while the evidence
/// (segments, snapshots, generations) survives. See docs/CONTRACTS.md.

#[derive(Debug, Clone)]
pub struct FinalSegment {
    pub segment_id: String,
    pub role: String,
    pub revision: u32,
    pub text: String,
}

pub fn persist_session(conn: &Connection, rec: &SessionRecord) -> Result<(), CommandError> {
    conn.execute(
        "INSERT OR IGNORE INTO workspaces(id,title) VALUES(?1,?2)",
        params![rec.workspace_id, rec.workspace_id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    touch_session(conn, &rec.id, &rec.workspace_id)?;
    conn.execute(
        "UPDATE sessions SET active_revision=?1, settings_snapshot=?2 WHERE id=?3",
        params![rec.active_revision as i64, rec.settings_snapshot, rec.id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(())
}

/// Loads the durable session subset. Machine states reset to safe values on
/// purpose: capture=stopped, generation=idle, prompter=inactive.
pub fn load_session(conn: &Connection, id: &str) -> Result<Option<SessionRecord>, CommandError> {
    let mut stmt = conn
        .prepare("SELECT id, workspace_id, started_at, active_revision, settings_snapshot FROM sessions WHERE id=?1")
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    match rows
        .next()
        .map_err(|e| CommandError::Storage(e.to_string()))?
    {
        None => Ok(None),
        Some(row) => {
            let rev: i64 = row
                .get(3)
                .map_err(|e| CommandError::Storage(e.to_string()))?;
            Ok(Some(SessionRecord {
                id: row
                    .get(0)
                    .map_err(|e| CommandError::Storage(e.to_string()))?,
                workspace_id: row
                    .get(1)
                    .map_err(|e| CommandError::Storage(e.to_string()))?,
                started_at: row
                    .get(2)
                    .map_err(|e| CommandError::Storage(e.to_string()))?,
                active_revision: rev.max(0) as u64,
                capture: "stopped".to_string(),
                generation: "idle".to_string(),
                prompter: "inactive".to_string(),
                settings_snapshot: row
                    .get(4)
                    .map_err(|e| CommandError::Storage(e.to_string()))?,
            }))
        }
    }
}

pub fn insert_segment(conn: &Connection, seg: &TranscriptSegment) -> Result<(), CommandError> {
    seg.validate()?;
    conn.execute(
        "INSERT OR REPLACE INTO transcript_segments(id,session_id,source_id,start_ms,end_ms,revision,status,text) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![seg.id, seg.session_id, seg.source_id, seg.start_ms as i64, seg.end_ms as i64, seg.revision, seg.status, seg.text],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(())
}

/// Ingest outcome, mirroring the TypeScript TranscriptStore discipline:
/// a partial replaces the hypothesis row, a final commits it, and a stale or
/// duplicate write leaves the committed row untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestOutcome {
    Inserted,
    ReplacedHypothesis,
    Committed,
    StaleIgnored,
}

impl IngestOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            IngestOutcome::Inserted => "inserted",
            IngestOutcome::ReplacedHypothesis => "replaced-hypothesis",
            IngestOutcome::Committed => "committed",
            IngestOutcome::StaleIgnored => "stale-ignored",
        }
    }
}

pub fn ingest_segment(
    conn: &Connection,
    seg: &TranscriptSegment,
    role: &str,
) -> Result<IngestOutcome, CommandError> {
    seg.validate()?;
    if role != "self" && role != "remote" {
        return Err(CommandError::InvalidInput(
            "role must be self|remote".to_string(),
        ));
    }
    if seg.session_id.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "session_id must not be empty".to_string(),
        ));
    }
    let existing_role: Option<String> = conn
        .query_row(
            "SELECT role FROM audio_sources WHERE id=?1 AND session_id=?2",
            params![seg.source_id, seg.session_id],
            |row| row.get(0),
        )
        .ok();
    match existing_role {
        None => {
            let device = if role == "self" {
                "default-microphone"
            } else {
                "default-loopback"
            };
            conn.execute(
                "INSERT INTO audio_sources(id,session_id,device_id,role) VALUES(?1,?2,?3,?4)",
                params![seg.source_id, seg.session_id, device, role],
            )
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        }
        Some(prev) if prev != role => {
            return Err(CommandError::Conflict(format!(
                "source {} already attributed as {prev}; refusing to mix audio paths",
                seg.source_id
            )));
        }
        _ => {}
    }
    let existing: Option<(String, i64)> = conn
        .query_row(
            "SELECT status, revision FROM transcript_segments WHERE id=?1 AND session_id=?2",
            params![seg.id, seg.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    match existing {
        None => {
            insert_segment(conn, seg)?;
            Ok(IngestOutcome::Inserted)
        }
        Some((status, revision)) => {
            if status == "final" && (seg.status == "partial" || (seg.revision as i64) <= revision) {
                return Ok(IngestOutcome::StaleIgnored);
            }
            if (seg.revision as i64) <= revision && seg.status == status {
                return Ok(IngestOutcome::StaleIgnored);
            }
            insert_segment(conn, seg)?;
            if seg.status == "final" {
                Ok(IngestOutcome::Committed)
            } else {
                Ok(IngestOutcome::ReplacedHypothesis)
            }
        }
    }
}

/// Committed finals for a session in timeline order, role-attributed through
/// audio_sources. Partials are never included: a Send snapshot freezes finals.
pub fn final_segments(
    conn: &Connection,
    session_id: &str,
    source_id: Option<&str>,
    from_ms: Option<u64>,
    to_ms: Option<u64>,
) -> Result<Vec<FinalSegment>, CommandError> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, s.role, t.revision, t.text FROM transcript_segments t \
             JOIN audio_sources s ON s.id = t.source_id \
             WHERE t.session_id=?1 AND t.status='final' \
             AND (?2 IS NULL OR t.source_id=?2) \
             AND (?3 IS NULL OR t.start_ms>=?3) \
             AND (?4 IS NULL OR t.end_ms<=?4) \
             ORDER BY t.start_ms ASC, t.end_ms ASC",
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rows = stmt
        .query_map(
            params![
                session_id,
                source_id,
                from_ms.map(|v| v as i64),
                to_ms.map(|v| v as i64)
            ],
            |row| {
                Ok(FinalSegment {
                    segment_id: row.get(0)?,
                    role: row.get(1)?,
                    revision: row.get::<_, i64>(2)? as u32,
                    text: row.get(3)?,
                })
            },
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| CommandError::Storage(e.to_string()))
}

/// Per-session suggestion version: count of recorded generations + 1.
pub fn next_suggestion_version(conn: &Connection, session_id: &str) -> Result<u32, CommandError> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_requests WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok((n.max(0) + 1) as u32)
}

pub fn insert_generation(
    conn: &Connection,
    request_id: &str,
    session_id: &str,
    generation_id: &str,
    snapshot_json: &str,
    action: &str,
    suggestion_version: u32,
) -> Result<(), CommandError> {
    conn.execute(
        "INSERT INTO generation_requests(id,session_id,snapshot_id,generation_id,snapshot_json,model_profile,action,status,suggestion_version) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![request_id, session_id, request_id, generation_id, snapshot_json, "fixture-p01", action, "streaming", suggestion_version],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(())
}

pub fn generation_status(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<(String, String)>, CommandError> {
    let mut stmt = conn
        .prepare("SELECT session_id, status FROM generation_requests WHERE id=?1")
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let mut rows = stmt
        .query(params![request_id])
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    match rows
        .next()
        .map_err(|e| CommandError::Storage(e.to_string()))?
    {
        None => Ok(None),
        Some(row) => Ok(Some((
            row.get(0)
                .map_err(|e| CommandError::Storage(e.to_string()))?,
            row.get(1)
                .map_err(|e| CommandError::Storage(e.to_string()))?,
        ))),
    }
}

pub fn set_generation_status(
    conn: &Connection,
    request_id: &str,
    status: &str,
) -> Result<bool, CommandError> {
    let n = conn
        .execute(
            "UPDATE generation_requests SET status=?1 WHERE id=?2",
            params![status, request_id],
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(n == 1)
}

/// Applies a user correction as a new final revision of the stored segment.
/// Corrections are distinct stored data, never silent overwrites of evidence:
/// the revision bumps and provenance records the correction.
pub fn apply_correction(
    conn: &Connection,
    session_id: &str,
    segment_id: &str,
    corrected_text: &str,
) -> Result<bool, CommandError> {
    let n = conn
        .execute(
            "UPDATE transcript_segments SET text=?1, status='final', revision=revision+1, \
             provenance='{\"correction\":true}' WHERE id=?2 AND session_id=?3",
            params![corrected_text, segment_id, session_id],
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(n == 1)
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
