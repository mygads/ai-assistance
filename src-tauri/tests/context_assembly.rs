// L1 context assembly (T12/A04/A13): the real Send context pipeline —
// sanitized FTS query from question texts, workspace-scoped retrieval, profile
// budgets, greedy pack with recorded truncation — persisted into the
// generation row and read back. No mocks; each test owns its DB file.
use conversation_assistant_lib::context::{assemble_send_context, build_retrieval_query};
use conversation_assistant_lib::store::{
    generation_snapshot, import_document_row, insert_generation, open_db, retrieve_sections,
    RetrievedSection,
};
use rusqlite::params;

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "conv-assistant-ctxasm-{name}-{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn seed_session(conn: &rusqlite::Connection, session: &str, workspace: &str) {
    conn.execute(
        "INSERT INTO workspaces(id,title) VALUES(?1,?2)",
        params![workspace, "W"],
    )
    .expect("workspace");
    conn.execute(
        "INSERT INTO sessions(id,workspace_id,started_at,settings_snapshot) VALUES(?1,?2,?3,?4)",
        params![session, workspace, "2026-10-25T00:00:00Z", "{}"],
    )
    .expect("session");
    for (suffix, role, device) in [("self", "self", "mic"), ("remote", "remote", "loop")] {
        conn.execute(
            "INSERT INTO audio_sources(id,session_id,device_id,role) VALUES(?1,?2,?3,?4)",
            params![format!("{session}:{suffix}"), session, device, role],
        )
        .expect("source");
    }
}

fn seed_final(
    conn: &rusqlite::Connection,
    id: &str,
    session: &str,
    role: &str,
    text: &str,
    start_ms: i64,
) {
    conn.execute(
        "INSERT INTO transcript_segments(id,session_id,source_id,start_ms,end_ms,revision,status,text) VALUES(?1,?2,?3,?4,?5,1,'final',?6)",
        params![id, session, format!("{session}:{role}"), start_ms, start_ms + 400, text],
    )
    .expect("final segment");
}

fn section(doc: &str, file: &str, excerpt: &str) -> RetrievedSection {
    RetrievedSection {
        doc_id: doc.to_string(),
        workspace_id: "ws-asm".to_string(),
        file_name: file.to_string(),
        excerpt: excerpt.to_string(),
        rank: -1.0,
    }
}

#[test]
fn retrieval_query_drives_workspace_scoped_excerpts() {
    let path = temp_db("retrieve");
    let conn = open_db(&path).expect("open + schema");
    seed_session(&conn, "s-asm", "ws-asm");
    seed_final(
        &conn,
        "q-1",
        "s-asm",
        "remote",
        "Mengapa memilih arsitektur ini?",
        0,
    );
    import_document_row(
        &conn,
        "doc-arch",
        "ws-asm",
        "arsitektur.txt",
        "Panduan arsitektur sistem untuk memilih pola yang tepat.",
    )
    .expect("import arch doc");
    import_document_row(
        &conn,
        "doc-other",
        "ws-asm",
        "cuaca.txt",
        "Laporan cuaca cerah hari ini.",
    )
    .expect("import other doc");
    import_document_row(
        &conn,
        "doc-foreign",
        "ws-lain",
        "asing.txt",
        "Arsitektur asing.",
    )
    .expect("import foreign-workspace doc");

    let q = build_retrieval_query(&["Mengapa memilih arsitektur ini?"]);
    assert!(q.contains("arsitektur"), "query keeps content words: {q}");
    let hits = retrieve_sections(&conn, "ws-asm", &q, 3).expect("retrieve");
    let ids: Vec<&str> = hits.iter().map(|h| h.doc_id.as_str()).collect();
    assert!(ids.contains(&"doc-arch"), "arch doc retrieved: {ids:?}");
    assert!(
        !ids.contains(&"doc-other"),
        "unrelated doc excluded: {ids:?}"
    );
    assert!(
        !ids.contains(&"doc-foreign"),
        "other workspace excluded: {ids:?}"
    );
}

#[test]
fn snapshot_row_carries_profile_retrieval_and_packet() {
    let path = temp_db("snapshot");
    let conn = open_db(&path).expect("open + schema");
    seed_session(&conn, "s-asm", "ws-asm");
    seed_final(
        &conn,
        "q-1",
        "s-asm",
        "remote",
        "Mengapa memilih arsitektur ini?",
        0,
    );
    seed_final(
        &conn,
        "s-1",
        "s-asm",
        "self",
        "Fokus saya adalah respons cepat.",
        950,
    );
    import_document_row(
        &conn,
        "doc-arch",
        "ws-asm",
        "arsitektur.txt",
        "Panduan arsitektur sistem untuk memilih pola yang tepat.",
    )
    .expect("import doc");

    let targets = [("q-1", "Mengapa memilih arsitektur ini?")];
    let self_ctx = [("s-1", "Fokus saya adalah respons cepat.")];
    let q = build_retrieval_query(&["Mengapa memilih arsitektur ini?"]);
    let retrieved = retrieve_sections(&conn, "ws-asm", &q, 3).expect("retrieve");
    assert!(!retrieved.is_empty(), "seeded doc is retrieved");
    let packet = assemble_send_context("profil-seimbang", &targets, &self_ctx, &retrieved, &q);
    assert_eq!(packet["model_profile_id"], "profil-seimbang");
    assert_eq!(packet["fixture_profile"], true);
    assert_eq!(packet["truncated"], false);
    let included: Vec<&str> = packet["included"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect();
    assert!(included.contains(&"q-1"), "question kept: {included:?}");
    assert!(included.contains(&"doc-arch"), "excerpt kept: {included:?}");

    let snapshot = serde_json::json!({
        "session_id": "s-asm",
        "action": "answer",
        "model_profile_id": "profil-seimbang",
        "retrieval_query": q,
        "retrieved": retrieved.iter().map(|s| serde_json::json!({
            "doc_id": s.doc_id, "file_name": s.file_name, "excerpt": s.excerpt,
        })).collect::<Vec<_>>(),
        "context_packet": packet,
    });
    insert_generation(
        &conn,
        "req-asm-1",
        "s-asm",
        "gen-asm-1",
        &snapshot.to_string(),
        "answer",
        1,
    )
    .expect("insert generation");
    let back: serde_json::Value = serde_json::from_str(
        &generation_snapshot(&conn, "req-asm-1")
            .expect("read snapshot")
            .expect("snapshot present"),
    )
    .expect("snapshot is JSON");
    assert_eq!(back["model_profile_id"], "profil-seimbang");
    assert_eq!(back["retrieved"][0]["doc_id"], "doc-arch");
    assert_eq!(back["context_packet"]["truncated"], false);
}

#[test]
fn hemat_repack_truncates_while_seimbang_keeps() {
    let long_target = "kata ".repeat(1200);
    let targets = [("q-big", long_target.as_str())];
    let excerpt = "kata kunci dokumen ".repeat(50);
    let retrieved = [section("doc-big", "besar.txt", &excerpt)];
    let q = "kata";

    let hemat = assemble_send_context("profil-hemat", &targets, &[], &retrieved, q);
    assert_eq!(hemat["model_profile_id"], "profil-hemat");
    assert_eq!(hemat["truncated"], true);
    assert!(hemat["dropped_item_ids"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d == "doc-big"));
    // The must-keep question survives even when it alone exceeds the budget.
    assert!(hemat["included"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == "q-big"));
    assert!(hemat["estimated_input_tokens"].as_u64().unwrap() >= 1400);

    let seimbang = assemble_send_context("profil-seimbang", &targets, &[], &retrieved, q);
    assert_eq!(seimbang["truncated"], false);
    assert!(seimbang["dropped_item_ids"].as_array().unwrap().is_empty());
}
