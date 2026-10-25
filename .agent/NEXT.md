# Next actions
Status: P01 in progress. T00–T03 implemented and integrated; T04 in progress.

1. T04 (active): smallest native real-IPC slice, acceptance A15. Note: test:native already passes 5/5 covering start_session → ingest → snapshot → streamed suggestion → identical-resend dedup through the real binary; T04 must cite that plus a task-level slice statement, not new code unless gaps appear.
2. After T04: fan out P02 lanes (audio/providers, UI/prompter, context/data) with isolated worktrees; max 3 workers; coordinator owns contracts/migrations.
3. T03 delivered: ingest_transcript_event (ADR-014, 13th command), real SQLite snapshot/send/cancel/correction, deterministic fixture delta streaming (Rust + fixture bridge mirror), restart persistence with safe machine defaults.

Blockers carried forward: B01 resolved. B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
