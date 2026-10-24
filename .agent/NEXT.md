# Next actions
Status: P00 in progress. T00 + T01 implemented and integrated at d31425c; T02 in progress.

1. T02: freeze schemas, generate TS types from Rust command surface, implement the full verification command contract (test:integration/replay/ui/native/audio/live/soak/capture/package/installer/verify/report) with exit-code discipline 0/1/2.
2. T03 (after T02): replay-to-Send-to-reader vertical slice + native real-IPC slice; only then fan out P02 lanes (audio/providers, UI/prompter, context/data) with isolated worktrees.
3. Add ajv already done in T01 (`check` validates Draft 2020-12 + fixture timeline + state.json).

Blockers carried forward: B01 resolved (Rust 1.99.1 + MSVC 14.44 + WebView2 SDK compile verified). B02 remains (no provider keys → test:live blocked, owner: user).
