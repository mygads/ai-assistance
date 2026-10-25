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
-- T09: workspace-scoped imported documents + FTS5 index for retrieval.
-- Documents are immutable once imported (corrections arrive as new documents);
-- the FTS table mirrors the content column inside the same transaction.
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  file_name TEXT NOT NULL, content_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_id UNINDEXED, file_name, content_text, workspace_id UNINDEXED, tokenize='unicode61');
-- T13: scoped memory with feedback learning. Suggested text is NEVER confirmed
-- on arrival: rows start as draft; only explicit user evidence (a correction,
-- a confirmation, or the user's own speech) promotes to confirmed (A10).
-- Supersede preserves the old row for rollback instead of overwriting it.
CREATE TABLE IF NOT EXISTS memory_items(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  profile_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  evidence_json TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
-- T14: provenance-preserving compaction (A11). Summaries are per revision
-- coverage range and cite original evidence; raw transcript and memory rows
-- are NEVER deleted by compaction (no DELETE exists on this path).
CREATE TABLE IF NOT EXISTS session_summaries(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  coverage_start_rev INTEGER NOT NULL, coverage_end_rev INTEGER NOT NULL,
  summary TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL);
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
    // T11: token usage recorded per generation (heuristic estimates, labeled
    // wherever shown). Older rows default to zero, never to invented counts.
    add_column(
        conn,
        "generation_requests",
        "prompt_tokens INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column(
        conn,
        "generation_requests",
        "completion_tokens INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

pub fn open_db(path: &std::path::Path) -> Result<Connection, CommandError> {
    let conn = Connection::open(path).map_err(|e| CommandError::Storage(e.to_string()))?;
    // WAL keeps readers (UI snapshot loads) from blocking writers (ingest
    // callbacks) and survives an app crash: committed frames are in the WAL
    // and replay on the next open. synchronous=NORMAL is durable with WAL
    // for app/process crashes (only OS/power loss could lose a tail frame).
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    migrate(&conn)?;
    Ok(conn)
}

/// Restart recovery (T15/A14): the in-memory machines are gone, so any
/// generation left in a non-terminal state was interrupted by the crash —
/// never resumed. Mark those rows cancelled so history stays honest and a
/// fresh Send after restart is never fenced by a dead stream. Terminal rows
/// are untouched; calling twice marks nothing new. Returns rows settled.
pub fn recover_session_after_restart(
    conn: &Connection,
    session_id: &str,
) -> Result<usize, CommandError> {
    if session_id.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "session_id must not be empty".to_string(),
        ));
    }
    let n = conn
        .execute(
            "UPDATE generation_requests SET status='cancelled' \
             WHERE session_id=?1 AND status IN ('preparing_context','streaming')",
            params![session_id],
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(n)
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

/// Workspace-scoped document import with provenance (T09/A08/A09).
/// Every stored document carries its workspace scope; retrieval below only
/// ever returns rows from the caller's workspace, so source references in
/// context packets always resolve to actually-imported documents.
#[derive(Debug, Clone)]
pub struct ImportedDocument {
    pub id: String,
    pub workspace_id: String,
    pub file_name: String,
    pub created_at: String,
}

pub fn import_document_row(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    file_name: &str,
    content_text: &str,
) -> Result<ImportedDocument, CommandError> {
    if id.trim().is_empty() || workspace_id.trim().is_empty() || file_name.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "document/workspace/file ids must not be empty".to_string(),
        ));
    }
    conn.execute(
        "INSERT OR IGNORE INTO workspaces(id,title) VALUES(?1,?2)",
        params![workspace_id, workspace_id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    let created_at = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO documents(id,workspace_id,file_name,content_text,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![id, workspace_id, file_name, content_text, created_at],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    conn.execute(
        "INSERT INTO documents_fts(doc_id,file_name,content_text,workspace_id) VALUES(?1,?2,?3,?4)",
        params![id, file_name, content_text, workspace_id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(ImportedDocument {
        id: id.to_string(),
        workspace_id: workspace_id.to_string(),
        file_name: file_name.to_string(),
        created_at,
    })
}

/// One retrieved excerpt with full provenance: workspace scope plus the
/// document reference the excerpt came from. Callers attach these as
/// `retrieved_section` items (with source_refs=[doc_id]) so context packets
/// never cite documents that were not imported into the workspace.
#[derive(Debug, Clone)]
pub struct RetrievedSection {
    pub doc_id: String,
    pub workspace_id: String,
    pub file_name: String,
    pub excerpt: String,
    pub rank: f64,
}

pub fn retrieve_sections(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<RetrievedSection>, CommandError> {
    if workspace_id.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "workspace_id must not be empty".to_string(),
        ));
    }
    if query.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "query must not be empty".to_string(),
        ));
    }
    if limit == 0 || limit > 50 {
        return Err(CommandError::InvalidInput(
            "limit must be within 1..=50".to_string(),
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT doc_id, workspace_id, file_name, \
             snippet(documents_fts, 2, '<mark>', '</mark>', ' … ', 10) AS excerpt, \
             bm25(documents_fts) AS score \
             FROM documents_fts WHERE documents_fts MATCH ?1 AND workspace_id = ?2 \
             ORDER BY score LIMIT ?3",
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rows = stmt
        .query_map(params![query.trim(), workspace_id, limit as i64], |row| {
            Ok(RetrievedSection {
                doc_id: row.get(0)?,
                workspace_id: row.get(1)?,
                file_name: row.get(2)?,
                excerpt: row.get(3)?,
                rank: row.get(4)?,
            })
        })
        .map_err(|e| map_fts_error(e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| map_fts_error(e.to_string()))?);
    }
    Ok(out)
}

/// FTS5 query-parse failures are caller bugs (InvalidInput), never storage
/// faults. rusqlite surfaces them either at prepare (`syntax error ...`) or at
/// row iteration (`unterminated string`, ...), so both call sites map here.
fn map_fts_error(msg: String) -> CommandError {
    let lower = msg.to_lowercase();
    if lower.contains("syntax error")
        || lower.contains("unterminated")
        || lower.contains("unrecognized")
        || lower.contains("malformed")
        || lower.contains("no such token")
    {
        CommandError::InvalidInput(format!("unparseable retrieval query: {msg}"))
    } else {
        CommandError::Storage(msg)
    }
}

/// T13 scoped memory (A09/A10): actual speech, AI suggestions, user
/// corrections, and confirmed personal facts stay distinct rows. A memory row
/// is born `draft` and only becomes `confirmed` on explicit user evidence;
/// `confirm_memory` rejects AI-only provenance so replaying a suggestion can
/// never self-confirm it (C16). Corrections supersede: the old row is kept
/// with status `superseded` for rollback instead of being overwritten (C17).
/// Recall is always workspace-scoped and optionally profile-scoped: rows with
/// an empty profile_id are workspace-wide, others are visible only to the
/// same profile.
#[derive(Debug, Clone)]
pub struct MemoryItem {
    pub id: String,
    pub workspace_id: String,
    pub profile_id: String,
    pub session_id: String,
    pub kind: String,
    pub content: String,
    pub status: String,
    pub evidence_json: String,
    pub version: i64,
    pub supersedes_id: String,
    pub created_at: String,
}

const MEMORY_KINDS: &[&str] = &["fact", "preference", "procedure", "episodic"];
/// Evidence that counts as explicit user feedback and may confirm a draft.
/// Mirrors the T01 MemoryStore CONFIRMING set (plus self_speech: the user
/// speaking a fact is first-party evidence, not an AI suggestion).
const USER_EVIDENCE_KINDS: &[&str] = &[
    "user_correction",
    "user_confirmation",
    "self_speech",
    "curated_import",
];
const EVIDENCE_KINDS: &[&str] = &[
    "ai_suggestion",
    "user_correction",
    "user_confirmation",
    "self_speech",
    "curated_import",
    "session_summary",
    "remote_speech",
    "read_aloud",
    "document",
];

fn read_memory_row(row: &rusqlite::Row) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        profile_id: row.get(2)?,
        session_id: row.get(3)?,
        kind: row.get(4)?,
        content: row.get(5)?,
        status: row.get(6)?,
        evidence_json: row.get(7)?,
        version: row.get(8)?,
        supersedes_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

const MEMORY_COLS: &str = "id, workspace_id, profile_id, session_id, kind, content, \
     status, evidence_json, version, supersedes_id, created_at";

/// Evidence entries look like {"kind": "...", "ref": "..."}. Returns true when
/// at least one entry is explicit user feedback (C16 guard).
fn evidence_qualifies_for_confirm(evidence_json: &str) -> Result<bool, CommandError> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(evidence_json).map_err(|e| {
        CommandError::InvalidInput(format!("evidence_json must be a JSON array: {e}"))
    })?;
    for e in &entries {
        let kind = e.get("kind").and_then(|k| k.as_str()).ok_or_else(|| {
            CommandError::InvalidInput("every evidence entry needs a string kind".to_string())
        })?;
        if !EVIDENCE_KINDS.contains(&kind) {
            return Err(CommandError::InvalidInput(format!(
                "unknown evidence kind {kind}"
            )));
        }
    }
    Ok(entries.iter().any(|e| {
        USER_EVIDENCE_KINDS.contains(&e.get("kind").and_then(|k| k.as_str()).unwrap_or(""))
    }))
}

/// Parameters for a new memory row (T16 IPC commands build this struct).
pub struct NewMemory<'a> {
    pub id: &'a str,
    pub workspace_id: &'a str,
    pub profile_id: &'a str,
    pub session_id: &'a str,
    pub kind: &'a str,
    pub content: &'a str,
    pub evidence_json: &'a str,
}

impl<'a> NewMemory<'a> {
    /// Workspace-wide draft; override `profile_id` for profile-scoped rows.
    pub fn draft(
        id: &'a str,
        workspace_id: &'a str,
        session_id: &'a str,
        kind: &'a str,
        content: &'a str,
        evidence_json: &'a str,
    ) -> Self {
        Self {
            id,
            workspace_id,
            profile_id: "",
            session_id,
            kind,
            content,
            evidence_json,
        }
    }
}

pub fn record_memory(conn: &Connection, m: &NewMemory) -> Result<MemoryItem, CommandError> {
    if m.id.trim().is_empty() || m.workspace_id.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "memory/workspace ids must not be empty".to_string(),
        ));
    }
    if !MEMORY_KINDS.contains(&m.kind) {
        return Err(CommandError::InvalidInput(format!(
            "unknown memory kind {}",
            m.kind
        )));
    }
    if m.content.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "memory content must not be empty".to_string(),
        ));
    }
    // Validates shape now; confirmation re-checks user provenance later.
    evidence_qualifies_for_confirm(m.evidence_json)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspaces(id,title) VALUES(?1,?2)",
        params![m.workspace_id, m.workspace_id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    let created_at = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO memory_items(id,workspace_id,profile_id,session_id,kind,content,status,evidence_json,version,supersedes_id,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,'draft',?7,1,'',?8)",
        params![m.id, m.workspace_id, m.profile_id, m.session_id, m.kind, m.content, m.evidence_json, created_at],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    load_memory(conn, m.id)?
        .ok_or_else(|| CommandError::Storage(format!("memory {} vanished after insert", m.id)))
}

pub fn load_memory(conn: &Connection, id: &str) -> Result<Option<MemoryItem>, CommandError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MEMORY_COLS} FROM memory_items WHERE id=?1"
        ))
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let mut rows = stmt
        .query_map(params![id], read_memory_row)
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    match rows.next() {
        None => Ok(None),
        Some(row) => Ok(Some(row.map_err(|e| CommandError::Storage(e.to_string()))?)),
    }
}

/// Promote a draft on explicit user evidence. AI-only provenance
/// (ai_suggestion/document without any user entry) is rejected: replaying or
/// re-reading a suggestion must never confirm it. Idempotent for confirmed rows.
pub fn confirm_memory(conn: &Connection, id: &str) -> Result<MemoryItem, CommandError> {
    let item =
        load_memory(conn, id)?.ok_or_else(|| CommandError::NotFound(format!("memory {id}")))?;
    if item.status == "confirmed" {
        return Ok(item);
    }
    if item.status == "superseded" {
        return Err(CommandError::Conflict(format!(
            "memory {id} is superseded; confirm its successor"
        )));
    }
    if !evidence_qualifies_for_confirm(&item.evidence_json)? {
        return Err(CommandError::InvalidInput(
            "ai suggestions never self-confirm: confirm needs user_correction, user_confirmation, self_speech, or curated_import evidence".to_string(),
        ));
    }
    conn.execute(
        "UPDATE memory_items SET status='confirmed' WHERE id=?1",
        params![id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    load_memory(conn, id)?
        .ok_or_else(|| CommandError::Storage(format!("memory {id} vanished after confirm")))
}

/// Explicit correction (C17): the old row is preserved as `superseded` and the
/// new row carries version+1 with the supersedes link. The successor starts
/// confirmed only when its own evidence qualifies; otherwise it stays draft.
pub fn supersede_memory(
    conn: &Connection,
    new_id: &str,
    superseded_id: &str,
    content: &str,
    evidence_json: &str,
) -> Result<MemoryItem, CommandError> {
    let old = load_memory(conn, superseded_id)?
        .ok_or_else(|| CommandError::NotFound(format!("memory {superseded_id}")))?;
    if old.status == "superseded" {
        return Err(CommandError::Conflict(format!(
            "memory {superseded_id} already superseded"
        )));
    }
    if content.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "memory content must not be empty".to_string(),
        ));
    }
    let qualifies = evidence_qualifies_for_confirm(evidence_json)?;
    let created_at = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE memory_items SET status='superseded' WHERE id=?1",
        params![superseded_id],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    let status = if qualifies { "confirmed" } else { "draft" };
    conn.execute(
        "INSERT INTO memory_items(id,workspace_id,profile_id,session_id,kind,content,status,evidence_json,version,supersedes_id,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            new_id, old.workspace_id, old.profile_id, old.session_id, old.kind,
            content, status, evidence_json, old.version + 1, superseded_id, created_at,
        ],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    load_memory(conn, new_id)?
        .ok_or_else(|| CommandError::Storage(format!("memory {new_id} vanished after insert")))
}

/// Scoped recall (A09): the workspace filter is mandatory; within it,
/// workspace-wide rows (empty profile_id) mix with rows for the caller's
/// profile only. Superseded rows are history, not recall candidates.
pub fn recall_memory(
    conn: &Connection,
    workspace_id: &str,
    profile_id: &str,
) -> Result<Vec<MemoryItem>, CommandError> {
    if workspace_id.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "workspace_id must not be empty".to_string(),
        ));
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MEMORY_COLS} FROM memory_items \
             WHERE workspace_id=?1 AND (profile_id='' OR profile_id=?2) AND status != 'superseded' \
             ORDER BY status DESC, created_at ASC"
        ))
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rows = stmt
        .query_map(params![workspace_id, profile_id], read_memory_row)
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| CommandError::Storage(e.to_string()))
}

/// A persisted structured summary over a revision coverage range (T14/A11).
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub coverage_start_rev: i64,
    pub coverage_end_rev: i64,
    pub summary: String,
    pub refs_json: String,
    pub created_at: String,
}

/// Parameters for a new session summary.
pub struct NewSessionSummary<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub workspace_id: &'a str,
    pub coverage_start_rev: i64,
    pub coverage_end_rev: i64,
    pub summary: &'a str,
    pub refs_json: &'a str,
}

fn read_summary_row(row: &rusqlite::Row) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        id: row.get(0)?,
        session_id: row.get(1)?,
        workspace_id: row.get(2)?,
        coverage_start_rev: row.get(3)?,
        coverage_end_rev: row.get(4)?,
        summary: row.get(5)?,
        refs_json: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const SUMMARY_COLS: &str = "id, session_id, workspace_id, coverage_start_rev, coverage_end_rev, summary, refs_json, created_at";

/// Record a compaction summary. Enforces the A11/C18 rules: non-empty coverage
/// range, grounding in original evidence (never a summary-of-summary chain),
/// and forward-moving coverage so background summarization cannot overwrite
/// newer corrections. Raw transcript/memory rows are untouched by this path.
pub fn record_session_summary(
    conn: &Connection,
    m: &NewSessionSummary,
) -> Result<SessionSummary, CommandError> {
    if m.id.trim().is_empty() || m.session_id.trim().is_empty() || m.workspace_id.trim().is_empty()
    {
        return Err(CommandError::InvalidInput(
            "summary/session/workspace ids must not be empty".to_string(),
        ));
    }
    if m.coverage_end_rev <= m.coverage_start_rev {
        return Err(CommandError::InvalidInput(
            "coverage must be a non-empty revision range".to_string(),
        ));
    }
    if m.summary.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "summary must not be empty".to_string(),
        ));
    }
    let refs: Vec<serde_json::Value> = serde_json::from_str(m.refs_json)
        .map_err(|e| CommandError::InvalidInput(format!("refs_json must be a JSON array: {e}")))?;
    if refs.is_empty()
        || refs
            .iter()
            .any(|r| r.as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return Err(CommandError::InvalidInput(
            "refs must be a non-empty array of evidence ids".to_string(),
        ));
    }
    if !refs
        .iter()
        .any(|r| r.as_str().is_none_or(|s| !s.starts_with("sum-")))
    {
        return Err(CommandError::InvalidInput(
            "summary must cite original evidence, not only older summaries".to_string(),
        ));
    }
    let max_end: Option<i64> = conn
        .query_row(
            "SELECT MAX(coverage_end_rev) FROM session_summaries WHERE session_id=?1",
            params![m.session_id],
            |row| row.get(0),
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    if max_end.is_some_and(|end| m.coverage_end_rev < end) {
        return Err(CommandError::InvalidInput(
            "coverage moves backward over newer corrections".to_string(),
        ));
    }
    let created_at = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_summaries(id,session_id,workspace_id,coverage_start_rev,coverage_end_rev,summary,refs_json,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![m.id, m.session_id, m.workspace_id, m.coverage_start_rev, m.coverage_end_rev, m.summary, m.refs_json, created_at],
    )
    .map_err(|e| CommandError::Storage(e.to_string()))?;
    load_session_summary(conn, m.id)?
        .ok_or_else(|| CommandError::Storage(format!("summary {} vanished after insert", m.id)))
}

pub fn load_session_summary(
    conn: &Connection,
    id: &str,
) -> Result<Option<SessionSummary>, CommandError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SUMMARY_COLS} FROM session_summaries WHERE id=?1"
        ))
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let mut rows = stmt
        .query_map(params![id], read_summary_row)
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    match rows.next() {
        None => Ok(None),
        Some(row) => Ok(Some(row.map_err(|e| CommandError::Storage(e.to_string()))?)),
    }
}

/// Summaries for a session, oldest coverage first.
pub fn load_session_summaries(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionSummary>, CommandError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SUMMARY_COLS} FROM session_summaries WHERE session_id=?1 ORDER BY coverage_end_rev ASC"
        ))
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let rows = stmt
        .query_map(params![session_id], read_summary_row)
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| CommandError::Storage(e.to_string()))
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

/// Records heuristic token usage for a generation. The prompt side is
/// estimated from the frozen snapshot; the completion side from the text
/// actually assembled by the stream driver — never from a guess.
pub fn set_generation_usage(
    conn: &Connection,
    request_id: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
) -> Result<bool, CommandError> {
    let n = conn
        .execute(
            "UPDATE generation_requests SET prompt_tokens=?1, completion_tokens=?2 WHERE id=?3",
            params![prompt_tokens as i64, completion_tokens as i64, request_id],
        )
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(n == 1)
}

/// The frozen snapshot JSON stored for a generation, for usage estimation.
pub fn generation_snapshot(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<String>, CommandError> {
    let mut stmt = conn
        .prepare("SELECT snapshot_json FROM generation_requests WHERE id=?1")
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    let mut rows = stmt
        .query(params![request_id])
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    match rows
        .next()
        .map_err(|e| CommandError::Storage(e.to_string()))?
    {
        None => Ok(None),
        Some(row) => Ok(Some(
            row.get(0)
                .map_err(|e| CommandError::Storage(e.to_string()))?,
        )),
    }
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
