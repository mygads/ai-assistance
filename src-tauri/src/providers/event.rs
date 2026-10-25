// Provider-side transcript event: the normalized output of every STT
// adapter, convertible into the real ingest row. Mirrors the frozen
// transcript-event shape (docs/CONTRACTS.md) and the TS ConnectionCtx
// normalization (src/domain/adapters.ts): provider ms + connection offset =
// session ms, assigned exactly once per connection.

use crate::audio::{map_provider_ms, ProviderOffset};
use crate::store::TranscriptSegment;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptStatus {
    Partial,
    Final,
}

impl TranscriptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TranscriptStatus::Partial => "partial",
            TranscriptStatus::Final => "final",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderTranscriptEvent {
    pub session_id: String,
    pub source_id: String,
    /// Provider connection that produced this event. A reconnect mints a new
    /// id AND a fresh offset; the pair travels together, never apart.
    pub connection_id: String,
    pub segment_id: String,
    pub revision: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: TranscriptStatus,
    pub text: String,
}

/// Parameters for `ProviderTranscriptEvent::build`. A struct (not ten
/// positional arguments) so call sites name every field; clippy's
/// too_many_arguments lint stays silent and offsets cannot be swapped.
#[derive(Debug, Clone, Copy)]
pub struct EventBuild<'a> {
    pub session_id: &'a str,
    pub source_id: &'a str,
    pub connection_id: &'a str,
    pub segment_id: &'a str,
    pub revision: u32,
    pub provider_start_ms: u64,
    pub provider_end_ms: u64,
    pub offset: ProviderOffset,
    pub status: TranscriptStatus,
    pub text: &'a str,
}

impl ProviderTranscriptEvent {
    /// Build from provider-clock milliseconds, mapping onto session time with
    /// the connection's offset. Timestamps are validated here, not later.
    pub fn build(p: EventBuild<'_>) -> Result<Self, crate::providers::SttError> {
        if p.session_id.trim().is_empty()
            || p.source_id.trim().is_empty()
            || p.connection_id.trim().is_empty()
            || p.segment_id.trim().is_empty()
        {
            return Err(crate::providers::SttError::MalformedMessage(
                "event identity fields must not be empty".to_string(),
            ));
        }
        let text = p.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            return Err(crate::providers::SttError::EmptyTranscript);
        }
        let start_ms = map_provider_ms(p.provider_start_ms, p.offset);
        let end_ms = map_provider_ms(p.provider_end_ms, p.offset);
        if end_ms < start_ms {
            return Err(crate::providers::SttError::MalformedMessage(
                "require start_ms <= end_ms after offset mapping".to_string(),
            ));
        }
        Ok(Self {
            session_id: p.session_id.to_string(),
            source_id: p.source_id.to_string(),
            connection_id: p.connection_id.to_string(),
            segment_id: p.segment_id.to_string(),
            revision: p.revision,
            start_ms,
            end_ms,
            status: p.status,
            text,
        })
    }

    /// Convert into the real ingest row. Role attribution stays with the
    /// caller (`ingest_segment(conn, &seg, role)`), exactly like the IPC path.
    pub fn into_segment(self) -> TranscriptSegment {
        TranscriptSegment {
            id: self.segment_id,
            session_id: self.session_id,
            source_id: self.source_id,
            revision: self.revision,
            start_ms: self.start_ms,
            end_ms: self.end_ms,
            status: self.status.as_str().to_string(),
            text: self.text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_maps_offset_and_normalizes_text() {
        let e = ProviderTranscriptEvent::build(EventBuild {
            session_id: "s",
            source_id: "src",
            connection_id: "conn-2",
            segment_id: "seg-9",
            revision: 0,
            provider_start_ms: 9000,
            provider_end_ms: 9500,
            offset: ProviderOffset::fresh(9600, 0),
            status: TranscriptStatus::Final,
            text: "  First   connection tail. ",
        })
        .unwrap();
        assert_eq!((e.start_ms, e.end_ms), (18600, 19100));
        assert_eq!(e.text, "First connection tail.");
        let seg = e.into_segment();
        assert_eq!(
            (seg.id, seg.status.as_str(), seg.revision),
            ("seg-9".to_string(), "final", 0)
        );
    }

    #[test]
    fn build_rejects_empty_identity_and_text() {
        let good = EventBuild {
            session_id: "s",
            source_id: "src",
            connection_id: "c",
            segment_id: "seg",
            revision: 0,
            provider_start_ms: 0,
            provider_end_ms: 100,
            offset: ProviderOffset::fresh(0, 0),
            status: TranscriptStatus::Partial,
            text: "hi",
        };
        assert!(ProviderTranscriptEvent::build(EventBuild {
            session_id: "",
            ..good
        })
        .is_err());
        assert!(ProviderTranscriptEvent::build(EventBuild {
            text: "   ",
            ..good
        })
        .is_err());
        assert!(ProviderTranscriptEvent::build(EventBuild {
            provider_start_ms: 200,
            ..good
        })
        .is_err());
    }
}
