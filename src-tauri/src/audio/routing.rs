// Device routing: which physical endpoint feeds which role in a session.
// Per ARCHITECTURE.md §5.1 the user maps roles to devices explicitly; a
// device already routed to one role in a session can only be reused by the
// other role through an explicit remap, never silently.

use std::collections::HashMap;

/// Conversation side a capture path is attributed to. There are exactly two;
/// anything else is rejected at parse time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioRole {
    SelfMic,
    Remote,
}

impl AudioRole {
    /// Parses the stable `"self"` / `"remote"` labels used across IPC, storage,
    /// and transcript events. Anything else is an error, not a third role.
    pub fn parse(s: &str) -> Result<Self, RouteError> {
        match s {
            "self" => Ok(AudioRole::SelfMic),
            "remote" => Ok(AudioRole::Remote),
            other => Err(RouteError::UnknownRole(other.to_string())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AudioRole::SelfMic => "self",
            AudioRole::Remote => "remote",
        }
    }
}

/// Physical endpoint kind. Loopback captures the selected output endpoint;
/// process loopback captures one application's audio where Windows supports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    Microphone,
    Loopback,
    ProcessLoopback,
}

/// A stable device identity. `id` must be stable across reconnects of the same
/// endpoint (WASAPI device id); `label` is the human-readable name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceDescriptor {
    pub id: String,
    pub label: String,
    pub kind: DeviceKind,
}

/// One role's routing inside a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteConfig {
    pub session_id: String,
    pub role: AudioRole,
    pub source_id: String,
    /// When true, take over a device currently routed to the other role in the
    /// same session. The takeover is explicit and recorded, never silent.
    pub remap: bool,
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    UnknownRole(String),
    EmptyId(&'static str),
    /// The device already feeds the other role in this session; pass
    /// `remap: true` to take it over explicitly.
    DeviceAlreadyRouted {
        session_id: String,
        device_id: String,
        held_by: AudioRole,
    },
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::UnknownRole(r) => write!(f, "unknown audio role: {r}"),
            RouteError::EmptyId(what) => write!(f, "{what} must not be empty"),
            RouteError::DeviceAlreadyRouted { session_id, device_id, held_by } => write!(
                f,
                "device {device_id} in session {session_id} already feeds {}; pass remap:true to take over",
                held_by.as_str()
            ),
        }
    }
}

impl std::error::Error for RouteError {}

/// Owns the session → role → device mapping. Devices are caller-provided
/// descriptors (real WASAPI enumeration in P05/native, fixture lists in tests);
/// the router enforces the no-silent-sharing rule, not enumeration itself.
#[derive(Debug, Default)]
pub struct AudioRouter {
    /// ((session_id, role) -> device_id), plus reverse lookup for conflicts.
    routes: HashMap<(String, AudioRole), String>,
    sources: HashMap<(String, AudioRole), String>,
}

impl AudioRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Route `cfg.role` in `cfg.session_id` to `cfg.device_id`, recording the
    /// transcript `source_id` alongside. Returns the displaced role, if any,
    /// when `remap` takes a device over explicitly.
    pub fn route(&mut self, cfg: &RouteConfig) -> Result<Option<AudioRole>, RouteError> {
        if cfg.session_id.trim().is_empty() {
            return Err(RouteError::EmptyId("session_id"));
        }
        if cfg.device_id.trim().is_empty() {
            return Err(RouteError::EmptyId("device_id"));
        }
        if cfg.source_id.trim().is_empty() {
            return Err(RouteError::EmptyId("source_id"));
        }
        let key = (cfg.session_id.clone(), cfg.role);
        // Same role re-routed to the same device is a no-op, not a conflict.
        if self.routes.get(&key).is_some_and(|d| d == &cfg.device_id) {
            return Ok(None);
        }
        // Another role holding this device blocks silent reuse.
        let other = match cfg.role {
            AudioRole::SelfMic => AudioRole::Remote,
            AudioRole::Remote => AudioRole::SelfMic,
        };
        if self
            .routes
            .get(&(cfg.session_id.clone(), other))
            .is_some_and(|d| d == &cfg.device_id)
        {
            if !cfg.remap {
                return Err(RouteError::DeviceAlreadyRouted {
                    session_id: cfg.session_id.clone(),
                    device_id: cfg.device_id.clone(),
                    held_by: other,
                });
            }
            self.routes.remove(&(cfg.session_id.clone(), other));
            self.sources.remove(&(cfg.session_id.clone(), other));
            self.routes.insert(key.clone(), cfg.device_id.clone());
            self.sources.insert(key, cfg.source_id.clone());
            return Ok(Some(other));
        }
        self.routes.insert(key.clone(), cfg.device_id.clone());
        self.sources.insert(key, cfg.source_id.clone());
        Ok(None)
    }

    pub fn unroute(&mut self, session_id: &str, role: AudioRole) -> bool {
        let key = (session_id.to_string(), role);
        self.sources.remove(&key);
        self.routes.remove(&key).is_some()
    }

    pub fn device_for(&self, session_id: &str, role: AudioRole) -> Option<&str> {
        self.routes
            .get(&(session_id.to_string(), role))
            .map(String::as_str)
    }

    pub fn source_for(&self, session_id: &str, role: AudioRole) -> Option<&str> {
        self.sources
            .get(&(session_id.to_string(), role))
            .map(String::as_str)
    }

    /// Both roles routed in this session (used by the session-start path to
    /// confirm the dual-path invariant before capture begins).
    pub fn dual_routed(&self, session_id: &str) -> bool {
        self.device_for(session_id, AudioRole::SelfMic).is_some()
            && self.device_for(session_id, AudioRole::Remote).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(session: &str, role: AudioRole, device: &str) -> RouteConfig {
        RouteConfig {
            session_id: session.to_string(),
            role,
            source_id: format!("{session}:{}", role.as_str()),
            remap: false,
            device_id: device.to_string(),
        }
    }

    #[test]
    fn role_parses_only_known_labels() {
        assert_eq!(AudioRole::parse("self"), Ok(AudioRole::SelfMic));
        assert_eq!(AudioRole::parse("remote"), Ok(AudioRole::Remote));
        assert!(AudioRole::parse("speaker").is_err());
        assert!(AudioRole::parse("").is_err());
    }

    #[test]
    fn dual_paths_route_independently() {
        let mut r = AudioRouter::new();
        assert_eq!(r.route(&cfg("s1", AudioRole::SelfMic, "mic-1")), Ok(None));
        assert_eq!(r.route(&cfg("s1", AudioRole::Remote, "loop-1")), Ok(None));
        assert!(r.dual_routed("s1"));
        assert_eq!(r.device_for("s1", AudioRole::SelfMic), Some("mic-1"));
        assert_eq!(r.device_for("s1", AudioRole::Remote), Some("loop-1"));
        assert!(!r.dual_routed("s2"));
    }

    #[test]
    fn silent_device_sharing_is_a_conflict() {
        let mut r = AudioRouter::new();
        r.route(&cfg("s1", AudioRole::SelfMic, "mic-1")).unwrap();
        let err = r.route(&cfg("s1", AudioRole::Remote, "mic-1")).unwrap_err();
        assert_eq!(
            err,
            RouteError::DeviceAlreadyRouted {
                session_id: "s1".to_string(),
                device_id: "mic-1".to_string(),
                held_by: AudioRole::SelfMic,
            }
        );
        // Explicit remap takes over and displaces the previous holder.
        let mut take = cfg("s1", AudioRole::Remote, "mic-1");
        take.remap = true;
        assert_eq!(r.route(&take), Ok(Some(AudioRole::SelfMic)));
        assert_eq!(r.device_for("s1", AudioRole::Remote), Some("mic-1"));
        assert_eq!(r.device_for("s1", AudioRole::SelfMic), None);
    }

    #[test]
    fn same_role_same_device_is_idempotent() {
        let mut r = AudioRouter::new();
        r.route(&cfg("s1", AudioRole::SelfMic, "mic-1")).unwrap();
        assert_eq!(r.route(&cfg("s1", AudioRole::SelfMic, "mic-1")), Ok(None));
    }

    #[test]
    fn empty_ids_rejected() {
        let mut r = AudioRouter::new();
        let mut bad = cfg("", AudioRole::SelfMic, "mic-1");
        assert!(r.route(&bad).is_err());
        bad = cfg("s1", AudioRole::SelfMic, "  ");
        assert!(r.route(&bad).is_err());
    }

    #[test]
    fn unroute_clears_one_role_only() {
        let mut r = AudioRouter::new();
        r.route(&cfg("s1", AudioRole::SelfMic, "mic-1")).unwrap();
        r.route(&cfg("s1", AudioRole::Remote, "loop-1")).unwrap();
        assert!(r.unroute("s1", AudioRole::SelfMic));
        assert!(!r.dual_routed("s1"));
        assert_eq!(r.device_for("s1", AudioRole::Remote), Some("loop-1"));
        assert!(!r.unroute("s1", AudioRole::SelfMic));
    }
}
