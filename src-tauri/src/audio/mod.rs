// Audio capture routing engine (P02/T05): device routing, session clock,
// bounded capture buffers, reconnect recovery, and a deterministic fixture
// source. WASAPI specifics stay behind the DeviceDescriptor/CaptureSource
// boundaries so unit and L1 integration tests run without hardware.
//
// Product invariant enforced by construction: the self-microphone path and the
// remote-loopback path are separately labeled from capture onward. A
// LabeledFrame always carries its role; downstream code cannot observe an
// unlabeled or mixed frame. See docs/ARCHITECTURE.md §5.

pub mod capture;
pub mod clock;
pub mod fixture;
pub mod recovery;
pub mod routing;

pub use capture::{CaptureSource, FrameRing, LabeledFrame};
pub use clock::{map_provider_ms, ProviderOffset, SessionClock};
pub use fixture::{fixture_devices, scripted_conversation, FixtureCapture};
pub use recovery::{Link, LinkState};
pub use routing::{AudioRole, AudioRouter, DeviceDescriptor, DeviceKind, RouteConfig, RouteError};
