# Next actions
Status: P01 complete (T00–T04 integrated at b331d9b). P02 executing SERIALLY — subagent worktree isolation is unavailable in this installation (Agent tool refuses: no WorktreeCreate hooks), so per AGENTS.md/EXECUTION.md the coordinator implements the lane graph one lane at a time with the same roles/paths/evidence. Wave-1 worktrees were created then removed; no parallel writes happened.

1. T05 DONE: audio routing engine (src-tauri/src/audio/**) + L1-audio-routing integration; unit 22/0, integration 6/6, check 5/5. ADR-015 defers device-selection IPC to T10.
2. T06 ACTIVE (coordinator-implemented): STT adapters + protocol fixtures. New src-tauri/src/providers/** + tests/provider/**. Required checks: test:integration + test:replay. No live calls (B02: no keys).
3. Follow-up: acceptance.json still shows not_run for A01–A15 (evidence lives on tasks/state). Roll up statuses with evidence refs at the T10 barrier.

Blockers carried forward: B01 resolved. B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
