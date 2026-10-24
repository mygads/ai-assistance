# Next actions
Status: P00 in progress. T00 implemented; pack baseline e6c8b78 committed.

1. Begin T01: scaffold portable TS core (session/transcript/snapshot/context/reader/memory), Vite+React UI skeleton, Tauri/Rust layout; add `check` and `test:unit` commands (non-empty, no placeholders).
2. Attempt Rust (rustup) + MSVC Build Tools setup within existing permissions; if unavailable, record exact limitation and keep portable work unblocked.
3. Add ajv (or equivalent) so `check` performs full Draft 2020-12 schema validation per pack warning.
4. Then T02: freeze schemas, generate TS types, implement full verification command contract (integration/replay/ui/native/audio/live/soak/capture/package/installer/verify/report).

Blockers carried forward: B01 (no Rust/MSVC → native/audio/package/installer gated), B02 (no provider keys → live gated).
