// Typed STT failures. Provider errors are data, never panics: the stream
// either recovers (reconnect with a fresh offset) or fails closed.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttError {
    /// Payload parsed but carried no usable transcript (empty segments,
    /// empty alternative). The stream continues; the frame is dropped.
    EmptyTranscript,
    /// Payload shape unrecognised (missing fields, wrong types).
    MalformedMessage(String),
    /// Recognised envelope that carries no transcript (e.g. metadata /
    /// keepalive frames a live socket would also emit). Skippable.
    NonTranscriptFrame(String),
    /// Network-level failure mid-stream.
    Transport(String),
    /// Credentials rejected. Never retried silently; requires reconfiguration.
    Auth,
    /// Provider stayed silent past the configured bound.
    Timeout,
    /// Capture device lost under a live socket.
    DeviceLost,
}

impl std::fmt::Display for SttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SttError::EmptyTranscript => write!(f, "provider frame carried no transcript"),
            SttError::MalformedMessage(d) => write!(f, "malformed provider message: {d}"),
            SttError::NonTranscriptFrame(t) => write!(f, "non-transcript provider frame: {t}"),
            SttError::Transport(d) => write!(f, "provider transport failure: {d}"),
            SttError::Auth => write!(f, "provider rejected credentials"),
            SttError::Timeout => write!(f, "provider timed out"),
            SttError::DeviceLost => write!(f, "capture device lost under live STT"),
        }
    }
}

impl std::error::Error for SttError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_render_without_leaking_payloads() {
        // Messages must stay diagnostic; raw payloads never enter Display.
        let e = SttError::MalformedMessage("x".to_string());
        assert_eq!(format!("{e}"), "malformed provider message: x");
    }
}
