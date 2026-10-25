// STT + LLM provider adapters and protocol fixtures (P02/T06, P03/T11).
//
// The seam where provider wire messages become transcript events (STT) and
// streamed answer chunks (LLM). Live network calls are NOT here: they land
// behind keys and budgets (T19). Everything in this module runs
// deterministically against scripted wire sequences whose shapes mirror the
// repo's fixture-server/TS-adapter contract; exact live wire conformance
// against current provider docs is a T11/T19 job (see ADR-016). External
// providers remain a replaced boundary, labeled as such in every test note.
pub mod adapter;
pub mod deepgram;
pub mod error;
pub mod event;
pub mod fixture;
pub mod llm;
pub mod soniox;

pub use adapter::{AdapterPoll, StreamCtx, SttAdapter};
pub use deepgram::normalize as normalize_deepgram;
pub use error::SttError;
pub use event::{EventBuild, ProviderTranscriptEvent, TranscriptStatus};
pub use fixture::{soniox_session_script, ProviderKind, ReplayAdapter, WireMessage};
pub use llm::{
    drive_stream, estimate_tokens as estimate_llm_tokens, validate_configuration,
    validate_configuration_with, AnswerAssembler, FixtureLlmAdapter, LlmAdapter, LlmCapabilities,
    LlmError, LlmPoll, LlmScript, LlmUsage, StreamOutcome,
};
pub use soniox::normalize as normalize_soniox;
