// L1 audio-routing integration: real router + rings + links + fixture capture
// end to end, no hardware. Proves the T05/A01 slice: two separately labeled
// paths stay separated (incl. simultaneous activity), reconnects re-epoch
// without mixing, timestamps stay monotonic per source.
use conversation_assistant_lib::audio::{
    fixture_devices, map_provider_ms, scripted_conversation, AudioRole, AudioRouter, CaptureSource,
    FixtureCapture, FrameRing, Link, LinkState, ProviderOffset, RouteConfig, SessionClock,
};

const SESSION: &str = "audio-int-01";

fn route(role: AudioRole, device: &str, remap: bool) -> RouteConfig {
    RouteConfig {
        session_id: SESSION.to_string(),
        role,
        source_id: format!("{SESSION}:{}", role.as_str()),
        remap,
        device_id: device.to_string(),
    }
}

#[test]
fn dual_paths_routed_and_confirmed_before_capture() {
    let devs = fixture_devices();
    let mic = devs
        .iter()
        .find(|d| d.kind == conversation_assistant_lib::audio::DeviceKind::Microphone)
        .unwrap();
    let loopback = devs
        .iter()
        .find(|d| d.kind == conversation_assistant_lib::audio::DeviceKind::Loopback)
        .unwrap();
    assert_ne!(mic.id, loopback.id);

    let mut router = AudioRouter::new();
    assert!(!router.dual_routed(SESSION));
    router
        .route(&route(AudioRole::SelfMic, &mic.id, false))
        .unwrap();
    assert!(!router.dual_routed(SESSION));
    router
        .route(&route(AudioRole::Remote, &loopback.id, false))
        .unwrap();
    assert!(router.dual_routed(SESSION));
    // Same device for the other role without remap: conflict, not mixing.
    assert!(router
        .route(&route(AudioRole::Remote, &mic.id, false))
        .is_err());
    assert_eq!(
        router.device_for(SESSION, AudioRole::SelfMic),
        Some(mic.id.as_str())
    );
}

#[test]
fn simultaneous_activity_keeps_both_attributions() {
    let clock = SessionClock::start();
    let mut self_ring = FrameRing::new(64);
    let mut remote_ring = FrameRing::new(64);
    // Two links, one per path: liveness is per-path, never a single speaker.
    let self_link = Link::new(0, 0);
    let remote_link = Link::new(0, 0);

    let mut cap = FixtureCapture::conversation(SESSION, 0);
    let mut self_ms = Vec::new();
    let mut remote_ms = Vec::new();
    while let Some(f) = cap.next_frame() {
        assert!(clock.now_ms() < 60_000, "test took too long");
        match f.role {
            AudioRole::SelfMic => {
                assert!(self_link.accept(&f));
                self_ms.push(f.session_ms);
                self_ring.push(f);
            }
            AudioRole::Remote => {
                assert!(remote_link.accept(&f));
                remote_ms.push(f.session_ms);
                remote_ring.push(f);
            }
        }
    }
    assert_eq!(self_ring.len(), 11);
    assert_eq!(remote_ring.len(), 11);
    // Per-source timestamps monotonic.
    assert!(self_ms.windows(2).all(|w| w[0] <= w[1]));
    assert!(remote_ms.windows(2).all(|w| w[0] <= w[1]));
    // Overlap window present on both paths: nobody was forced to yield.
    assert!(self_ms.iter().any(|&m| (50..=100).contains(&m)));
    assert!(remote_ms.iter().any(|&m| (50..=100).contains(&m)));
    // Attribution survived the buffers.
    while let Some(f) = self_ring.pop() {
        assert_eq!(f.role, AudioRole::SelfMic);
        assert_eq!(f.source_id, format!("{SESSION}:self"));
    }
    while let Some(f) = remote_ring.pop() {
        assert_eq!(f.role, AudioRole::Remote);
        assert_eq!(f.source_id, format!("{SESSION}:remote"));
    }
    assert_eq!(self_ring.dropped() + remote_ring.dropped(), 0);
}

#[test]
fn reconnect_re_epochs_without_mixing() {
    let mut link = Link::new(0, 0);
    let live: Vec<_> = scripted_conversation(SESSION, 0);
    assert!(live.iter().all(|f| link.accept(f)));

    // Device lost mid-session: the dead stream's late flush is rejected.
    link.on_device_lost();
    assert!(!live.iter().any(|f| link.accept(f)));
    // Bounded retries, then reacquire at a new epoch with a fresh clock offset.
    let mut delays = Vec::new();
    while !matches!(link.state(), LinkState::Live { epoch: 1 }) {
        if let Some(d) = link.on_retry() {
            delays.push(d);
        } else {
            break;
        }
        if delays.len() == 1 {
            link.on_reacquired();
        }
    }
    assert_eq!(delays, vec![250]);
    let fresh = scripted_conversation(SESSION, 1);
    assert!(fresh.iter().all(|f| link.accept(f)));
    // Old-epoch stragglers arriving after reacquire are still rejected.
    assert!(!live.iter().any(|f| link.accept(f)));

    // Provider clock restarted at reconnect: fresh offset maps onto session time.
    let off = ProviderOffset::fresh(9600, 0);
    assert_eq!(map_provider_ms(9000, off), 18600);
}

#[test]
fn explicit_remap_takeover_is_recorded() {
    let mut router = AudioRouter::new();
    router
        .route(&route(AudioRole::SelfMic, "fixture-mic", false))
        .unwrap();
    let mut take = route(AudioRole::Remote, "fixture-mic", true);
    take.remap = true;
    assert_eq!(router.route(&take), Ok(Some(AudioRole::SelfMic)));
    assert!(!router.dual_routed(SESSION));
    assert_eq!(
        router.device_for(SESSION, AudioRole::Remote),
        Some("fixture-mic")
    );
}
