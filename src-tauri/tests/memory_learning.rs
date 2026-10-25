// L1 scoped memory + feedback learning (T13/A09/A10): the real store rows,
// no mocks. AI-only provenance can never confirm (C16); explicit user
// evidence confirms and supersedes with the old row kept for rollback (C17);
// recall is workspace-scoped with profile filtering. Each test owns its DB.
use conversation_assistant_lib::store::{
    confirm_memory, load_memory, open_db, recall_memory, record_memory, supersede_memory, NewMemory,
};

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "conv-assistant-mem-{name}-{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn rec(conn: &rusqlite::Connection, m: NewMemory) -> conversation_assistant_lib::store::MemoryItem {
    record_memory(conn, &m).expect("record draft")
}

const AI_ONLY: &str = r#"[{"kind":"ai_suggestion","ref":"gen-1"}]"#;
const CORRECTED: &str =
    r#"[{"kind":"ai_suggestion","ref":"gen-1"},{"kind":"user_correction","ref":"seg-9"}]"#;
const SELF_SAID: &str = r#"[{"kind":"self_speech","ref":"seg-self-1"}]"#;

#[test]
fn ai_suggestion_alone_never_confirms() {
    let path = temp_db("noconfirm");
    let conn = open_db(&path).expect("open + schema");
    let item = rec(
        &conn,
        NewMemory::draft(
            "mem-ai",
            "ws-1",
            "s-1",
            "fact",
            "Pengguna suka teh.",
            AI_ONLY,
        ),
    );
    assert_eq!(item.status, "draft");
    let err = confirm_memory(&conn, "mem-ai").expect_err("ai-only confirm must fail");
    assert!(
        err.to_string().contains("never self-confirm"),
        "guard message: {err}"
    );
    assert_eq!(
        load_memory(&conn, "mem-ai").expect("load").unwrap().status,
        "draft"
    );
}

#[test]
fn user_correction_confirms_and_supersedes_with_rollback() {
    let path = temp_db("correct");
    let conn = open_db(&path).expect("open + schema");
    rec(
        &conn,
        NewMemory::draft(
            "mem-v1",
            "ws-1",
            "s-1",
            "fact",
            "Pengguna suka teh.",
            AI_ONLY,
        ),
    );
    // Reading the suggestion aloud (self speech quoting it) is not feedback;
    // only an explicit correction promotes it.
    let v1 = supersede_memory(&conn, "mem-v2", "mem-v1", "Pengguna suka kopi.", CORRECTED)
        .expect("supersede on user correction");
    assert_eq!((v1.status.as_str(), v1.version), ("confirmed", 2));
    assert_eq!(v1.supersedes_id, "mem-v1");
    let old = load_memory(&conn, "mem-v1")
        .expect("load")
        .expect("old row kept");
    assert_eq!(old.status, "superseded");
    assert_eq!(old.content, "Pengguna suka teh.");
    // Rollback reads the preserved row, not a reconstruction.
    let recalled = recall_memory(&conn, "ws-1", "").expect("recall");
    assert!(
        !recalled.iter().any(|m| m.id == "mem-v1"),
        "superseded rows leave recall"
    );
    assert!(recalled
        .iter()
        .any(|m| m.id == "mem-v2" && m.status == "confirmed"));
    // Confirming the superseded row is a conflict, not a silent revive.
    assert!(confirm_memory(&conn, "mem-v1").is_err());
}

#[test]
fn self_speech_evidence_confirms_without_correction() {
    let path = temp_db("selfsaid");
    let conn = open_db(&path).expect("open + schema");
    rec(
        &conn,
        NewMemory {
            profile_id: "profil-a",
            ..NewMemory::draft(
                "mem-self",
                "ws-1",
                "s-1",
                "preference",
                "Bahasa: Indonesia.",
                SELF_SAID,
            )
        },
    );
    let item = confirm_memory(&conn, "mem-self").expect("self speech confirms");
    assert_eq!(item.status, "confirmed");
    // Idempotent: confirming again is not an error and bumps nothing.
    let again = confirm_memory(&conn, "mem-self").expect("re-confirm ok");
    assert_eq!(again.version, item.version);
}

#[test]
fn recall_is_workspace_and_profile_scoped() {
    let path = temp_db("scoped");
    let conn = open_db(&path).expect("open + schema");
    rec(
        &conn,
        NewMemory::draft(
            "mem-wide",
            "ws-1",
            "s-1",
            "fact",
            "Fakta bersama.",
            SELF_SAID,
        ),
    );
    rec(
        &conn,
        NewMemory {
            profile_id: "profil-a",
            ..NewMemory::draft("mem-a", "ws-1", "s-1", "fact", "Fakta A.", SELF_SAID)
        },
    );
    rec(
        &conn,
        NewMemory {
            profile_id: "profil-b",
            ..NewMemory::draft("mem-b", "ws-1", "s-1", "fact", "Fakta B.", SELF_SAID)
        },
    );
    rec(
        &conn,
        NewMemory::draft(
            "mem-other",
            "ws-2",
            "s-9",
            "fact",
            "Fakta asing.",
            SELF_SAID,
        ),
    );
    let ids = |ws: &str, p: &str| {
        recall_memory(&conn, ws, p)
            .expect("recall")
            .iter()
            .map(|m| m.id.clone())
            .collect::<Vec<_>>()
    };
    let a = ids("ws-1", "profil-a");
    assert!(
        a.contains(&"mem-wide".to_string()) && a.contains(&"mem-a".to_string()),
        "a sees wide + own: {a:?}"
    );
    assert!(!a.contains(&"mem-b".to_string()), "a never sees b: {a:?}");
    let b = ids("ws-1", "profil-b");
    assert!(
        b.contains(&"mem-b".to_string()) && !b.contains(&"mem-a".to_string()),
        "profiles isolated: {b:?}"
    );
    let other = ids("ws-2", "profil-a");
    assert_eq!(
        other,
        vec!["mem-other".to_string()],
        "workspaces isolated: {other:?}"
    );
}

#[test]
fn curated_import_confirms_while_summaries_and_echoes_do_not() {
    let path = temp_db("curated");
    let conn = open_db(&path).expect("open + schema");
    // Mirrors the T01 MemoryStore CONFIRMING set: curated imports confirm.
    rec(
        &conn,
        NewMemory::draft(
            "mem-cur",
            "ws-1",
            "s-1",
            "fact",
            "Fakta kurasi.",
            r#"[{"kind":"curated_import","ref":"import-1"}]"#,
        ),
    );
    assert_eq!(
        confirm_memory(&conn, "mem-cur")
            .expect("curated confirms")
            .status,
        "confirmed"
    );
    // Session summaries, remote speech, and read-aloud echoes never confirm.
    for (id, kind) in [
        ("m-sum", "session_summary"),
        ("m-rem", "remote_speech"),
        ("m-read", "read_aloud"),
    ] {
        let ev = format!(r#"[{{"kind":"{kind}","ref":"r"}}]"#);
        rec(&conn, NewMemory::draft(id, "ws-1", "s-1", "fact", "x", &ev));
        assert!(
            confirm_memory(&conn, id).is_err(),
            "{kind} must not confirm"
        );
    }
}

#[test]
fn invalid_memory_input_rejected_before_write() {
    let path = temp_db("invalid");
    let conn = open_db(&path).expect("open + schema");
    let bad = |id: &str, kind: &str, content: &str, ev: &str| {
        record_memory(
            &conn,
            &NewMemory {
                id,
                workspace_id: "ws-1",
                profile_id: "",
                session_id: "s-1",
                kind,
                content,
                evidence_json: ev,
            },
        )
    };
    assert!(bad("", "fact", "x", AI_ONLY).is_err());
    assert!(bad("m", "nope", "x", AI_ONLY).is_err());
    assert!(bad("m", "fact", "  ", AI_ONLY).is_err());
    assert!(bad("m", "fact", "x", "not-json").is_err());
    assert!(bad("m", "fact", "x", r#"[{"kind":"dream"}]"#).is_err());
    assert!(confirm_memory(&conn, "missing").is_err());
    assert!(supersede_memory(&conn, "n", "missing", "x", CORRECTED).is_err());
    assert!(recall_memory(&conn, "", "").is_err());
}
