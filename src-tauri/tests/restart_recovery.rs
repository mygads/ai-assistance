// L1 restart recovery (T15/A14, scenario C22): the real store file, closed
// and reopened the way an app restart does. Evidence (segments, snapshots,
// generations, memory) survives; machine states come back safe; generations
// interrupted by the crash are settled to cancelled, never resumed.
use conversation_assistant_lib::store::{
    confirm_memory, final_segments, generation_snapshot, generation_status, ingest_segment,
    insert_generation, load_session, load_session_summaries, open_db, persist_session,
    recall_memory, recover_session_after_restart, set_generation_status, NewMemory, SessionRecord,
    TranscriptSegment,
};

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "conv-assistant-restart-{name}-{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn gen_status(conn: &rusqlite::Connection, req: &str) -> String {
    generation_status(conn, req)
        .expect("status")
        .map(|(_, s)| s)
        .unwrap_or_default()
}

fn session_rec() -> SessionRecord {
    SessionRecord {
        id: "sess-r".to_string(),
        workspace_id: "ws-1".to_string(),
        started_at: "2026-10-25T00:00:00Z".to_string(),
        active_revision: 7,
        capture: "live".to_string(),
        generation: "streaming".to_string(),
        prompter: "tracking".to_string(),
        settings_snapshot: r#"{"model_profile_id":"profil-seimbang"}"#.to_string(),
    }
}

fn seg(id: &str, rev: u32, text: &str) -> TranscriptSegment {
    TranscriptSegment {
        id: id.to_string(),
        session_id: "sess-r".to_string(),
        source_id: "src-self".to_string(),
        revision: rev,
        start_ms: u64::from(rev) * 1000,
        end_ms: u64::from(rev) * 1000 + 500,
        status: "final".to_string(),
        text: text.to_string(),
    }
}

fn seed(path: &std::path::Path) {
    let conn = open_db(path).expect("open + schema");
    persist_session(&conn, &session_rec()).expect("session persisted");
    for (i, text) in ["satu", "dua"].iter().enumerate() {
        ingest_segment(
            &conn,
            &seg(&format!("seg-r{}", i + 1), (i + 1) as u32, text),
            "self",
        )
        .expect("segment ingested");
    }
    insert_generation(
        &conn,
        "req-live",
        "sess-r",
        "gen-1",
        r#"{"snapshot":"req-live"}"#,
        "answer",
        3,
    )
    .expect("streaming generation row");
    insert_generation(
        &conn,
        "req-done",
        "sess-r",
        "gen-0",
        r#"{"snapshot":"req-done"}"#,
        "answer",
        1,
    )
    .expect("older generation row");
    assert!(set_generation_status(&conn, "req-done", "completed").expect("settle old"));
    record_memory_helper(&conn);
    // Checkpoint the WAL so the restart test proves file durability, not
    // just same-connection visibility: close, then reopen below.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint");
}

fn record_memory_helper(conn: &rusqlite::Connection) {
    use conversation_assistant_lib::store::record_memory;
    record_memory(
        conn,
        &NewMemory {
            id: "mem-r",
            workspace_id: "ws-1",
            profile_id: "",
            session_id: "sess-r",
            kind: "fact",
            content: "Fakta restart.",
            evidence_json: r#"[{"kind":"self_speech","ref":"seg-r1"}]"#,
        },
    )
    .expect("memory row");
    confirm_memory(conn, "mem-r").expect("memory confirmed");
}

#[test]
fn restart_preserves_evidence_and_resets_machines() {
    let path = temp_db("evidence");
    seed(&path);
    // Simulate the crash/restart: the old connection is gone, the file stays.
    let conn = open_db(&path).expect("reopen after restart");
    let sess = load_session(&conn, "sess-r")
        .expect("load")
        .expect("session survives");
    assert_eq!(sess.active_revision, 7, "revision survives");
    assert_eq!(
        sess.settings_snapshot, r#"{"model_profile_id":"profil-seimbang"}"#,
        "settings survive"
    );
    // Machines come back in safe states, never mid-stream.
    assert_eq!(
        (
            sess.capture.as_str(),
            sess.generation.as_str(),
            sess.prompter.as_str()
        ),
        ("stopped", "idle", "inactive"),
        "machines reset to safe states"
    );
    let finals = final_segments(&conn, "sess-r", None, None, None).expect("finals");
    assert_eq!(finals.len(), 2, "segments survive restart");
    assert_eq!(
        generation_snapshot(&conn, "req-live")
            .expect("snapshot")
            .as_deref(),
        Some(r#"{"snapshot":"req-live"}"#),
        "in-flight snapshot survives for inspection, not resumption"
    );
    let mem = recall_memory(&conn, "ws-1", "").expect("recall");
    assert!(
        mem.iter()
            .any(|m| m.id == "mem-r" && m.status == "confirmed"),
        "memory survives"
    );
}

#[test]
fn interrupted_generations_settle_to_cancelled_once() {
    let path = temp_db("interrupted");
    seed(&path);
    let conn = open_db(&path).expect("reopen after restart");
    assert_eq!(gen_status(&conn, "req-live"), "streaming");
    let settled = recover_session_after_restart(&conn, "sess-r").expect("recover");
    assert_eq!(settled, 1, "exactly the interrupted stream settles");
    assert_eq!(gen_status(&conn, "req-live"), "cancelled");
    assert_eq!(
        gen_status(&conn, "req-done"),
        "completed",
        "terminal rows untouched"
    );
    let again = recover_session_after_restart(&conn, "sess-r").expect("recover again");
    assert_eq!(again, 0, "recovery is idempotent");
    assert!(
        recover_session_after_restart(&conn, "").is_err(),
        "empty session rejected"
    );
}

#[test]
fn summaries_survive_restart_with_coverage_intact() {
    use conversation_assistant_lib::store::{
        load_session_summary, record_session_summary, NewSessionSummary,
    };
    let path = temp_db("sumsurvive");
    seed(&path);
    {
        let conn = open_db(&path).expect("open");
        record_session_summary(
            &conn,
            &NewSessionSummary {
                id: "sum-r",
                session_id: "sess-r",
                workspace_id: "ws-1",
                coverage_start_rev: 0,
                coverage_end_rev: 2,
                summary: "Ringkasan sebelum restart.",
                refs_json: r#"["seg-r1","seg-r2"]"#,
            },
        )
        .expect("summary before restart");
    }
    let conn = open_db(&path).expect("reopen after restart");
    let sum = load_session_summary(&conn, "sum-r")
        .expect("load")
        .expect("summary survives");
    assert_eq!((sum.coverage_start_rev, sum.coverage_end_rev), (0, 2));
    assert_eq!(
        load_session_summaries(&conn, "sess-r").expect("list").len(),
        1
    );
}
