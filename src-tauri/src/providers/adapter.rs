// The STT adapter seam. One trait for live sockets (P03/T11) and fixture
// streams alike: consumers poll normalized events and handle the two
// non-event outcomes explicitly. The connection context owns revision
// assignment and the provider→session offset, so adapters cannot emit an
// event with a guessed revision or a doubly-mapped timestamp.

use crate::audio::ProviderOffset;
use crate::providers::{EventBuild, ProviderTranscriptEvent, SttError, TranscriptStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamCtx {
    pub session_id: String,
    pub source_id: String,
    pub connection_id: String,
    pub offset: ProviderOffset,
    pub segment_id: String,
    pub next_revision: u32,
}

impl StreamCtx {
    pub fn new(
        session_id: &str,
        source_id: &str,
        connection_id: &str,
        offset: ProviderOffset,
        segment_id: &str,
    ) -> Self {
        Self {
            session_id: session_id.to_string(),
            source_id: source_id.to_string(),
            connection_id: connection_id.to_string(),
            offset,
            segment_id: segment_id.to_string(),
            next_revision: 0,
        }
    }

    /// Mint the event for one normalized provider result, assigning the next
    /// revision exactly once. Reconnects construct a fresh ctx (new
    /// connection id + offset), so revisions restart per connection and the
    /// store's stale-reject discipline applies within a connection.
    pub fn mint(
        &mut self,
        provider_start_ms: u64,
        provider_end_ms: u64,
        status: TranscriptStatus,
        text: &str,
    ) -> Result<ProviderTranscriptEvent, SttError> {
        let revision = self.next_revision;
        self.next_revision += 1;
        ProviderTranscriptEvent::build(EventBuild {
            session_id: &self.session_id,
            source_id: &self.source_id,
            connection_id: &self.connection_id,
            segment_id: &self.segment_id,
            revision,
            provider_start_ms,
            provider_end_ms,
            offset: self.offset,
            status,
            text,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterPoll {
    Event(ProviderTranscriptEvent),
    /// Stream broke. `recoverable` decides retry-with-fresh-offset vs fail
    /// closed; fatal auth errors surface as `Err(SttError::Auth)`, not here.
    Disconnected {
        recoverable: bool,
    },
    EndOfStream,
}

pub trait SttAdapter {
    fn poll(&mut self) -> Result<AdapterPoll, SttError>;
    fn connection_id(&self) -> &str;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctx_assigns_revisions_exactly_once() {
        let mut ctx = StreamCtx::new("s", "src", "conn-1", ProviderOffset::fresh(0, 0), "seg-1");
        let a = ctx
            .mint(0, 500, TranscriptStatus::Partial, "Mengapa memilih")
            .unwrap();
        let b = ctx
            .mint(
                0,
                900,
                TranscriptStatus::Final,
                "Mengapa memilih arsitektur ini?",
            )
            .unwrap();
        assert_eq!((a.revision, b.revision), (0, 1));
        assert_eq!(a.status, TranscriptStatus::Partial);
        assert_eq!(b.status, TranscriptStatus::Final);
    }

    #[test]
    fn reconnect_ctx_restarts_revisions_with_fresh_offset() {
        let mut ctx = StreamCtx::new(
            "s",
            "src",
            "conn-2",
            ProviderOffset::fresh(9600, 0),
            "seg-9",
        );
        let e = ctx
            .mint(
                9000,
                9500,
                TranscriptStatus::Final,
                "First connection tail.",
            )
            .unwrap();
        assert_eq!((e.revision, e.start_ms), (0, 18600));
    }
}
