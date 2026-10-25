# Next actions
Status: P01 complete (T00–T04 integrated at b331d9b). P02 executing SERIALLY — subagent worktree isolation is unavailable in this installation (Agent tool refuses: no WorktreeCreate hooks), so per AGENTS.md/EXECUTION.md the coordinator implements the lane graph one lane at a time with the same roles/paths/evidence. Wave-1 worktrees were created then removed; no parallel writes happened.

1. T05 ACTIVE (coordinator-implemented): WASAPI routing/recovery. New module src-tauri/src/audio/** + src-tauri/tests/audio_*.rs. Required checks: test:unit + test:integration. L4 physical stays blocked.
2. Then T06 (src-tauri/src/providers/** + tests/provider/**) → T07 (src/ui/** overlay) → T09 (context lane) → T10 integration barrier. T08 after T07 merges.
3. Follow-up: acceptance.json still shows not_run for A01–A15 (evidence lives on tasks/state). Roll up statuses with evidence refs at the T10 barrier.

Blockers carried forward: B01 resolved. B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
