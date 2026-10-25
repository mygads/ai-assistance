// Capture discipline (ARCHITECTURE.md §5.2): the capture callback only puts
// labeled frames on a bounded ring buffer. Resampling, encoding, network,
// database, and UI happen outside the callback — so `push` never blocks, never
// allocates on the hot path beyond the frame itself, and drops the oldest
// frame (counted, never silent) when full.

use std::collections::VecDeque;

use super::routing::AudioRole;

/// One captured audio chunk with attribution attached at the source. `epoch`
/// identifies the capture generation: frames from before a reconnect carry an
/// older epoch and are rejected downstream (see recovery::Link).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabeledFrame {
    pub session_id: String,
    pub source_id: String,
    pub role: AudioRole,
    pub epoch: u64,
    pub session_ms: u64,
    pub pcm: Vec<i16>,
}

/// Bounded FIFO of labeled frames. Full buffer drops the oldest frame and
/// increments `dropped()` — dropped audio is measured (P05 metrics), never
/// silently absorbed into a gap.
#[derive(Debug)]
pub struct FrameRing {
    buf: VecDeque<LabeledFrame>,
    capacity_frames: usize,
    dropped: u64,
}

impl FrameRing {
    pub fn new(capacity_frames: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity_frames.max(1)),
            capacity_frames: capacity_frames.max(1),
            dropped: 0,
        }
    }

    pub fn push(&mut self, frame: LabeledFrame) {
        if self.buf.len() >= self.capacity_frames {
            self.buf.pop_front();
            self.dropped += 1;
        }
        self.buf.push_back(frame);
    }

    pub fn pop(&mut self) -> Option<LabeledFrame> {
        self.buf.pop_front()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Frames dropped due to a full buffer since creation. Monotonic.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// Anything that produces labeled frames: real WASAPI callbacks in P05/native
/// builds, the deterministic fixture here. Consumers only see this trait, so
/// replay and hardware share the downstream path.
pub trait CaptureSource {
    fn next_frame(&mut self) -> Option<LabeledFrame>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(role: AudioRole, ms: u64) -> LabeledFrame {
        LabeledFrame {
            session_id: "s1".to_string(),
            source_id: format!("s1:{}", role.as_str()),
            role,
            epoch: 0,
            session_ms: ms,
            pcm: vec![0i16; 160],
        }
    }

    #[test]
    fn ring_is_fifo_and_bounded() {
        let mut ring = FrameRing::new(2);
        ring.push(frame(AudioRole::SelfMic, 0));
        ring.push(frame(AudioRole::Remote, 10));
        ring.push(frame(AudioRole::SelfMic, 20)); // evicts ms=0
        assert_eq!(ring.len(), 2);
        assert_eq!(ring.dropped(), 1);
        assert_eq!(ring.pop().unwrap().session_ms, 10);
        assert_eq!(ring.pop().unwrap().session_ms, 20);
        assert!(ring.pop().is_none());
        assert!(ring.is_empty());
    }

    #[test]
    fn dropped_counter_is_monotonic() {
        let mut ring = FrameRing::new(1);
        for i in 0..5 {
            ring.push(frame(AudioRole::Remote, i));
        }
        assert_eq!(ring.len(), 1);
        assert_eq!(ring.dropped(), 4);
        assert_eq!(ring.pop().unwrap().session_ms, 4);
    }

    #[test]
    fn frames_carry_attribution() {
        let f = frame(AudioRole::Remote, 42);
        assert_eq!(f.role, AudioRole::Remote);
        assert_eq!(f.source_id, "s1:remote");
    }
}
