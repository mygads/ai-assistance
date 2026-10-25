# Next actions
Status: P00 done (T00+T01+T02). T03 in progress; T04 queued.

1. T03 (active): replay-to-Send-to-reader vertical slice, acceptance A01/A02/A03/A05/A06. Evidence so far: replay 3/3 + UI 4/4 pass, but the slice needs an integrated task-level proof (replay corpus → Send snapshot/registry → reader cursor) recorded under T03.
2. T04 (after T03): smallest native real-IPC slice, acceptance A15. Note: test:native already passes 4/4 (start_session + send_answer through the real binary); T04 must cite that plus its own slice evidence.
3. Only after T03+T04: fan out P02 lanes (audio/providers, UI/prompter, context/data) with isolated worktrees; max 3 workers.

Blockers carried forward: B01 resolved (Rust 1.99.1 + MSVC 14.44 + WebView2 SDK compile verified). B02 remains (no provider keys → test:live blocked, owner: user). Physical-audio capture and meeting-capture calibration remain blocked on hardware/session prerequisites, not passes.
