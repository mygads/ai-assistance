# ADR-016: STT protocol fixtures without live wire claims (T06)

Date: 2026-10-25. Status: accepted.

## Context
T06 needs STT adapter seams and protocol fixtures (acceptance A03/A04 at
L0/L1) while provider keys are absent (B02) and the P02 lanes run without
live networks. The repo already has an established fixture contract for both
providers: `scripts/lib/fixture-server.mjs` (SONIOX_SCENARIOS,
DEEPGRAM_SCENARIOS) plus `src/domain/adapters.ts` normalization.

## Decision
- Fixture wire shapes mirror the repo's own fixture contract, documented per
  file in `tests/provider/*.json` (`doc_ref` field). No claim of exact live
  Soniox/Deepgram wire conformance is made at T06.
- Rust (`src-tauri/src/providers/`) re-implements the same normalization
  semantics (partial/final, word-timing mapping, offset mapping, typed error
  frames) so L1 proves TS↔Rust parity by construction; the replay case
  (`L1-slice-stt-protocol-replay`) and the `stt_adapters` integration target
  run the same scripted sessions from opposite sides of the seam.
- Live socket clients, authentication, and conformance against current
  provider docs are explicitly a T11 (P03) job with keys + budgets.
  `liveTranscribeWav`/`liveCompleteStream` keep throwing until then.

## Consequences
- A03 partial/final + timestamps and A04 snapshot/ASR-lag handling are proven
  at L0/L1 on both sides of the seam with zero network calls.
- A18 (real configured providers within caps) stays blocked on B02; every
  T06 note labels the replaced boundary.
- The `providers` module exposes no IPC commands (same rationale as ADR-015);
  adapter output converts into the real ingest row type, proven by tests.
