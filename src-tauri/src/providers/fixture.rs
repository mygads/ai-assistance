// Deterministic fixture streams: scripted provider wire sequences driving
// the same SttAdapter seam as a live socket would. Includes the unhappy
// paths a fixture must cover: an empty-transcript frame (dropped, stream
// continues), a recoverable mid-stream disconnect, and a reconnect with a
// fresh connection id + offset. Test boundary only; outputs are labeled
// fixture data.

use std::collections::VecDeque;

use crate::providers::{deepgram, soniox, AdapterPoll, StreamCtx, SttAdapter, SttError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Soniox,
    Deepgram,
}

#[derive(Debug, Clone)]
pub enum WireMessage {
    /// Raw provider wire payload; normalized by provider on poll.
    Transcript {
        provider: ProviderKind,
        raw: serde_json::Value,
    },
    /// Socket broke mid-stream.
    TransportError {
        recoverable: bool,
    },
    End,
}

pub struct ReplayAdapter {
    ctx: StreamCtx,
    queue: VecDeque<WireMessage>,
}

impl ReplayAdapter {
    pub fn new(ctx: StreamCtx, script: Vec<WireMessage>) -> Self {
        Self {
            ctx,
            queue: script.into(),
        }
    }

    pub fn remaining(&self) -> usize {
        self.queue.len()
    }
}

impl SttAdapter for ReplayAdapter {
    fn poll(&mut self) -> Result<AdapterPoll, SttError> {
        match self.queue.pop_front() {
            None => Ok(AdapterPoll::EndOfStream),
            Some(WireMessage::End) => Ok(AdapterPoll::EndOfStream),
            Some(WireMessage::TransportError { recoverable }) => {
                Ok(AdapterPoll::Disconnected { recoverable })
            }
            Some(WireMessage::Transcript { provider, raw }) => {
                let event = match provider {
                    ProviderKind::Soniox => soniox::normalize(&raw, &mut self.ctx),
                    ProviderKind::Deepgram => deepgram::normalize(&raw, &mut self.ctx),
                };
                // Non-transcript live envelopes are skippable: drop and continue.
                match event {
                    Err(SttError::NonTranscriptFrame(_)) => self.poll(),
                    Err(SttError::EmptyTranscript) => self.poll(),
                    Err(e) => Err(e),
                    Ok(e) => Ok(AdapterPoll::Event(e)),
                }
            }
        }
    }

    fn connection_id(&self) -> &str {
        &self.ctx.connection_id
    }
}

/// Scripted Soniox session: partial → partial → final on conn-1, an empty
/// frame (dropped), a recoverable disconnect, then the tail final on conn-2
/// with the provider clock restarted (fresh offset). Mirrors the TS replay
/// fixture tests/provider/soniox-session.json.
pub fn soniox_session_script(
    session_id: &str,
) -> (StreamCtx, Vec<WireMessage>, StreamCtx, Vec<WireMessage>) {
    use crate::audio::ProviderOffset;
    use serde_json::json;
    let source_id = format!("{session_id}:remote");
    let before = (
        StreamCtx::new(
            session_id,
            &source_id,
            "conn-1",
            ProviderOffset::fresh(0, 0),
            "seg-1",
        ),
        vec![
            WireMessage::Transcript {
                provider: ProviderKind::Soniox,
                raw: json!({"segments": [{"text": "Mengapa memilih", "start_ms": 0, "end_ms": 500}], "final": false}),
            },
            WireMessage::Transcript {
                provider: ProviderKind::Soniox,
                raw: json!({"segments": [{"text": "Mengapa memilih arsitektur", "start_ms": 0, "end_ms": 700}], "final": false}),
            },
            WireMessage::Transcript {
                provider: ProviderKind::Soniox,
                raw: json!({"segments": [], "final": false}),
            },
            WireMessage::Transcript {
                provider: ProviderKind::Soniox,
                raw: json!({"segments": [{"text": "Mengapa memilih arsitektur ini?", "start_ms": 0, "end_ms": 900}], "final": true}),
            },
            WireMessage::TransportError { recoverable: true },
        ],
    );
    let after = (
        StreamCtx::new(
            session_id,
            &source_id,
            "conn-2",
            ProviderOffset::fresh(9600, 0),
            "seg-9",
        ),
        vec![WireMessage::Transcript {
            provider: ProviderKind::Soniox,
            raw: json!({"segments": [{"text": "First connection tail.", "start_ms": 9000, "end_ms": 9500}], "final": true}),
        }],
    );
    (before.0, before.1, after.0, after.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ProviderOffset;

    fn ctx() -> StreamCtx {
        StreamCtx::new("s", "src", "conn-1", ProviderOffset::fresh(0, 0), "seg-1")
    }

    #[test]
    fn replay_drives_events_and_skips_empty_frames() {
        let (ctx1, script1, _, _) = soniox_session_script("s");
        let mut adapter = ReplayAdapter::new(ctx1, script1);
        let mut events = Vec::new();
        loop {
            match adapter.poll().unwrap() {
                AdapterPoll::Event(e) => events.push(e),
                AdapterPoll::Disconnected { recoverable } => {
                    assert!(recoverable);
                    break;
                }
                AdapterPoll::EndOfStream => break,
            }
        }
        // partial, partial, final: the empty frame was dropped, not emitted.
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].revision, 0);
        assert_eq!(events[2].status, crate::providers::TranscriptStatus::Final);
    }

    #[test]
    fn malformed_frames_fail_loudly_not_silently() {
        let mut adapter = ReplayAdapter::new(
            ctx(),
            vec![WireMessage::Transcript {
                provider: ProviderKind::Deepgram,
                raw: serde_json::json!({"is_final": true}),
            }],
        );
        assert!(matches!(adapter.poll(), Err(SttError::MalformedMessage(_))));
    }
}
