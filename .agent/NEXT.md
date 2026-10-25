# Next actions
Status: P01 complete (T00–T04 integrated at b331d9b). P02 executing SERIALLY — subagent worktree isolation is unavailable in this installation (Agent tool refuses: no WorktreeCreate hooks), so per AGENTS.md/EXECUTION.md the coordinator implements the lane graph one lane at a time with the same roles/paths/evidence. Wave-1 worktrees were created then removed; no parallel writes happened.

1. T05 DONE: audio routing engine (src-tauri/src/audio/**) + L1-audio-routing integration; unit 22/0, integration 6/6, check 5/5. ADR-015 defers device-selection IPC to T10.
2. T06 DONE: STT adapter seam (src-tauri/src/providers/**) + tests/provider/** fixtures + L1-stt-adapters integration + L1-slice-stt-protocol-replay; unit rs 36/0, integration 7/7, replay 6/6, check 5/5. ADR-016: fixtures mirror the repo fixture contract, not claimed live wire (T11 job).
3. T07 ACTIVE (coordinator-implemented): dashboard + reading overlay (A12), required check test:ui. Then T08 (voice-follow, needs T07) -> T09 (context) -> T10 integration barrier.

Blockers carried forward: B01 resolved. B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
