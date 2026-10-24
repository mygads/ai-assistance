# ADR-013: Portable domain core in TypeScript, Rust owns IPC/storage/audio

Date: 2026-10-25. Coordinator decision (routine; reversible in P02 integration if evidence demands).

Context: docs/CONTRACTS.md allows isolating portable Rust crates from
`cfg(windows)` capture code so domain logic stays testable. The Windows host
now has a working Rust + MSVC toolchain, so both options are viable.

Decision:
- Domain rules (transcript upsert/session machines/snapshot + generation
  fencing/context budgets/reader matching/memory guards) are implemented once
  in `src/domain/*.ts` and unit-tested with the Node built-in runner.
- Rust (`src-tauri`) owns the Tauri command surface, SQLite session storage,
  and (in P02 lanes) WASAPI capture + provider adapters. Rust reuses the same
  JSON schemas and mirrors validation; it does not duplicate matching/budget
  policy.
- Generated TS bindings from Rust commands arrive in T02 (contract freeze);
  until then `src/ui/bridge.ts` types the IPC boundary explicitly.

Rationale: fastest honest L0/L1 coverage on this host (no build step for TS
tests), single source of product policy, and Rust compile times stay out of
the domain TDD loop. Risk (drift between TS policy and Rust enforcement) is
controlled by shared schemas, the ajv contract check in `npm run check`, and
L1 replay tests executing both sides in T03/P01.

Status: accepted for P00–P02. Reopen if replay/integration evidence shows divergence.
