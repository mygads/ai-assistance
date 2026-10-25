// Deepgram-like wire normalization. Shape (repo fixture contract, also
// served by scripts/lib/fixture-server.mjs):
//   { "is_final": bool,
//     "channel": { "alternatives": [{ "transcript": str,
//                                     "words"?: [{ "word", "start"(s), "end"(s) }] }] } }
// Word timings are seconds (floats); they map onto session ms with the
// connection offset. No words -> 0..0 span (endpoint without timings), never
// a fabricated timing.

use crate::providers::{StreamCtx, SttError, TranscriptStatus};

pub fn normalize(
    payload: &serde_json::Value,
    ctx: &mut StreamCtx,
) -> Result<crate::providers::ProviderTranscriptEvent, SttError> {
    let malformed = |d: &str| SttError::MalformedMessage(format!("deepgram: {d}"));
    let alt = payload
        .get("channel")
        .and_then(|c| c.get("alternatives"))
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| malformed("missing channel.alternatives[0]"))?;
    let transcript = alt
        .get("transcript")
        .and_then(|t| t.as_str())
        .ok_or_else(|| malformed("alternative without transcript"))?;
    if transcript.trim().is_empty() {
        return Err(SttError::EmptyTranscript);
    }
    let (provider_start_ms, provider_end_ms) = match alt.get("words").and_then(|w| w.as_array()) {
        Some(words) if !words.is_empty() => {
            let mut start = f64::INFINITY;
            let mut end = f64::NEG_INFINITY;
            for w in words {
                let s = w
                    .get("start")
                    .and_then(|v| v.as_f64())
                    .ok_or_else(|| malformed("word without start"))?;
                let e = w
                    .get("end")
                    .and_then(|v| v.as_f64())
                    .ok_or_else(|| malformed("word without end"))?;
                if s < start {
                    start = s;
                }
                if e > end {
                    end = e;
                }
            }
            (
                (start * 1000.0).round() as u64,
                (end * 1000.0).round() as u64,
            )
        }
        _ => (0, 0),
    };
    let status = match payload.get("is_final").and_then(|f| f.as_bool()) {
        Some(true) => TranscriptStatus::Final,
        Some(false) => TranscriptStatus::Partial,
        None => return Err(malformed("missing is_final flag")),
    };
    ctx.mint(
        provider_start_ms,
        provider_end_ms,
        status,
        transcript.trim(),
    )
}

/// Live sockets also emit non-transcript envelopes (metadata, keepalive,
/// utterance_end). They are skippable, not errors; the adapter filters them
/// before `normalize` ever runs.
pub fn is_transcript_message(payload: &serde_json::Value) -> bool {
    if payload.get("channel").is_some() {
        return true;
    }
    if payload
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| t == "Results")
    {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ProviderOffset;
    use serde_json::json;

    fn ctx(offset_ms: i64) -> StreamCtx {
        StreamCtx::new("s", "src", "conn-1", ProviderOffset { offset_ms }, "seg-2")
    }

    #[test]
    fn words_map_seconds_to_session_ms_with_offset() {
        let mut c = ctx(9600);
        let e = normalize(
            &json!({"is_final": true,
                "channel": {"alternatives": [{"transcript": "How do you keep context?",
                    "words": [{"word": "How", "start": 1.45, "end": 1.6},
                              {"word": "context?", "start": 1.9, "end": 2.0}]}]}}),
            &mut c,
        )
        .unwrap();
        assert_eq!((e.start_ms, e.end_ms), (1450 + 9600, 2000 + 9600));
        assert_eq!(e.status, TranscriptStatus::Final);
    }

    #[test]
    fn no_words_yields_zero_span_not_fabricated_timings() {
        let mut c = ctx(0);
        let e = normalize(
            &json!({"is_final": false, "channel": {"alternatives": [{"transcript": "How do you keep"}]}}),
            &mut c,
        )
        .unwrap();
        assert_eq!((e.start_ms, e.end_ms), (0, 0));
    }

    #[test]
    fn empty_and_malformed_frames_are_typed() {
        let mut c = ctx(0);
        assert_eq!(
            normalize(
                &json!({"is_final": true, "channel": {"alternatives": [{"transcript": "  "}]}}),
                &mut c
            ),
            Err(SttError::EmptyTranscript)
        );
        assert!(matches!(
            normalize(
                &json!({"channel": {"alternatives": []}, "is_final": true}),
                &mut c
            ),
            Err(SttError::MalformedMessage(_))
        ));
        assert!(matches!(
            normalize(&json!({"is_final": true}), &mut c),
            Err(SttError::MalformedMessage(_))
        ));
    }

    #[test]
    fn non_transcript_envelopes_are_skippable() {
        assert!(!is_transcript_message(
            &json!({"type": "Metadata", "request_id": "r-1"})
        ));
        assert!(!is_transcript_message(&json!({"type": "UtteranceEnd"})));
        assert!(is_transcript_message(
            &json!({"type": "Results", "channel": {"alternatives": []}})
        ));
        assert!(is_transcript_message(
            &json!({"is_final": false, "channel": {"alternatives": [{"transcript": "x"}]}})
        ));
    }
}
