// L1 provenance-preserving compaction (T14/A11, scenario C18): the real
// store rows, no mocks. Summaries cite original evidence, coverage only moves
// forward, and compaction never deletes raw transcript or confirmed memory.
use conversation_assistant_lib::store::{
    confirm_memory, final_segments, ingest_segment, load_session_summaries, open_db,
    persist_session, recall_memory, record_memory, record_session_summary, NewMemory,
    NewSessionSummary, SessionRecord, TranscriptSegment,
};

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "conv-assistant-compact-{name}-{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn seg(id: &str, session: &str, source: &str, rev: u32, text: &str) -> TranscriptSegment {
    TranscriptSegment {
        id: id.to_string(),
        session_id: session.to_string(),
        source_id: source.to_string(),
        revision: rev,
        start_ms: u64::from(rev) * 1000,
        end_ms: u64::from(rev) * 1000 + 500,
        status: "final".to_string(),
        text: text.to_string(),
    }
}

fn setup(name: &str) -> rusqlite::Connection {
    let path = temp_db(name);
    let conn = open_db(&path).expect("open + schema");
    record_memory(
        &conn,
        &NewMemory {
            id: "mem-seed",
            workspace_id: "ws-1",
            profile_id: "",
            session_id: "sess-1",
            kind: "fact",
            content: "seed",
            evidence_json: r#"[{"kind":"self_speech","ref":"seg-0"}]"#,
        },
    )
    .expect("workspace row");
    persist_session(
        &conn,
        &SessionRecord {
            id: "sess-1".to_string(),
            workspace_id: "ws-1".to_string(),
            started_at: "2026-10-25T00:00:00Z".to_string(),
            active_revision: 0,
            capture: "live".to_string(),
            generation: "idle".to_string(),
            prompter: "tracking".to_string(),
            settings_snapshot: "{}".to_string(),
        },
    )
    .expect("session row");
    for (i, text) in ["arsitektur", "konteks", "ringkasan"].iter().enumerate() {
        ingest_segment(
            &conn,
            &seg(
                &format!("seg-{}", i + 1),
                "sess-1",
                "src-self",
                (i + 1) as u32,
                text,
            ),
            "self",
        )
        .expect("final ingested");
    }
    confirm_memory(&conn, "mem-seed").expect("seed confirmed");
    conn
}

#[test]
fn summary_preserves_raw_transcript_and_memory() {
    let conn = setup("preserve");
    record_session_summary(
        &conn,
        &NewSessionSummary {
            id: "sum-1",
            session_id: "sess-1",
            workspace_id: "ws-1",
            coverage_start_rev: 0,
            coverage_end_rev: 3,
            summary: "Membahas arsitektur dan konteks.",
            refs_json: r#"["seg-1","seg-2","seg-3"]"#,
        },
    )
    .expect("summary recorded");
    // Raw evidence is intact: compaction deletes nothing.
    let finals = final_segments(&conn, "sess-1", None, None, None).expect("finals");
    assert_eq!(finals.len(), 3, "all finals survive compaction");
    assert!(finals.iter().any(|f| f.text == "konteks"));
    let mem = recall_memory(&conn, "ws-1", "").expect("recall");
    assert!(
        mem.iter()
            .any(|m| m.id == "mem-seed" && m.status == "confirmed"),
        "confirmed memory survives"
    );
    let sums = load_session_summaries(&conn, "sess-1").expect("summaries");
    assert_eq!(sums.len(), 1);
    assert_eq!(
        (sums[0].coverage_start_rev, sums[0].coverage_end_rev),
        (0, 3)
    );
}

#[test]
fn coverage_extends_forward_and_rejects_backward() {
    let conn = setup("extend");
    let sum = |id: &str, start: i64, end: i64, refs: &str| {
        record_session_summary(
            &conn,
            &NewSessionSummary {
                id,
                session_id: "sess-1",
                workspace_id: "ws-1",
                coverage_start_rev: start,
                coverage_end_rev: end,
                summary: "Ringkasan.",
                refs_json: refs,
            },
        )
    };
    sum("sum-1", 0, 3, r#"["seg-1"]"#).expect("first range");
    // A newer correction arrives; the next summary extends past it and may
    // cite the older summary alongside fresh evidence.
    ingest_segment(
        &conn,
        &seg("seg-4", "sess-1", "src-self", 4, "koreksi"),
        "self",
    )
    .expect("correction ingested");
    sum("sum-2", 3, 5, r#"["sum-1","seg-4"]"#)
        .expect("forward extension cites old summary + new evidence");
    assert_eq!(
        load_session_summaries(&conn, "sess-1").expect("load").len(),
        2
    );
    // Going back over the newer correction is rejected, not silently applied.
    assert!(
        sum("sum-3", 0, 2, r#"["seg-1"]"#).is_err(),
        "backward coverage rejected"
    );
}

#[test]
fn ungrounded_summaries_rejected_before_write() {
    let conn = setup("ungrounded");
    let sum = |id: &str, start: i64, end: i64, summary: &str, refs: &str| {
        record_session_summary(
            &conn,
            &NewSessionSummary {
                id,
                session_id: "sess-1",
                workspace_id: "ws-1",
                coverage_start_rev: start,
                coverage_end_rev: end,
                summary,
                refs_json: refs,
            },
        )
    };
    // Summary-of-summary with no original evidence loses the source: reject.
    assert!(sum("sum-x", 0, 3, "Ringkasan.", r#"["sum-1","sum-2"]"#).is_err());
    assert!(sum("sum-y", 0, 3, "Ringkasan.", r#"[]"#).is_err());
    assert!(sum("sum-z", 0, 3, "Ringkasan.", "not-json").is_err());
    // Empty ranges and empty text are rejected too.
    assert!(sum("sum-e1", 3, 3, "Ringkasan.", r#"["seg-1"]"#).is_err());
    assert!(sum("sum-e2", 5, 3, "Ringkasan.", r#"["seg-1"]"#).is_err());
    assert!(sum("sum-e3", 0, 3, "   ", r#"["seg-1"]"#).is_err());
    assert!(
        load_session_summaries(&conn, "sess-1")
            .expect("load")
            .is_empty(),
        "nothing persisted"
    );
}
