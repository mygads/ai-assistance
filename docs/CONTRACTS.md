# Canonical contracts

Initial product contract version: 0.3. Coordinator owns schema changes and generated types. JSON Schema files under .agent/schemas/ define the normalized boundary. Provider messages must be converted through adapters. Do not expose provider-specific event shape directly to React.

## Module boundaries
- UI: rendering, user actions, tentative/committed reader state and token-to-view mapping.
- Native shell: window/device integration, credential access, commands, IPC and lifecycle.
- Portable domain core: session revision, snapshots, context budgets, memory rules, database domain services.
- Provider adapters: STT and text streaming protocols, usage, cancel/reconnect.
- Preparation workers: parsing/OCR/indexing, inactive when not needed.
- Verification harness: fixture servers, replay, metrics and test-only control.

Coordinator may isolate portable Rust crates from cfg(windows) capture code so Linux agents can test real domain logic. Record actual paths in state/ownership once scaffolded; do not import Windows-only bindings into every portable unit.

Audio PCM stays within capture/provider pipeline. React receives meters/transcripts/status, not every PCM frame. No high-frequency database/network work inside capture callbacks.

## Transcript
Use transcript-event.schema.json. segment_id is stable within a provider connection/source; revision increases. UTC logging timestamp is distinct from start_ms/end_ms on the common session-monotonic timeline. On reconnect, map provider time through a new connection offset. Overlap is valid.

Partial replaces a prior hypothesis; final commits it. If a provider later amends its final result, represent that as an explicit correction event/version, not an unexplained duplicate. confidence and word timings may be absent; do not fabricate them.

## Native command surface
Target names: list_sources, start_session, pause_session, resume_session, stop_session, select_transcript_range, send_answer, cancel_answer, seek_reader, save_correction, import_document, select_model_profile.
Each command accepts typed input, returns a typed Result/error with stable code and sanitized message, and has real command-level integration tests. Adapt names once during P00, then freeze generated bindings and update all references.

Test-only fixture commands are compiled behind a test-harness feature, bound to test app-data roots and loopback endpoints. Production must reject or omit them. Normal commands must not acquire arbitrary filesystem/network authority from document contents.

## Snapshot and generation
A snapshot is immutable: session_id, cutoff_ms, revision, selected segment IDs/revisions, self context, active question target, confirmed profile/project version, skill versions, document versions/excerpt IDs, read cursor, provisional flags, and model profile.

Snapshot construction handles capture/STT watermark mismatch explicitly. Ongoing transcripts append to session state and do not mutate an in-flight prompt.

Generation events carry request_id, suggestion_version, sequence and event kind. Only the active generation may update the visible pending suggestion. Cancellation ignores late deltas while preserving already shown text as an interrupted version. Never concatenate outputs from fallback providers into one answer.

Model configuration declares capabilities and limits; changing provider causes token repacking and adapter selection. Prompt instructions, actual speech, source documents, memory, and previous AI suggestions remain distinct blocks.

## Reader
Script tokens have stable IDs; offsets used by React are UTF-16 code-unit indices, or mapping stays entirely in the same JS module. Rust must not send byte offsets and label them as JS character indices.
Reader tracks suggestion_version, tentative_token, committed_token, mode and confidence_state. Interim correction can retract tentative progress; committed movement has hysteresis/anchor checks.
Citations, Markdown syntax, and UI labels are excluded from spoken text through an explicit display mapping. Paragraph currently being read is stable; revised unread text gets a new suggestion_version.

## Context and memory
Every stored/retrieved item has workspace/session scope and source references. Suggested response != actual self speech != confirmed personal fact.
A memory item includes kind, scope, content, status draft/confirmed/superseded, evidence references, version, timestamps and supersedes ID.
Compaction summarizes covered ranges with input_revision and references. It does not delete originals or overwrite a newer correction. Budget-mode live operation must not generate hidden maintenance calls.

## Report
Use run-report.schema.json for app verification and state.schema.json for coordinator state. App results need actual executed commands and explicit levels. Initial pack validation results are separate and must not create an app run marked pass.

