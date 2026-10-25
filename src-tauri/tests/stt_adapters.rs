// L1 STT-adapter integration: scripted provider wire streams -> normalized
// events -> the REAL SQLite ingest path (ingest_segment on a temp DB). No
// network, no hardware; the DB, the discipline, and the conflict rules are
// real. Mirrors tests/provider/*.json replayed at L1 by test:replay.
use conversation_assistant_lib::providers::{
    soniox_session_script, AdapterPoll, ProviderKind, ReplayAdapter, StreamCtx, SttAdapter,
    SttError, TranscriptStatus, WireMessage,
};
use conversation_assistant_lib::store::{ingest_segment, open_db, IngestOutcome};
use rusqlite::params;

const SESSION: &str = "stt-int-01";
const SOURCE: &str = "stt-int-01:remote";

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("conv-assistant-{}-{}.db", name, std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

fn open_session_db(name: &str) -> rusqlite::Connection {
    let path = temp_db(name);
    let conn = open_db(&path).expect("open + schema");
    conn.execute(
        "INSERT INTO workspaces(id,title) VALUES(?1,?2)",
        params!["ws-p", "Harian"],
    )
    .expect("workspace");
    conn.execute(
        "INSERT INTO sessions(id,workspace_id,started_at,settings_snapshot) VALUES(?1,?2,?3,?4)",
        params![SESSION, "ws-p", "2026-10-25T00:00:00Z", "{}"],
    )
    .expect("session");
    conn
}

fn drain_events(
    adapter: &mut ReplayAdapter,
) -> (
    Vec<conversation_assistant_lib::providers::ProviderTranscriptEvent>,
    bool,
) {
    let mut events = Vec::new();
    let mut disconnected = false;
    loop {
        match adapter
            .poll()
            .expect("adapter poll must not fail the stream")
        {
            AdapterPoll::Event(e) => events.push(e),
            AdapterPoll::Disconnected { recoverable } => {
                assert!(recoverable, "fixture disconnect must be recoverable");
                disconnected = true;
                break;
            }
            AdapterPoll::EndOfStream => break,
        }
    }
    (events, disconnected)
}

#[test]
fn scripted_stream_ingests_partial_final_discipline() {
    let conn = open_session_db("stt-adapters-stream");
    let (ctx1, script1, ctx2, script2) = soniox_session_script(SESSION);
    assert_eq!(ctx1.connection_id, "conn-1");

    let mut adapter = ReplayAdapter::new(ctx1, script1);
    let (events, disconnected) = drain_events(&mut adapter);
    assert!(disconnected);
    // partial, partial, final: the empty frame never became an event.
    assert_eq!(events.len(), 3);
    let outcomes: Vec<_> = events
        .iter()
        .map(|e| ingest_segment(&conn, &e.clone().into_segment(), "remote").expect("ingest"))
        .collect();
    assert_eq!(
        outcomes,
        vec![
            IngestOutcome::Inserted,
            IngestOutcome::ReplacedHypothesis,
            IngestOutcome::Committed
        ]
    );
    assert_eq!(events[2].text, "Mengapa memilih arsitektur ini?");

    // Reconnect tail on conn-2 with a restarted provider clock: fresh offset
    // maps provider 9000ms onto session 18600ms. First write of a new segment
    // row is Inserted even when final; Committed is the partial→final turn.
    let mut adapter2 = ReplayAdapter::new(ctx2, script2);
    let (tail, _) = drain_events(&mut adapter2);
    assert_eq!(tail.len(), 1);
    assert_eq!((tail[0].start_ms, tail[0].end_ms), (18600, 19100));
    assert_eq!(
        ingest_segment(&conn, &tail[0].clone().into_segment(), "remote").expect("tail ingest"),
        IngestOutcome::Inserted
    );

    // Replaying the same committed final is stale, not a duplicate row.
    assert_eq!(
        ingest_segment(&conn, &tail[0].clone().into_segment(), "remote").expect("re-ingest"),
        IngestOutcome::StaleIgnored
    );
}

#[test]
fn role_mix_across_same_source_is_conflict() {
    let conn = open_session_db("stt-adapters-rolemix");
    let (ctx1, script1, _, _) = soniox_session_script(SESSION);
    let mut adapter = ReplayAdapter::new(ctx1, script1);
    let (events, _) = drain_events(&mut adapter);
    ingest_segment(&conn, &events[0].clone().into_segment(), "remote").expect("first ingest");
    let err = ingest_segment(&conn, &events[0].clone().into_segment(), "self").unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("already attributed"),
        "expected attribution conflict, got: {msg}"
    );
}

#[test]
fn deepgram_words_map_with_offset_and_malformed_fails_loudly() {
    use conversation_assistant_lib::audio::ProviderOffset;
    use conversation_assistant_lib::providers::normalize_deepgram;
    let conn = open_session_db("stt-adapters-deepgram");
    let mut ctx = StreamCtx::new(
        SESSION,
        SOURCE,
        "conn-dg",
        ProviderOffset::fresh(9600, 0),
        "seg-dg",
    );
    let raw = serde_json::json!({"is_final": true,
        "channel": {"alternatives": [{"transcript": "How do you keep context?",
            "words": [{"word": "How", "start": 1.45, "end": 1.6},
                      {"word": "context?", "start": 1.9, "end": 2.0}]}]}});
    let e = normalize_deepgram(&raw, &mut ctx).expect("deepgram normalize");
    assert_eq!((e.start_ms, e.end_ms), (11050, 11600));
    assert_eq!(e.status, TranscriptStatus::Final);
    assert_eq!(
        ingest_segment(&conn, &e.into_segment(), "remote").expect("ingest"),
        IngestOutcome::Inserted // first write of a new row, even when final
    );
    // Malformed wire is a typed error, never an empty event.
    let bad = serde_json::json!({"is_final": true});
    assert!(matches!(
        normalize_deepgram(&bad, &mut ctx),
        Err(SttError::MalformedMessage(_))
    ));
    // Fatal transport/auth errors surface as Err, not as a quiet disconnect.
    let mut doomed = ReplayAdapter::new(
        StreamCtx::new(
            SESSION,
            SOURCE,
            "conn-x",
            ProviderOffset::fresh(0, 0),
            "seg-x",
        ),
        vec![WireMessage::Transcript {
            provider: ProviderKind::Deepgram,
            raw: bad,
        }],
    );
    assert!(matches!(doomed.poll(), Err(SttError::MalformedMessage(_))));
}
