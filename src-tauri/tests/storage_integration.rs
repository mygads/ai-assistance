// L1 storage integration: real SQLite (temp file) through the same schema and
// validation the app uses. Session row -> audio sources -> transcript segments
// -> ordered final reads. No mocks; the DB file lives in std::env::temp_dir.
use conversation_assistant_lib::store::{
    apply_correction, final_segments, generation_status, ingest_segment, insert_generation,
    load_session, next_suggestion_version, open_db, persist_session, set_generation_status,
    IngestOutcome, SessionRecord, TranscriptSegment,
};
use rusqlite::params;
use std::collections::HashMap;

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("conv-assistant-{}-{}.db", name, std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

#[test]
fn session_sources_and_segments_roundtrip() {
    let path = temp_db("roundtrip");
    let conn = open_db(&path).expect("open + schema");
    conn.execute(
        "INSERT INTO workspaces(id,title) VALUES(?1,?2)",
        params!["ws-1", "Harian"],
    )
    .expect("workspace");
    conn.execute(
        "INSERT INTO sessions(id,workspace_id,started_at,settings_snapshot) VALUES(?1,?2,?3,?4)",
        params!["session-1", "ws-1", "2026-10-25T00:00:00Z", "{}"],
    )
    .expect("session");
    conn.execute(
        "INSERT INTO audio_sources(id,session_id,device_id,role) VALUES(?1,?2,?3,?4)",
        params!["session-1:self", "session-1", "default-microphone", "self"],
    )
    .expect("mic source");
    conn.execute(
        "INSERT INTO audio_sources(id,session_id,device_id,role) VALUES(?1,?2,?3,?4)",
        params![
            "session-1:remote",
            "session-1",
            "default-loopback",
            "remote"
        ],
    )
    .expect("loopback source");

    let segments = [
        TranscriptSegment {
            id: "seg-partial".to_string(),
            session_id: "session-1".to_string(),
            source_id: "session-1:remote".to_string(),
            revision: 0,
            start_ms: 0,
            end_ms: 500,
            status: "partial".to_string(),
            text: "Mengapa memilih".to_string(),
        },
        TranscriptSegment {
            id: "seg-final".to_string(),
            session_id: "session-1".to_string(),
            source_id: "session-1:remote".to_string(),
            revision: 1,
            start_ms: 0,
            end_ms: 900,
            status: "final".to_string(),
            text: "Mengapa memilih arsitektur ini?".to_string(),
        },
    ];
    for seg in &segments {
        seg.validate().expect("segment validates");
        conn.execute(
            "INSERT INTO transcript_segments(id,session_id,source_id,start_ms,end_ms,revision,status,text) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![seg.id, seg.session_id, seg.source_id, seg.start_ms as i64, seg.end_ms as i64, seg.revision, seg.status, seg.text],
        )
        .expect("insert segment");
    }
    // Self and remote paths stay separately attributable by source role.
    let mut finals_by_role: HashMap<String, u32> = HashMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT s.role, COUNT(*) FROM transcript_segments t JOIN audio_sources s ON s.id = t.source_id WHERE t.status='final' GROUP BY s.role",
        )
        .expect("query");
    let mut rows = stmt.query([]).expect("rows");
    while let Some(row) = rows.next().expect("row") {
        finals_by_role.insert(row.get(0).expect("role"), row.get(1).expect("count"));
    }
    assert_eq!(finals_by_role.get("remote"), Some(&1));
    assert_eq!(finals_by_role.get("self"), None);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn invalid_segments_rejected_before_write() {
    let bad = TranscriptSegment {
        id: "".to_string(),
        session_id: "session-1".to_string(),
        source_id: "session-1:remote".to_string(),
        revision: 0,
        start_ms: 2000,
        end_ms: 1000,
        status: "draft".to_string(),
        text: "x".to_string(),
    };
    assert!(bad.validate().is_err());
}

fn slice_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        workspace_id: "ws-slice".to_string(),
        started_at: "2026-10-25T00:00:00Z".to_string(),
        active_revision: 7,
        capture: "live".to_string(),
        generation: "idle".to_string(),
        prompter: "inactive".to_string(),
        settings_snapshot: "{\"model_profile_id\":\"default\"}".to_string(),
    }
}

fn slice_seg(
    segment: &str,
    source: &str,
    revision: u32,
    status: &str,
    text: &str,
) -> TranscriptSegment {
    TranscriptSegment {
        id: segment.to_string(),
        session_id: "slice-1".to_string(),
        source_id: source.to_string(),
        revision,
        start_ms: 0,
        end_ms: 500,
        status: status.to_string(),
        text: text.to_string(),
    }
}

/// T03 vertical slice at the storage layer: ingest discipline (partial ->
/// final, stale ignored, role-mix conflict), finals-only snapshot reads,
/// generation lifecycle with cancel fencing, correction as a new revision,
/// and survival of everything across a close/reopen (restart persistence).
#[test]
fn slice_ingest_snapshot_cancel_correction_persist() {
    let path = temp_db("slice");
    let conn = open_db(&path).expect("open + migrate");
    persist_session(&conn, &slice_session("slice-1")).expect("persist session");

    // Partial hypothesis, then final; duplicate final is stale-ignored.
    assert_eq!(
        ingest_segment(
            &conn,
            &slice_seg("q-1", "loop", 0, "partial", "Mengapa memilih"),
            "remote"
        )
        .expect("partial"),
        IngestOutcome::Inserted
    );
    assert_eq!(
        ingest_segment(
            &conn,
            &slice_seg("q-1", "loop", 1, "final", "Mengapa memilih arsitektur ini?"),
            "remote"
        )
        .expect("final"),
        IngestOutcome::Committed
    );
    assert_eq!(
        ingest_segment(
            &conn,
            &slice_seg("q-1", "loop", 1, "final", "Mengapa memilih arsitektur ini?"),
            "remote"
        )
        .expect("dup"),
        IngestOutcome::StaleIgnored
    );
    // A late partial for a committed final must not clobber it.
    assert_eq!(
        ingest_segment(
            &conn,
            &slice_seg("q-1", "loop", 0, "partial", "Mengapa"),
            "remote"
        )
        .expect("late partial"),
        IngestOutcome::StaleIgnored
    );
    // Self path stays separately attributable; role mixing is a conflict.
    ingest_segment(
        &conn,
        &slice_seg("s-1", "mic", 0, "final", "Fokus saya."),
        "self",
    )
    .expect("self final");
    assert!(
        ingest_segment(
            &conn,
            &slice_seg("s-1", "mic", 0, "final", "Fokus saya."),
            "remote"
        )
        .is_err(),
        "source role mixing must conflict"
    );

    // Snapshot reads see finals only, role-attributed, timeline ordered.
    let finals = final_segments(&conn, "slice-1", None, None, None).expect("finals");
    assert_eq!(finals.len(), 2);
    assert_eq!(finals[0].segment_id, "q-1");
    assert_eq!(finals[0].role, "remote");
    assert_eq!(finals[1].role, "self");
    // Partial-only segment never appears.
    ingest_segment(
        &conn,
        &slice_seg("q-9", "loop", 0, "partial", "Hmm"),
        "remote",
    )
    .expect("stray partial");
    assert_eq!(
        final_segments(&conn, "slice-1", None, None, None)
            .expect("finals")
            .len(),
        2
    );

    // Generation lifecycle: v1 recorded as streaming, cancel fences it.
    assert_eq!(next_suggestion_version(&conn, "slice-1").expect("v"), 1);
    insert_generation(
        &conn,
        "req-1",
        "slice-1",
        "gen-1",
        "{\"snapshot\":1}",
        "answer",
        1,
    )
    .expect("insert generation");
    assert_eq!(next_suggestion_version(&conn, "slice-1").expect("v"), 2);
    assert_eq!(
        generation_status(&conn, "req-1").expect("status"),
        Some(("slice-1".to_string(), "streaming".to_string()))
    );
    assert!(set_generation_status(&conn, "req-1", "cancelled").expect("cancel"));
    assert_eq!(
        generation_status(&conn, "req-1")
            .expect("status")
            .unwrap()
            .1,
        "cancelled"
    );

    // Correction amends as a new final revision with provenance, not a silent overwrite.
    assert!(apply_correction(
        &conn,
        "slice-1",
        "q-1",
        "Mengapa memilih arsitektur ini, tepatnya?"
    )
    .expect("correct"));
    let after = final_segments(&conn, "slice-1", None, None, None).expect("finals");
    let q1 = after.iter().find(|f| f.segment_id == "q-1").expect("q-1");
    assert!(q1.text.contains("tepatnya"));
    assert_eq!(q1.revision, 2);
    assert!(!apply_correction(&conn, "slice-1", "missing", "x").expect("missing correction"));

    // Restart persistence: close, reopen, everything durable survives while
    // machine states reset to safe values.
    drop(conn);
    let conn2 = open_db(&path).expect("reopen + migrate");
    let rec = load_session(&conn2, "slice-1")
        .expect("load")
        .expect("session row");
    assert_eq!(rec.active_revision, 7);
    assert_eq!(rec.capture, "stopped");
    assert_eq!(rec.generation, "idle");
    assert!(rec.settings_snapshot.contains("model_profile_id"));
    assert_eq!(
        final_segments(&conn2, "slice-1", None, None, None)
            .expect("finals")
            .len(),
        2
    );
    assert_eq!(
        generation_status(&conn2, "req-1")
            .expect("status")
            .unwrap()
            .1,
        "cancelled"
    );
    assert_eq!(next_suggestion_version(&conn2, "slice-1").expect("v"), 2);
    drop(conn2);
    let _ = std::fs::remove_file(&path);
}
