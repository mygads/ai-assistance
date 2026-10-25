// L1 context integration (T09/A08/A09): real SQLite temp DB through the same
// schema and validation the app uses. Import persists workspace-scoped
// documents with provenance; FTS5 retrieval cites only actually-imported
// documents from the caller's workspace; validation rejects caller bugs as
// InvalidInput. No mocks; each test owns its DB file (parallel-safe).
use conversation_assistant_lib::store::{import_document_row, open_db, retrieve_sections};
use rusqlite::params;

fn temp_db(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("conv-assistant-{}-{}.db", name, std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

fn seed_docs(tag: &str) -> std::path::PathBuf {
    let path = temp_db(tag);
    let conn = open_db(&path).expect("open + schema");
    import_document_row(
        &conn,
        &format!("doc-{tag}-id"),
        "ws-harian",
        "arsitektur.txt",
        "Kami memisahkan sumber audio agar atribusi tetap jelas. Transkripsi berjalan terus selama sesi aktif.",
    )
    .expect("import ID doc");
    import_document_row(
        &conn,
        &format!("doc-{tag}-en"),
        "ws-harian",
        "follow.txt",
        "The teleprompter follows the speaker with local lexical matching. No model call per scroll.",
    )
    .expect("import EN doc");
    import_document_row(
        &conn,
        &format!("doc-{tag}-other"),
        "ws-lain",
        "rahasia.txt",
        "Rahasia workspace lain yang tidak boleh bocor ke harian.",
    )
    .expect("import other-workspace doc");
    path
}

#[test]
fn import_persists_documents_with_provenance() {
    let path = temp_db("import");
    let conn = open_db(&path).expect("open + schema");
    let doc = import_document_row(
        &conn,
        "doc-prov-1",
        "ws-harian",
        "materi.txt",
        "Bukti sumber untuk jawaban.",
    )
    .expect("import persists");
    assert_eq!(doc.workspace_id, "ws-harian");
    assert_eq!(doc.file_name, "materi.txt");
    assert!(!doc.created_at.is_empty(), "provenance timestamp recorded");
    let (ws, name, text): (String, String, String) = conn
        .query_row(
            "SELECT workspace_id, file_name, content_text FROM documents WHERE id=?1",
            params!["doc-prov-1"],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("document row readable");
    assert_eq!(
        (ws, name, text),
        (
            "ws-harian".to_string(),
            "materi.txt".to_string(),
            "Bukti sumber untuk jawaban.".to_string()
        )
    );
}

#[test]
fn retrieve_cites_only_imported_docs() {
    let path = seed_docs("retrieve");
    let conn = open_db(&path).expect("open + schema");
    let hits = retrieve_sections(&conn, "ws-harian", "atribusi", 10).expect("retrieval works");
    assert!(!hits.is_empty(), "ID query finds the ID document");
    for h in &hits {
        assert_eq!(h.workspace_id, "ws-harian");
        assert!(!h.excerpt.is_empty(), "excerpt carried for citation");
        assert!(h.rank.is_finite(), "bm25 rank is a real number");
        // Every cited reference resolves to an actually-imported document.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE id=?1 AND workspace_id=?2 AND file_name=?3",
                params![h.doc_id, h.workspace_id, h.file_name],
                |r| r.get(0),
            )
            .expect("provenance join");
        assert_eq!(count, 1, "dangling source reference: {}", h.doc_id);
    }
}

#[test]
fn retrieval_is_workspace_isolated() {
    let path = seed_docs("isolation");
    let conn = open_db(&path).expect("open + schema");
    // Same distinctive word lives in both workspaces' documents.
    let harian = retrieve_sections(&conn, "ws-harian", "workspace", 10).expect("harian search");
    assert!(
        harian.iter().all(|h| h.workspace_id == "ws-harian"),
        "cross-workspace leak: {:?}",
        harian.iter().map(|h| &h.doc_id).collect::<Vec<_>>()
    );
    let lain = retrieve_sections(&conn, "ws-lain", "workspace", 10).expect("lain search");
    assert_eq!(lain.len(), 1, "other workspace finds its own document");
    assert_eq!(lain[0].workspace_id, "ws-lain");
    let empty =
        retrieve_sections(&conn, "ws-kosong", "workspace", 10).expect("empty workspace search");
    assert!(
        empty.is_empty(),
        "no documents means no citations, not an error"
    );
}

#[test]
fn retrieval_validates_caller_input() {
    let path = seed_docs("validation");
    let conn = open_db(&path).expect("open + schema");
    assert!(
        retrieve_sections(&conn, "", "arsitektur", 10).is_err(),
        "empty workspace rejected"
    );
    assert!(
        retrieve_sections(&conn, "ws-harian", "   ", 10).is_err(),
        "empty query rejected"
    );
    assert!(
        retrieve_sections(&conn, "ws-harian", "arsitektur", 0).is_err(),
        "zero limit rejected"
    );
    assert!(
        retrieve_sections(&conn, "ws-harian", "arsitektur", 51).is_err(),
        "over-limit rejected"
    );
    // Malformed FTS5 syntax is a caller bug (InvalidInput), never a storage fault.
    let err = retrieve_sections(&conn, "ws-harian", "\"unbalanced", 10).unwrap_err();
    assert!(
        matches!(
            err,
            conversation_assistant_lib::store::CommandError::InvalidInput(_)
        ),
        "syntax error must be InvalidInput, got: {err:?}"
    );
}

#[test]
fn indonesia_and_english_retrieval() {
    let path = seed_docs("bilingual");
    let conn = open_db(&path).expect("open + schema");
    let id_hits = retrieve_sections(&conn, "ws-harian", "transkripsi", 10).expect("ID retrieval");
    assert!(
        id_hits.iter().any(|h| h.file_name == "arsitektur.txt"),
        "Indonesian query hits the ID document"
    );
    let en_hits = retrieve_sections(&conn, "ws-harian", "teleprompter", 10).expect("EN retrieval");
    assert!(
        en_hits.iter().any(|h| h.file_name == "follow.txt"),
        "English query hits the EN document"
    );
}
