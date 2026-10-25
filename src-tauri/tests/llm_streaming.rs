// L1 LLM streaming integration (T11/A05/A18): the real store rows plus the
// real adapter seam, driven without network. A generation row moves to done
// with heuristic usage recorded; cancel mid-stream persists cancelled with
// the partial text kept; transport before any consumed chunk retries once;
// a retry landing on a different provider fails the answer instead of
// merging foreign chunks. No mocks; each test owns its DB file.
use conversation_assistant_lib::providers::{
    drive_stream, AnswerAssembler, FixtureLlmAdapter, LlmAdapter, LlmCapabilities, LlmError,
    LlmPoll, LlmScript,
};
use conversation_assistant_lib::store::{
    generation_snapshot, insert_generation, open_db, set_generation_status, set_generation_usage,
};
use rusqlite::params;

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "conv-assistant-llm-{name}-{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn seed_generation(tag: &str, snapshot_json: &str) -> (rusqlite::Connection, String) {
    let path = temp_db(tag);
    let conn = open_db(&path).expect("open + schema");
    let request_id = format!("req-{tag}");
    insert_generation(
        &conn,
        &request_id,
        "session-llm",
        &format!("gen-{tag}"),
        snapshot_json,
        "answer",
        1,
    )
    .expect("insert generation");
    (conn, request_id)
}

fn row_status_usage(conn: &rusqlite::Connection, request_id: &str) -> (String, i64, i64) {
    conn.query_row(
        "SELECT status, prompt_tokens, completion_tokens FROM generation_requests WHERE id=?1",
        params![request_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .expect("generation row readable")
}

fn run_to_end(
    make: impl FnMut() -> Box<dyn LlmAdapter>,
    cancel_after: Option<u32>,
) -> conversation_assistant_lib::providers::StreamOutcome {
    let count = std::cell::Cell::new(0u32);
    let mut on_delta = |_i: u32, _text: &str| {
        count.set(count.get() + 1);
        true
    };
    drive_stream(
        make,
        400,
        &|| cancel_after.map(|n| count.get() >= n).unwrap_or(false),
        &mut on_delta,
        1,
    )
}

#[test]
fn full_stream_records_done_plus_usage() {
    let snapshot = r#"{"session_id":"session-llm","action":"answer"}"#;
    let (conn, request_id) = seed_generation("done", snapshot);
    assert_eq!(
        generation_snapshot(&conn, &request_id)
            .expect("read snapshot")
            .as_deref(),
        Some(snapshot)
    );
    let make = || -> Box<dyn LlmAdapter> {
        Box::new(FixtureLlmAdapter::for_suggestion(
            "jawaban uji coba streaming",
        ))
    };
    let out = run_to_end(make, None);
    assert_eq!(out.status, "done");
    assert_eq!(out.text, "jawaban uji coba streaming");
    assert!(set_generation_status(&conn, &request_id, out.status).expect("status write"));
    assert!(set_generation_usage(
        &conn,
        &request_id,
        out.usage.prompt_tokens,
        out.usage.completion_tokens
    )
    .expect("usage write"));
    let (status, prompt, completion) = row_status_usage(&conn, &request_id);
    assert_eq!(status, "done");
    assert!(
        prompt > 0,
        "prompt usage estimated from the frozen snapshot"
    );
    assert!(
        completion > 0,
        "completion usage estimated from assembled text"
    );
}

#[test]
fn cancel_mid_stream_persists_cancelled_with_partial_text() {
    let (conn, request_id) = seed_generation("cancel", "{}");
    let make = || -> Box<dyn LlmAdapter> {
        Box::new(FixtureLlmAdapter::for_suggestion(
            "satu dua tiga empat lima enam tujuh delapan",
        ))
    };
    let out = run_to_end(make, Some(1));
    assert_eq!(out.status, "cancelled");
    assert!(
        !out.text.is_empty(),
        "partial text kept for the interrupted answer"
    );
    assert!(set_generation_status(&conn, &request_id, out.status).expect("status write"));
    assert_eq!(row_status_usage(&conn, &request_id).0, "cancelled");
}

#[test]
fn transport_before_output_recovers_with_one_retry() {
    let (conn, request_id) = seed_generation("retry", "{}");
    let mut calls = 0;
    let make = || -> Box<dyn LlmAdapter> {
        calls += 1;
        if calls == 1 {
            Box::new(FixtureLlmAdapter::new(vec![LlmScript::TransportError]))
        } else {
            Box::new(FixtureLlmAdapter::new(vec![LlmScript::Delta(
                "pulih".to_string(),
            )]))
        }
    };
    let out = run_to_end(make, None);
    assert_eq!((out.status, out.retries), ("done", 1));
    assert!(set_generation_status(&conn, &request_id, out.status).expect("status write"));
    assert_eq!(row_status_usage(&conn, &request_id).0, "done");
}

#[test]
fn retry_on_foreign_provider_fails_instead_of_merging() {
    struct Other(FixtureLlmAdapter);
    impl LlmAdapter for Other {
        fn provider_id(&self) -> &str {
            "provider-b"
        }
        fn capabilities(&self) -> LlmCapabilities {
            self.0.capabilities()
        }
        fn poll(&mut self) -> Result<LlmPoll, LlmError> {
            self.0.poll()
        }
        fn cancel(&self) {
            self.0.cancel()
        }
    }
    let (conn, request_id) = seed_generation("foreign", "{}");
    let mut first = true;
    let make = || -> Box<dyn LlmAdapter> {
        if first {
            first = false;
            Box::new(FixtureLlmAdapter::new(vec![LlmScript::TransportError])) as Box<dyn LlmAdapter>
        } else {
            Box::new(Other(FixtureLlmAdapter::new(vec![LlmScript::Delta(
                "asing".to_string(),
            )]))) as Box<dyn LlmAdapter>
        }
    };
    let out = run_to_end(make, None);
    assert_eq!(out.status, "failed");
    assert!(out.error.as_deref().unwrap_or("").contains("provider-b"));
    assert!(set_generation_status(&conn, &request_id, out.status).expect("status write"));
    assert_eq!(row_status_usage(&conn, &request_id).0, "failed");
    // Direct assembler proof: the foreign chunk never joins the text.
    let mut asm = AnswerAssembler::new("fixture-llm");
    asm.push_delta("fixture-llm", "sah ").unwrap();
    assert!(asm.push_delta("provider-b", "asing").is_err());
    assert_eq!(asm.text(), "sah ");
}

#[test]
fn usage_writes_report_missing_rows_honestly() {
    let (conn, _) = seed_generation("missing", "{}");
    assert!(!set_generation_usage(&conn, "req-nope", 1, 1).expect("usage write returns"));
    assert_eq!(
        generation_snapshot(&conn, "req-nope").expect("snapshot read"),
        None
    );
}
