//! T12: model-profile budgets and retrieval-backed send context.
//!
//! The fixture profiles below are NOT real models: they declare input/output
//! token budgets (mirroring `ModelProfile` in src/domain/context.ts) so a
//! profile switch repacks the Send context deterministically. Every packet
//! carries `fixture_profile: true` so no consumer mistakes a budget for a
//! live provider capability (C21: fixture-only parts distinctly labeled).
//!
//! Assembly rule: question targets first (must-keep), then retrieved excerpts,
//! then self context — all greedy within `budget = input_limit - reserve`
//! after the same 0.85 uncertainty margin the TS domain uses. Anything that
//! does not fit is listed in `dropped_item_ids` with `truncated: true`; the
//! in-flight prompt never silently omits without recording it.

use crate::providers::estimate_llm_tokens;
use crate::store::RetrievedSection;

/// Fixture model profile: budget declaration only, no live route.
pub struct ProfileBudget {
    pub id: &'static str,
    pub input_limit: u32,
    pub output_limit: u32,
    /// Always true until a real provider route lands (T19): labels the
    /// budget as fixture so C21 evidence can tell it apart from live caps.
    pub fixture: bool,
}

pub const PROFILES: &[ProfileBudget] = &[
    ProfileBudget {
        id: "profil-hemat",
        input_limit: 2000,
        output_limit: 500,
        fixture: true,
    },
    ProfileBudget {
        id: "profil-seimbang",
        input_limit: 6000,
        output_limit: 2000,
        fixture: true,
    },
    ProfileBudget {
        id: "profil-detail",
        input_limit: 12000,
        output_limit: 4000,
        fixture: true,
    },
];

/// Unknown ids fall back to the balanced profile (documented, never a panic).
pub fn profile_budget(id: &str) -> &'static ProfileBudget {
    PROFILES.iter().find(|p| p.id == id).unwrap_or(&PROFILES[1])
}

/// Reserve for the answer, mirroring the TS domain: at least 1024 tokens,
/// at most 10% of the input budget, capped by the output limit.
pub fn reserved_output(profile: &ProfileBudget) -> u32 {
    profile.output_limit.min(1024.max(profile.input_limit / 10))
}

/// Usable input budget after the reserve and the 0.85 uncertainty margin.
pub fn input_budget(profile: &ProfileBudget) -> u32 {
    let hard = profile.input_limit.saturating_sub(reserved_output(profile));
    ((hard as f64) * 0.85).floor() as u32
}

/// Build a safe FTS5 query from question texts. User speech is data, never
/// raw FTS syntax (ARCHITECTURE 9.2): keep distinct alphanumeric tokens of
/// length >= 4, lowercase them, take 12, OR-join. Returns "" when nothing
/// usable remains; callers skip retrieval instead of sending junk.
pub fn build_retrieval_query(texts: &[&str]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for text in texts {
        let mut token = String::new();
        let mut flush = |token: &mut String| {
            if token.chars().count() >= 4 {
                let lower = token.to_lowercase();
                if seen.insert(lower.clone()) {
                    out.push(lower);
                }
            }
            token.clear();
        };
        for ch in text.chars() {
            if ch.is_alphanumeric() {
                token.push(ch);
            } else {
                flush(&mut token);
            }
        }
        flush(&mut token);
        if out.len() >= 12 {
            break;
        }
    }
    out.truncate(12);
    out.join(" OR ")
}

/// One ranked context item awaiting budget packing.
pub struct ContextItem {
    pub id: String,
    pub kind: &'static str,
    pub text: String,
    pub priority: u8,
    pub must_keep: bool,
}

/// Greedy pack within `budget`: priority order, must-keep items always fit.
/// Returns (included, dropped_ids, estimated_tokens, truncated).
pub fn pack_items(
    items: &[ContextItem],
    budget: u32,
) -> (Vec<&ContextItem>, Vec<String>, u32, bool) {
    let mut ordered: Vec<&ContextItem> = items.iter().collect();
    ordered.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
    let mut included = Vec::new();
    let mut dropped = Vec::new();
    let mut used = 0u32;
    for item in ordered {
        let cost = estimate_llm_tokens(item.text.len());
        if item.must_keep || used.saturating_add(cost) <= budget {
            used = used.saturating_add(cost);
            included.push(item);
        } else {
            dropped.push(item.id.clone());
        }
    }
    let truncated = !dropped.is_empty();
    (included, dropped, used, truncated)
}

/// Assemble the retrieval-backed context packet recorded in the Send snapshot.
/// Targets = committed remote question segments (must-keep); retrieved =
/// workspace-scoped FTS excerpts; self_ctx = relevant self speech.
pub fn assemble_send_context(
    profile_id: &str,
    targets: &[(&str, &str)],
    self_ctx: &[(&str, &str)],
    retrieved: &[RetrievedSection],
    retrieval_query: &str,
) -> serde_json::Value {
    let profile = profile_budget(profile_id);
    let budget = input_budget(profile);
    let reserve = reserved_output(profile);
    let mut items = Vec::new();
    for (id, text) in targets {
        items.push(ContextItem {
            id: id.to_string(),
            kind: "history",
            text: text.to_string(),
            priority: 100,
            must_keep: true,
        });
    }
    for sec in retrieved {
        items.push(ContextItem {
            id: sec.doc_id.clone(),
            kind: "retrieved_section",
            text: format!("{}: {}", sec.file_name, sec.excerpt),
            priority: 50,
            must_keep: false,
        });
    }
    for (id, text) in self_ctx {
        items.push(ContextItem {
            id: id.to_string(),
            kind: "history",
            text: text.to_string(),
            priority: 10,
            must_keep: false,
        });
    }
    let (included, dropped, used, truncated) = pack_items(&items, budget);
    serde_json::json!({
        "model_profile_id": profile.id,
        "fixture_profile": profile.fixture,
        "budget_input_tokens": budget,
        "reserved_output_tokens": reserve,
        "estimated_input_tokens": used,
        "retrieval_query": retrieval_query,
        "included": included.iter().map(|i| serde_json::json!({
            "id": i.id, "kind": i.kind,
            "tokens": estimate_llm_tokens(i.text.len()),
        })).collect::<Vec<_>>(),
        "dropped_item_ids": dropped,
        "truncated": truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(doc: &str) -> RetrievedSection {
        RetrievedSection {
            doc_id: doc.to_string(),
            workspace_id: "ws".to_string(),
            file_name: format!("{doc}.txt"),
            // ~3800 chars (~950 heuristic tokens): three of these overflow the
            // hemat budget (1275) but fit comfortably in detail (9180).
            excerpt: "kata kunci dokumen ".repeat(200),
            rank: -1.0,
        }
    }

    #[test]
    fn unknown_profile_falls_back_to_seimbang() {
        assert_eq!(profile_budget("nope").id, "profil-seimbang");
        assert_eq!(profile_budget("profil-hemat").input_limit, 2000);
    }

    #[test]
    fn reserve_is_bounded_by_output_limit() {
        assert_eq!(reserved_output(profile_budget("profil-hemat")), 500);
        assert_eq!(reserved_output(profile_budget("profil-seimbang")), 1024);
        assert_eq!(reserved_output(profile_budget("profil-detail")), 1200);
    }

    #[test]
    fn retrieval_query_sanitizes_user_speech() {
        let q = build_retrieval_query(&["Mengapa \"memilih\" arsitektur (ini)?", "a bb ccc dddd"]);
        assert_eq!(q, "mengapa OR memilih OR arsitektur OR dddd");
        assert_eq!(build_retrieval_query(&["a bb ccc"]), "");
        assert_eq!(build_retrieval_query(&[]), "");
    }

    #[test]
    fn hemat_repack_drops_excerpts_while_targets_survive() {
        let big = "kata ".repeat(400);
        let targets = [("q-1", big.as_str())];
        let retrieved = [section("doc-a"), section("doc-b"), section("doc-c")];
        let hemat = assemble_send_context("profil-hemat", &targets, &[], &retrieved, "kata");
        assert_eq!(hemat["model_profile_id"], "profil-hemat");
        assert_eq!(hemat["fixture_profile"], true);
        assert_eq!(hemat["truncated"], true);
        assert!(
            hemat["dropped_item_ids"].as_array().unwrap().len() >= 2,
            "hemat must drop excerpts: {hemat}"
        );
        let detail = assemble_send_context("profil-detail", &targets, &[], &retrieved, "kata");
        assert_eq!(detail["truncated"], false);
        assert!(detail["dropped_item_ids"].as_array().unwrap().is_empty());
    }

    #[test]
    fn empty_context_assembles_honestly() {
        let v = assemble_send_context("profil-seimbang", &[], &[], &[], "");
        assert_eq!(v["estimated_input_tokens"], 0);
        assert_eq!(v["truncated"], false);
    }
}
