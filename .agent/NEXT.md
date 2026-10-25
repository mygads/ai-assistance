# Next actions
Status: P01 complete (T00–T04 integrated at b331d9b). P02 executing SERIALLY — subagent worktree isolation is unavailable in this installation (Agent tool refuses: no WorktreeCreate hooks), so per AGENTS.md/EXECUTION.md the coordinator implements the lane graph one lane at a time with the same roles/paths/evidence. Wave-1 worktrees were created then removed; no parallel writes happened.

1. T05 DONE: audio routing engine (src-tauri/src/audio/**) + L1-audio-routing integration; unit 22/0, integration 6/6, check 5/5. ADR-015 defers device-selection IPC to T10.
2. T06 DONE: STT adapter seam (src-tauri/src/providers/**) + tests/provider/** fixtures + L1-stt-adapters integration + L1-slice-stt-protocol-replay; unit rs 36/0, integration 7/7, replay 6/6, check 5/5. ADR-016: fixtures mirror the repo fixture contract, not claimed live wire (T11 job).
3. T07 DONE: dashboard + reading overlay (src/ui/dashboard.tsx + overlay.tsx); test:ui 10/10, native 6/6, verify fail=0 blocked=3. Stale-dist rebuild guard added to test-ui.mjs; action buttons use aria-disabled (focus preservation).
4. T08 DONE: stable voice-follow (ReaderSession + src/domain/reader.test.ts 12/12); unit ts 35/0, replay 8/8, ui 10/10, check 5/5.
5. T09 DONE (coordinator-implemented): import/provenance/retrieval (A08/A09). L1-context-retrieval 5/5, validateSourceRefs 6/6; check 5/5, unit ts 41/0 + rs 36/0, integration 8/8, replay 8/8, ui 10/10. T10 DONE: barrier verify 45 pass / 0 fail / 7 blocked (known prerequisites only), ADR-017 defers device IPC to T12, new baseline frozen.

6. T11 DONE (coordinator-implemented): LLM streaming seam (A05/A18 L0/L1). drive_stream + FixtureLlmAdapter + AnswerAssembler; worker routed, usage persisted; L1-llm-adapters 5/5; check 5/5, unit ts 41/0 + rs 45/0, integration 9/9, native 6/6, verify fail=0 blocked=3.

7. T12 DONE (coordinator-implemented): model switch + retrieval-backed context + action-aware flow — L1-model-switch-repack, L1-context-assembly, L3-model-switch-next-request; check 5/5, unit ts 41/0 + rs 50/0, integration 10/10, replay 9/9, ui 10/10, native 7/7, verify 49/0/7 blocked. A13-L5 stays blocked on B02 keys.

8. T13 ACTIVE: scoped memory and feedback learning (A09/A10) — structured notes, corrections, provenance, draft/confirmed states; required checks test:integration.

Blockers carried forward: B01 resolved. B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
