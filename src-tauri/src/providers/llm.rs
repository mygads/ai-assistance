// LLM provider streaming seam (P03/T11). Mirror of the STT adapter seam:
// poll-based, typed errors, no async in traits, no network here. Live
// sockets land behind keys + budgets (T19); everything in this module runs
// deterministically against scripted chunks. One answer never mixes chunks
// from two providers: the assembler rejects foreign chunks loudly.
// Retry policy (ARCHITECTURE §8): retry only before any chunk is consumed;
// once text is out, an interruption marks the answer instead of retrying.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmError {
    /// Network-level failure mid-stream. Retried at most once, and only if
    /// no chunk was consumed yet.
    Transport(String),
    /// Credentials rejected. Never retried silently; requires reconfiguration.
    Auth,
    /// Payload shape unrecognised. Details stay structural, never chunk text.
    MalformedChunk(String),
    /// Provider stayed silent past the configured bound.
    Timeout,
    /// Caller cancelled. Terminal for this attempt.
    Cancelled,
    /// A chunk arrived from a different provider than the one that started
    /// this answer. The answer is failed, never merged.
    MixedProvider { expected: String, got: String },
    /// Spend cap for the session/request would be exceeded.
    BudgetExceeded,
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Transport(d) => write!(f, "llm transport failure: {d}"),
            LlmError::Auth => write!(f, "llm provider rejected credentials"),
            LlmError::MalformedChunk(d) => write!(f, "malformed llm chunk: {d}"),
            LlmError::Timeout => write!(f, "llm provider timed out"),
            LlmError::Cancelled => write!(f, "generation cancelled"),
            LlmError::MixedProvider { expected, got } => write!(
                f,
                "chunk from provider {got} cannot join answer started by {expected}"
            ),
            LlmError::BudgetExceeded => write!(f, "spend cap would be exceeded"),
        }
    }
}

impl std::error::Error for LlmError {}

/// Token usage attached to a finished or interrupted answer. Counts are
/// heuristic estimates (chars/4, same convention as the TS estimator); the
/// margin to the provider's tokenizer is documented wherever they are shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LlmUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// Heuristic estimator. Labeled as such everywhere it is used.
pub fn estimate_tokens(chars: usize) -> u32 {
    chars.div_ceil(4) as u32
}

pub fn normalize_usage(prompt_chars: usize, completion_chars: usize) -> LlmUsage {
    LlmUsage {
        prompt_tokens: estimate_tokens(prompt_chars),
        completion_tokens: estimate_tokens(completion_chars),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmCapabilities {
    pub provider: String,
    pub model: String,
    pub input_limit: u32,
    pub output_limit: u32,
    pub context_limit: u32,
    pub streaming: bool,
    pub tools: bool,
    pub cancellation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmPoll {
    Delta(String),
    Done { usage: LlmUsage },
}

pub trait LlmAdapter {
    fn provider_id(&self) -> &str;
    fn capabilities(&self) -> LlmCapabilities;
    /// Next stream item. After `cancel`, polls return `Err(Cancelled)`.
    fn poll(&mut self) -> Result<LlmPoll, LlmError>;
    /// Cooperative cancel, safe to call from another thread.
    fn cancel(&self);
    /// Known chunk count when the script is finite (fixture). `None` for
    /// open-ended live streams, where completion is defined by Done alone.
    fn expected_deltas(&self) -> Option<usize> {
        None
    }
}

/// Key presence is reported as a boolean only; secret values never flow
/// through this seam, in logs, or in error text.
pub fn validate_configuration_with(key_present: bool) -> Result<(), LlmError> {
    if key_present {
        Ok(())
    } else {
        Err(LlmError::Auth)
    }
}

pub fn validate_configuration() -> Result<(), LlmError> {
    validate_configuration_with(
        std::env::var("LLM_API_KEY")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false),
    )
}

/// One answer's text assembly. Bound to the provider that started it; a
/// chunk from anywhere else fails loudly instead of merging.
pub struct AnswerAssembler {
    expected_provider: String,
    parts: Vec<String>,
}

impl AnswerAssembler {
    pub fn new(provider_id: &str) -> Self {
        Self {
            expected_provider: provider_id.to_string(),
            parts: Vec::new(),
        }
    }

    pub fn push_delta(&mut self, provider_id: &str, text: &str) -> Result<(), LlmError> {
        if provider_id != self.expected_provider {
            return Err(LlmError::MixedProvider {
                expected: self.expected_provider.clone(),
                got: provider_id.to_string(),
            });
        }
        self.parts.push(text.to_string());
        Ok(())
    }

    pub fn text(&self) -> String {
        self.parts.concat()
    }

    pub fn chunk_count(&self) -> usize {
        self.parts.len()
    }
}

/// Scripted LLM wire sequence driving the same `LlmAdapter` seam a live
/// socket would. Test boundary only; outputs are labeled fixture data.
#[derive(Debug, Clone)]
pub enum LlmScript {
    Delta(String),
    TransportError,
}

pub struct FixtureLlmAdapter {
    provider_id: String,
    capabilities: LlmCapabilities,
    queue: std::collections::VecDeque<LlmScript>,
    total_deltas: usize,
    completion_chars: usize,
    cancelled: Arc<AtomicBool>,
}

impl FixtureLlmAdapter {
    pub fn new(script: Vec<LlmScript>) -> Self {
        let total_deltas = script
            .iter()
            .filter(|s| matches!(s, LlmScript::Delta(_)))
            .count();
        Self {
            provider_id: "fixture-llm".to_string(),
            capabilities: LlmCapabilities {
                provider: "fixture-llm".to_string(),
                model: "fixture-p01".to_string(),
                input_limit: 32000,
                output_limit: 4096,
                context_limit: 32000,
                streaming: true,
                tools: false,
                cancellation: true,
            },
            queue: script.into(),
            total_deltas,
            completion_chars: 0,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Chunking mirrors the P01 worker exactly (6 words per delta, trailing
    /// space except on the last), so routing the worker through this adapter
    /// changes no observable event.
    pub fn for_suggestion(text: &str) -> Self {
        let words: Vec<&str> = text.split_whitespace().collect();
        let n = words.len().div_ceil(6);
        let mut script = Vec::with_capacity(n);
        for (i, chunk) in words.chunks(6).enumerate() {
            let tail = if i + 1 < n { " " } else { "" };
            script.push(LlmScript::Delta(format!("{}{tail}", chunk.join(" "))));
        }
        Self::new(script)
    }
}

impl LlmAdapter for FixtureLlmAdapter {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn capabilities(&self) -> LlmCapabilities {
        self.capabilities.clone()
    }

    fn poll(&mut self) -> Result<LlmPoll, LlmError> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(LlmError::Cancelled);
        }
        match self.queue.pop_front() {
            None => Ok(LlmPoll::Done {
                usage: LlmUsage {
                    prompt_tokens: 0,
                    completion_tokens: estimate_tokens(self.completion_chars),
                },
            }),
            Some(LlmScript::TransportError) => {
                Err(LlmError::Transport("fixture transport break".to_string()))
            }
            Some(LlmScript::Delta(text)) => {
                self.completion_chars += text.len();
                Ok(LlmPoll::Delta(text))
            }
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn expected_deltas(&self) -> Option<usize> {
        Some(self.total_deltas)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamOutcome {
    pub status: &'static str,
    pub text: String,
    pub usage: LlmUsage,
    pub retries: u32,
    pub error: Option<String>,
}

/// Drive one answer through the adapter seam: poll deltas, enforce the
/// single-provider rule, retry at most `max_retries` times and only before
/// any chunk is consumed, stop on cancel, and report usage estimated from
/// the frozen prompt plus the actually-assembled text.
pub fn drive_stream(
    mut make_adapter: impl FnMut() -> Box<dyn LlmAdapter>,
    prompt_chars: usize,
    should_cancel: &dyn Fn() -> bool,
    on_delta: &mut dyn FnMut(u32, &str) -> bool,
    max_retries: u32,
) -> StreamOutcome {
    let mut assembler: Option<AnswerAssembler> = None;
    let mut emitted = 0u32;
    let mut retries = 0u32;
    let mut emit_failed = false;
    let mut cancelled = false;
    let mut adapter_error: Option<String> = None;

    'attempts: loop {
        let mut adapter = make_adapter();
        let asm = assembler.get_or_insert_with(|| AnswerAssembler::new(adapter.provider_id()));
        loop {
            if should_cancel() {
                adapter.cancel();
            }
            match adapter.poll() {
                Err(LlmError::Cancelled) => {
                    cancelled = true;
                    break 'attempts;
                }
                Err(LlmError::Transport(_)) if emitted == 0 && retries < max_retries => {
                    retries += 1;
                    break;
                }
                Err(e) => {
                    adapter_error = Some(e.to_string());
                    break 'attempts;
                }
                Ok(LlmPoll::Delta(text)) => {
                    if let Err(e) = asm.push_delta(adapter.provider_id(), &text) {
                        adapter_error = Some(e.to_string());
                        break 'attempts;
                    }
                    if !on_delta(emitted, &text) {
                        emit_failed = true;
                        break 'attempts;
                    }
                    emitted += 1;
                }
                Ok(LlmPoll::Done { .. }) => {
                    break 'attempts;
                }
            }
        }
    }

    let done_received = adapter_error.is_none() && !emit_failed && !cancelled;
    // Mirrors the P01 worker: an empty stream (no consumed chunk) never
    // reports done; it reports cancelled.
    let completed = done_received && emitted > 0;
    let status = if completed {
        "done"
    } else if adapter_error.is_some() {
        "failed"
    } else {
        "cancelled"
    };
    let text = assembler.as_ref().map(|a| a.text()).unwrap_or_default();
    StreamOutcome {
        status,
        text: text.clone(),
        usage: LlmUsage {
            prompt_tokens: estimate_tokens(prompt_chars),
            completion_tokens: estimate_tokens(text.len()),
        },
        retries,
        error: adapter_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deltas(words: &[&str]) -> Vec<LlmScript> {
        words
            .iter()
            .map(|w| LlmScript::Delta(w.to_string()))
            .collect()
    }

    fn run(
        make: impl FnMut() -> Box<dyn LlmAdapter>,
        cancel_after: Option<u32>,
    ) -> (StreamOutcome, Vec<String>) {
        let mut seen = Vec::new();
        let count = std::cell::Cell::new(0u32);
        let mut on_delta = |_i: u32, text: &str| {
            seen.push(text.to_string());
            count.set(count.get() + 1);
            true
        };
        let out = drive_stream(
            make,
            100,
            &|| cancel_after.map(|n| count.get() >= n).unwrap_or(false),
            &mut on_delta,
            1,
        );
        (out, seen)
    }

    #[test]
    fn fixture_streams_scripted_deltas_in_order() {
        let make = || -> Box<dyn LlmAdapter> {
            Box::new(FixtureLlmAdapter::new(deltas(&["halo ", "dunia"])))
        };
        let (out, seen) = run(make, None);
        assert_eq!(seen, vec!["halo ".to_string(), "dunia".to_string()]);
        assert_eq!(out.status, "done");
        assert_eq!(out.text, "halo dunia");
        assert_eq!(out.retries, 0);
        assert!(out.usage.completion_tokens > 0);
        assert_eq!(out.usage.prompt_tokens, estimate_tokens(100));
    }

    #[test]
    fn suggestion_chunking_matches_six_words_per_delta() {
        let mut adapter = FixtureLlmAdapter::for_suggestion("satu dua tiga empat lima enam tujuh");
        let mut parts = Vec::new();
        while let LlmPoll::Delta(t) = adapter.poll().unwrap() {
            parts.push(t);
        }
        assert_eq!(
            parts,
            vec![
                "satu dua tiga empat lima enam ".to_string(),
                "tujuh".to_string()
            ]
        );
        assert_eq!(adapter.expected_deltas(), Some(2));
    }

    #[test]
    fn cancel_mid_stream_keeps_partial_text() {
        let make = || -> Box<dyn LlmAdapter> {
            Box::new(FixtureLlmAdapter::new(deltas(&["a ", "b ", "c "])))
        };
        let (out, seen) = run(make, Some(1));
        assert_eq!(out.status, "cancelled");
        assert_eq!(seen.len(), 1);
        assert_eq!(out.text, "a ");
    }

    #[test]
    fn transport_before_output_retries_once_then_done() {
        let mut calls = 0;
        let make = || -> Box<dyn LlmAdapter> {
            calls += 1;
            if calls == 1 {
                Box::new(FixtureLlmAdapter::new(vec![LlmScript::TransportError]))
            } else {
                Box::new(FixtureLlmAdapter::new(deltas(&["pulih"])))
            }
        };
        let (out, _) = run(make, None);
        assert_eq!(out.status, "done");
        assert_eq!(out.text, "pulih");
        assert_eq!(out.retries, 1);
    }

    #[test]
    fn transport_after_output_fails_without_retry() {
        let make = || -> Box<dyn LlmAdapter> {
            Box::new(FixtureLlmAdapter::new(vec![
                LlmScript::Delta("sebagian ".to_string()),
                LlmScript::TransportError,
            ]))
        };
        let (out, _) = run(make, None);
        assert_eq!(out.status, "failed");
        assert_eq!(out.retries, 0);
        assert_eq!(out.text, "sebagian ");
        assert!(out.error.unwrap().contains("transport"));
    }

    #[test]
    fn retry_exhausted_reports_failed() {
        let make = || -> Box<dyn LlmAdapter> {
            Box::new(FixtureLlmAdapter::new(vec![LlmScript::TransportError]))
        };
        let mut seen = Vec::new();
        let mut on_delta = |_i: u32, text: &str| {
            seen.push(text.to_string());
            true
        };
        let out = drive_stream(make, 0, &|| false, &mut on_delta, 0);
        assert_eq!(out.status, "failed");
        assert_eq!(out.retries, 0);
    }

    #[test]
    fn foreign_chunks_are_rejected_not_merged() {
        let mut asm = AnswerAssembler::new("provider-a");
        asm.push_delta("provider-a", "sah ").unwrap();
        let err = asm.push_delta("provider-b", "asing").unwrap_err();
        assert!(matches!(err, LlmError::MixedProvider { .. }));
        assert_eq!(asm.text(), "sah ");
        // A retry that lands on a different provider fails the whole answer.
        let make = || -> Box<dyn LlmAdapter> {
            struct Other(FixtureLlmAdapter);
            impl LlmAdapter for Other {
                fn provider_id(&self) -> &str {
                    "provider-b"
                }
                fn capabilities(&self) -> LlmCapabilities {
                    self.0.capabilities()
                }
                fn poll(&mut self) -> Result<LlmPoll, LlmError> {
                    self.0.poll()
                }
                fn cancel(&self) {
                    self.0.cancel()
                }
            }
            Box::new(Other(FixtureLlmAdapter::new(deltas(&["x"])))) as Box<dyn LlmAdapter>
        };
        let mut seen = Vec::new();
        let mut on_delta = |_i: u32, text: &str| {
            seen.push(text.to_string());
            true
        };
        // First attempt errors before output (retry allowed), retry lands on
        // provider-b while the assembler expects the fixture provider.
        let mut first = true;
        let make2 = || -> Box<dyn LlmAdapter> {
            if first {
                first = false;
                Box::new(FixtureLlmAdapter::new(vec![LlmScript::TransportError]))
                    as Box<dyn LlmAdapter>
            } else {
                make()
            }
        };
        let out = drive_stream(make2, 0, &|| false, &mut on_delta, 1);
        assert_eq!(out.status, "failed");
        assert!(out.error.unwrap().contains("provider-b"));
    }

    #[test]
    fn empty_script_never_reports_done() {
        let make = || -> Box<dyn LlmAdapter> { Box::new(FixtureLlmAdapter::new(vec![])) };
        let (out, _) = run(make, None);
        assert_eq!(out.status, "cancelled");
        assert_eq!(out.text, "");
    }

    #[test]
    fn configuration_reports_key_presence_only() {
        assert!(validate_configuration_with(true).is_ok());
        let err = validate_configuration_with(false).unwrap_err();
        assert_eq!(err, LlmError::Auth);
        // No secret value can leak: the input is a boolean, and the Display
        // carries no payload slot.
        assert!(!format!("{err}").contains("sk-"));
    }
}
