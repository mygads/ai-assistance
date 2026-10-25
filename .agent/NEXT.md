# Next actions
Status: P01 complete. T00–T04 implemented and integrated.

1. T04 DONE 2026-10-25: smallest native real-IPC slice, acceptance A15 / scenario C23. test:native 6/6 against the real binary (start_session → 2× ingest_transcript_event → select_transcript_range read-back "Tersimpan 2 segmen" → streamed snapshot suggestion v1 "draf jawaban … arsitektur" → identical-resend dedup); test:ui 4/4 mirrors it through the labeled fixture bridge.
2. P02 next: verify subagent + isolated-worktree support first (per AGENTS.md work orchestration). If supported: one coordinator + up to three workers on isolated worktrees for the audio/providers, UI/prompter, and context/data lanes; coordinator owns contracts/migrations. Otherwise execute the task graph serially.
3. T03 delivered: ingest_transcript_event (ADR-014, 13th command), real SQLite snapshot/send/cancel/correction, deterministic fixture delta streaming (Rust + fixture bridge mirror), restart persistence with safe machine defaults.
4. Follow-up: acceptance.json still shows not_run for A01–A15 (prior closes recorded evidence on tasks/state only). Coordinator should roll A01–A15 statuses up with evidence refs before the P02 milestone gate.

Blockers carried forward: B01 resolved. B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
