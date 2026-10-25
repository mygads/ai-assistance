// Soniox-like wire normalization. Shape (repo fixture contract, also served
// by scripts/lib/fixture-server.mjs):
//   { "segments": [{ "text", "start_ms", "end_ms" }], "final": bool }
// Unknown extra fields are ignored (forward compatibility); missing/empty
// segments or empty joined text are typed errors, not empty events.

use crate::providers::{StreamCtx, SttError, TranscriptStatus};

pub fn normalize(
    payload: &serde_json::Value,
    ctx: &mut StreamCtx,
) -> Result<crate::providers::ProviderTranscriptEvent, SttError> {
    let malformed = |d: &str| SttError::MalformedMessage(format!("soniox: {d}"));
    let segments = payload
        .get("segments")
        .and_then(|s| s.as_array())
        .ok_or_else(|| malformed("missing segments array"))?;
    if segments.is_empty() {
        return Err(SttError::EmptyTranscript);
    }
    let mut texts = Vec::with_capacity(segments.len());
    let mut start: Option<u64> = None;
    let mut end: u64 = 0;
    for seg in segments {
        let text = seg
            .get("text")
            .and_then(|t| t.as_str())
            .ok_or_else(|| malformed("segment without text"))?;
        texts.push(text);
        let s = seg
            .get("start_ms")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| malformed("segment without start_ms"))?;
        let e = seg
            .get("end_ms")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| malformed("segment without end_ms"))?;
        start = Some(start.map_or(s, |cur: u64| cur.min(s)));
        end = end.max(e);
    }
    let text = texts.join(" ");
    if text.trim().is_empty() {
        return Err(SttError::EmptyTranscript);
    }
    let status = match payload.get("final").and_then(|f| f.as_bool()) {
        Some(true) => TranscriptStatus::Final,
        Some(false) => TranscriptStatus::Partial,
        None => return Err(malformed("missing final flag")),
    };
    ctx.mint(start.unwrap_or(0), end, status, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ProviderOffset;
    use serde_json::json;

    fn ctx() -> StreamCtx {
        StreamCtx::new("s", "src", "conn-1", ProviderOffset::fresh(0, 0), "seg-1")
    }

    #[test]
    fn partial_then_final_normalizes() {
        let mut c = ctx();
        let p = normalize(&json!({"segments": [{"text": "Mengapa memilih", "start_ms": 0, "end_ms": 500}], "final": false}), &mut c).unwrap();
        assert_eq!(
            (p.revision, p.status, p.text.as_str()),
            (0, TranscriptStatus::Partial, "Mengapa memilih")
        );
        let f = normalize(&json!({"segments": [{"text": "Mengapa memilih arsitektur ini?", "start_ms": 0, "end_ms": 900}], "final": true}), &mut c).unwrap();
        assert_eq!((f.revision, f.status), (1, TranscriptStatus::Final));
    }

    #[test]
    fn empty_and_malformed_frames_are_typed() {
        let mut c = ctx();
        assert_eq!(
            normalize(&json!({"segments": [], "final": false}), &mut c),
            Err(SttError::EmptyTranscript)
        );
        assert_eq!(
            normalize(
                &json!({"segments": [{"text": "  ", "start_ms": 0, "end_ms": 10}], "final": false}),
                &mut c
            ),
            Err(SttError::EmptyTranscript)
        );
        assert!(matches!(
            normalize(&json!({"final": true}), &mut c),
            Err(SttError::MalformedMessage(_))
        ));
        assert!(matches!(
            normalize(
                &json!({"segments": [{"text": "x"} ], "final": true}),
                &mut c
            ),
            Err(SttError::MalformedMessage(_))
        ));
        assert!(matches!(
            normalize(
                &json!({"segments": [{"text": "x", "start_ms": 0, "end_ms": 1}]}),
                &mut c
            ),
            Err(SttError::MalformedMessage(_))
        ));
    }

    #[test]
    fn extra_fields_ignored_for_forward_compat() {
        let mut c = ctx();
        let e = normalize(
            &json!({"segments": [{"text": "halo", "start_ms": 10, "end_ms": 20, "confidence": 0.9}], "final": true, "endpoint_detected": true}),
            &mut c,
        )
        .unwrap();
        assert_eq!((e.text.as_str(), e.start_ms, e.end_ms), ("halo", 10, 20));
    }
}
