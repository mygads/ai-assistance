// STT provider adapters and protocol fixtures (P02/T06).
//
// The seam where provider wire messages become transcript events. Live
// network calls are NOT here: they land in P03 (T11/T19) behind keys and
// budgets. Everything in this module runs deterministically against scripted
// wire messages whose shapes mirror the repo's fixture-server/TS-adapter
// contract; exact live wire conformance against current provider docs is a
// T11 job (see ADR-016). External STT remains a replaced boundary, labeled
// as such in every test note.
pub mod adapter;
pub mod deepgram;
pub mod error;
pub mod event;
pub mod fixture;
pub mod soniox;

pub use adapter::{AdapterPoll, StreamCtx, SttAdapter};
pub use deepgram::normalize as normalize_deepgram;
pub use error::SttError;
pub use event::{EventBuild, ProviderTranscriptEvent, TranscriptStatus};
pub use fixture::{soniox_session_script, ProviderKind, ReplayAdapter, WireMessage};
pub use soniox::normalize as normalize_soniox;
