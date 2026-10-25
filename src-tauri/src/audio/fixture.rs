// Deterministic fixture capture (test boundary only): a scripted device list
// (one mic + one loopback) and scripted self+remote conversations — including
// overlapping simultaneous speech — feeding the same LabeledFrame path as real
// capture. External audio hardware is replaced at this boundary; the fixture
// module is compiled out of nothing (it is ordinary code), but its outputs
// must always be labeled fixture data, never presented as device evidence.

use std::collections::VecDeque;

use super::capture::{CaptureSource, LabeledFrame};
use super::routing::{AudioRole, DeviceDescriptor, DeviceKind};

/// The deterministic test device list: exactly one mic and one loopback.
pub fn fixture_devices() -> Vec<DeviceDescriptor> {
    vec![
        DeviceDescriptor {
            id: "fixture-mic".to_string(),
            label: "Fixture Microphone (self)".to_string(),
            kind: DeviceKind::Microphone,
        },
        DeviceDescriptor {
            id: "fixture-loopback".to_string(),
            label: "Fixture Loopback (remote)".to_string(),
            kind: DeviceKind::Loopback,
        },
    ]
}

fn scripted_frame(
    session_id: &str,
    role: AudioRole,
    epoch: u64,
    session_ms: u64,
    sample: i16,
) -> LabeledFrame {
    LabeledFrame {
        session_id: session_id.to_string(),
        source_id: format!("{session_id}:{}", role.as_str()),
        role,
        epoch,
        session_ms,
        pcm: vec![sample; 160],
    }
}

/// Builds a scripted conversation: self speaks (sample marker 1000), remote
/// answers (marker 2000), with an overlapping window where BOTH paths are
/// active — the router must keep both, never force a single active speaker
/// (ARCHITECTURE.md §5.1). 10ms frame spacing; fully deterministic.
pub fn scripted_conversation(session_id: &str, epoch: u64) -> Vec<LabeledFrame> {
    let mut frames = Vec::new();
    // Self: 0..=100ms. Remote: 50..=150ms. Overlap: 50..=100ms both active.
    for i in 0..=10 {
        frames.push(scripted_frame(
            session_id,
            AudioRole::SelfMic,
            epoch,
            i * 10,
            1000,
        ));
    }
    for i in 5..=15 {
        frames.push(scripted_frame(
            session_id,
            AudioRole::Remote,
            epoch,
            i * 10,
            2000,
        ));
    }
    frames.sort_by_key(|f| (f.session_ms, f.role.as_str()));
    frames
}

/// Pull-based fixture source over a scripted frame vec.
pub struct FixtureCapture {
    frames: VecDeque<LabeledFrame>,
}

impl FixtureCapture {
    pub fn new(frames: Vec<LabeledFrame>) -> Self {
        Self {
            frames: frames.into(),
        }
    }

    pub fn conversation(session_id: &str, epoch: u64) -> Self {
        Self::new(scripted_conversation(session_id, epoch))
    }

    pub fn remaining(&self) -> usize {
        self.frames.len()
    }
}

impl CaptureSource for FixtureCapture {
    fn next_frame(&mut self) -> Option<LabeledFrame> {
        self.frames.pop_front()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_has_exactly_one_mic_and_one_loopback() {
        let devs = fixture_devices();
        assert_eq!(devs.len(), 2);
        assert!(devs
            .iter()
            .any(|d| d.kind == DeviceKind::Microphone && d.id == "fixture-mic"));
        assert!(devs
            .iter()
            .any(|d| d.kind == DeviceKind::Loopback && d.id == "fixture-loopback"));
    }

    #[test]
    fn conversation_keeps_both_paths_during_overlap() {
        let frames = scripted_conversation("s1", 0);
        // 11 self + 11 remote frames.
        assert_eq!(frames.len(), 22);
        // Overlap window 50..=100ms carries both roles.
        let overlap: Vec<_> = frames
            .iter()
            .filter(|f| (50..=100).contains(&f.session_ms))
            .collect();
        assert_eq!(overlap.len(), 12);
        assert!(overlap.iter().any(|f| f.role == AudioRole::SelfMic));
        assert!(overlap.iter().any(|f| f.role == AudioRole::Remote));
        // Markers distinguish the paths; attribution travels with the frame.
        assert!(frames
            .iter()
            .all(|f| f.source_id == format!("s1:{}", f.role.as_str())));
    }

    #[test]
    fn fixture_capture_drains_in_order() {
        let mut cap = FixtureCapture::conversation("s9", 7);
        assert_eq!(cap.remaining(), 22);
        let first = cap.next_frame().unwrap();
        assert_eq!((first.session_ms, first.epoch), (0, 7));
        let mut n = 1;
        while cap.next_frame().is_some() {
            n += 1;
        }
        assert_eq!(n, 22);
    }
}
