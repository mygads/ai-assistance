# ADR-017: Device-selection IPC stays deferred to T12 (T10 barrier)

Date: 2026-10-25. Status: accepted.

## Context
ADR-015 deferred live device-selection IPC (`route_audio`, `list_devices`, …)
to "the T10 integration barrier (or T12 full flow)". At the T10 barrier the
P02 lanes are integrated with the contract frozen at 13 commands
(`gen:ipc` regenerates `src/ui/ipc.ts` byte-identical; `check` contract-freeze
5/5). Physical-audio verification stays blocked on the hardware lease (P05,
`test:audio` blocked), so no new device IPC could be proven against real
WASAPI devices at this barrier.

## Decision
- Keep the IPC contract frozen at 13 commands through T10. No
  device-selection commands are added at this barrier.
- Real device enumeration binds in T12 (full user flow), as a versioned
  contract migration with regenerated types — per docs/EXECUTION.md, never
  silently — where the P05 hardware lease can prove it end to end.

## Consequences
- `list_sources` (seeded in `start_session`) remains the UI's source surface
  through P02; engine semantics from T05 are unchanged.
- T10 freezes the integrated P02 baseline with zero contract drift since P01.
