# ADR-015: WASAPI routing engine without new IPC commands (T05)

Date: 2026-10-25. Status: accepted.

## Context
T05 (P02 audio lane) needs device routing and reconnect recovery with the
dual-path invariant (self mic vs remote loopback never mix before
attribution). The frozen IPC contract (`.agent/schemas/ipc-commands.json`,
13 commands) already carries sources (`list_sources`, seeded in
`start_session`) and transcript ingest. Exposing live device selection
(`route_audio`, `list_devices`, …) would churn the contract mid-lane while
three P02 lanes are in flight.

## Decision
- Implement the routing engine as a self-contained Rust module
  (`src-tauri/src/audio/`): `AudioRouter` (explicit role→device mapping,
  silent-sharing is a `Conflict`), `SessionClock` + provider-offset mapping,
  `FrameRing` (bounded, drop-counted), `Link` (typed loss, bounded backoff,
  epoch bump with stale-frame rejection), and a deterministic fixture source.
- Wire only `pub mod audio;` into `lib.rs`. No new IPC commands in T05.
- Device-selection IPC rides the T10 integration barrier (or T12 full flow),
  as a versioned contract migration with regenerated types — per
  docs/EXECUTION.md, never silently.

## Consequences
- T05 acceptance A01 is proven at L0/L1 (unit + `audio_routing` integration:
  dual routing, simultaneous activity, reconnect re-epoch, monotonic clocks).
  A16/L4 physical-device behavior stays blocked on hardware lease (P05).
- The UI continues to show seeded sources via `list_sources`; real device
  enumeration binds at the T10 barrier without changing engine semantics.
- No manifest/contract/schema changes in T05; `cargo test --lib` and the new
  `cargo test --test audio_routing` target are the required checks.
