// Session clock: one local monotonic clock per session (ARCHITECTURE.md
// §5.2). Capture, transcript, and provider timestamps all map onto session
// milliseconds; provider clocks restart on reconnect, so the mapping carries
// an explicit offset that is refreshed on every reacquire — never guessed.

use std::time::Instant;

/// Monotonic session time. `start()` pins the session zero; `now_ms()` never
/// goes backwards (saturates at zero on clock weirdness instead of panicking).
#[derive(Debug)]
pub struct SessionClock {
    start: Instant,
}

impl SessionClock {
    pub fn start() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    pub fn now_ms(&self) -> u64 {
        self.start
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

/// Offset mapping a provider timestamp domain onto session time after a
/// (re)connect: `session_ms = provider_ms + offset_ms`, saturating at zero so
/// early provider frames land at session start instead of underflowing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderOffset {
    pub offset_ms: i64,
}

impl ProviderOffset {
    /// Fresh connection established at `session_now_ms` while the provider
    /// clock reads `provider_now_ms`.
    pub fn fresh(session_now_ms: u64, provider_now_ms: u64) -> Self {
        Self {
            offset_ms: session_now_ms as i64 - provider_now_ms as i64,
        }
    }
}

pub fn map_provider_ms(provider_ms: u64, offset: ProviderOffset) -> u64 {
    (provider_ms as i64 + offset.offset_ms).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_is_monotonic() {
        let c = SessionClock::start();
        let a = c.now_ms();
        let b = c.now_ms();
        assert!(b >= a);
    }

    #[test]
    fn fresh_offset_maps_provider_onto_session() {
        // Provider reconnected with its clock restarted near 0 while the
        // session is at ~9600ms: provider 9000 -> session 18600.
        let off = ProviderOffset::fresh(9600, 0);
        assert_eq!(map_provider_ms(9000, off), 18600);
    }

    #[test]
    fn early_provider_frames_saturate_at_session_start() {
        let off = ProviderOffset::fresh(100, 5000);
        assert_eq!(map_provider_ms(0, off), 0);
        assert_eq!(map_provider_ms(4999, off), 99);
        assert_eq!(map_provider_ms(5000, off), 100);
    }
}
