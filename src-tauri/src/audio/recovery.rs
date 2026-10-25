// Reconnect recovery (ARCHITECTURE.md §15): device loss is a typed,
// recoverable state — not a crash, not a silent resume. Each successful
// reacquire bumps the capture epoch; frames from older epochs are stale and
// rejected by `accept()`, so a late flush from a dead stream can never mix
// into the new stream. Backoff is bounded and deterministic (attempt-indexed)
// so tests can assert the schedule without sleeping.

use super::capture::LabeledFrame;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Live { epoch: u64 },
    Lost,
    Backoff { attempt: u32 },
    Reacquiring { epoch: u64 },
}

/// One capture path's liveness. `max_attempts == 0` means retry forever
/// (interactive session); otherwise reacquire fails closed after the budget.
#[derive(Debug)]
pub struct Link {
    state: LinkState,
    max_attempts: u32,
}

impl Link {
    pub fn new(epoch: u64, max_attempts: u32) -> Self {
        Self {
            state: LinkState::Live { epoch },
            max_attempts,
        }
    }

    pub fn state(&self) -> LinkState {
        self.state
    }

    pub fn epoch(&self) -> u64 {
        match self.state {
            LinkState::Live { epoch } | LinkState::Reacquiring { epoch } => epoch,
            LinkState::Lost | LinkState::Backoff { .. } => 0,
        }
    }

    pub fn on_device_lost(&mut self) {
        self.state = LinkState::Lost;
    }

    /// Schedule the next reacquire attempt. Returns the bounded backoff delay
    /// in ms (250ms base, doubling, capped at 4s), or None when the retry
    /// budget is exhausted.
    pub fn on_retry(&mut self) -> Option<u64> {
        let attempt = match self.state {
            LinkState::Backoff { attempt } => attempt + 1,
            LinkState::Lost => 0,
            _ => return None,
        };
        if self.max_attempts > 0 && attempt >= self.max_attempts {
            return None;
        }
        self.state = LinkState::Backoff { attempt };
        Some(250u64.saturating_mul(1 << attempt.min(4)).min(4000))
    }

    /// Device reacquired: move to the next epoch. Callers refresh the provider
    /// clock offset at this point (see clock::ProviderOffset::fresh).
    pub fn on_reacquired(&mut self) -> u64 {
        let next = match self.state {
            LinkState::Live { epoch } | LinkState::Reacquiring { epoch } => epoch + 1,
            LinkState::Lost | LinkState::Backoff { .. } => 1,
        };
        self.state = LinkState::Live { epoch: next };
        next
    }

    /// Accept only frames from the current live epoch. Frames from a previous
    /// epoch (late flush of a dead stream) or from no live link are rejected.
    pub fn accept(&self, frame: &LabeledFrame) -> bool {
        matches!(self.state, LinkState::Live { epoch } if epoch == frame.epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::super::routing::AudioRole;
    use super::*;

    fn frame(epoch: u64) -> LabeledFrame {
        LabeledFrame {
            session_id: "s1".to_string(),
            source_id: "s1:self".to_string(),
            role: AudioRole::SelfMic,
            epoch,
            session_ms: 0,
            pcm: vec![0i16; 160],
        }
    }

    #[test]
    fn backoff_schedule_is_bounded_and_deterministic() {
        let mut link = Link::new(0, 0);
        link.on_device_lost();
        assert_eq!(link.on_retry(), Some(250));
        assert_eq!(link.state(), LinkState::Backoff { attempt: 0 });
        assert_eq!(link.on_retry(), Some(500));
        assert_eq!(link.on_retry(), Some(1000));
        assert_eq!(link.on_retry(), Some(2000));
        assert_eq!(link.on_retry(), Some(4000));
        assert_eq!(link.on_retry(), Some(4000)); // capped
    }

    #[test]
    fn retry_budget_fails_closed() {
        let mut link = Link::new(0, 2);
        link.on_device_lost();
        assert!(link.on_retry().is_some());
        assert!(link.on_retry().is_some());
        assert_eq!(link.on_retry(), None);
    }

    #[test]
    fn reacquire_bumps_epoch_and_rejects_stale_frames() {
        let mut link = Link::new(0, 0);
        assert!(link.accept(&frame(0)));
        link.on_device_lost();
        assert!(!link.accept(&frame(0))); // no live link: reject
        link.on_retry();
        let epoch = link.on_reacquired();
        assert_eq!(epoch, 1);
        assert!(!link.accept(&frame(0))); // late flush of dead stream: reject
        assert!(link.accept(&frame(1)));
    }

    #[test]
    fn retry_only_from_lost_or_backoff() {
        let mut link = Link::new(3, 0);
        assert_eq!(link.on_retry(), None);
        assert_eq!(link.state(), LinkState::Live { epoch: 3 });
    }
}
