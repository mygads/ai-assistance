# Self-review memo (coordinator) — NOT an independent review

Date: 2026-10-25. Scope: working tree at 4f99722 + uncommitted scripts/test-native.mjs
(2 new L3 cases). Method: targeted re-inspection, no execution beyond
`node --check`. This memo is partial input only; T25 requires a genuine
independent reviewer and stays pending.

## 1. rename_all coverage (T17 fix completeness)
- All 5 bare-scalar handlers carry `rename_all = "snake_case"`: list_sources,
  pause_session, resume_session, stop_session, cancel_answer. Verified.
- All 8 remaining plain `#[tauri::command]` handlers take struct inputs
  (IngestTranscriptInput, StartSessionInput, TranscriptRangeInput,
  SendAnswerInput, SeekReaderInput, SaveCorrectionInput, ImportDocumentInput,
  SelectModelProfileInput) — serde matches their snake_case fields exactly,
  unaffected by the macro camelCase default. Verified by signature grep.
- scripts/check.mjs statically rejects any future bare-scalar handler missing
  the attribute. Fail-closed. No finding.

## 2. New L3 additions (uncommitted)
- L3-token-seek-native: clicks token-5, expects reader-state committed=5 and
  band containing "mengapa". Testids confirmed in src/ui/overlay.tsx
  (token-{index}, reader-state format `committed={n} ...`, reading-band).
  Deterministic on the same seeded v2 synthesis the L2 token-seek proof uses.
  Sound, pending execution.
- L3-doc-import-native: fills doc-import-name/text, submits, expects
  "1 dokumen". Testids confirmed in src/ui/dashboard.tsx. Sound, pending
  execution. Note: imports into the default workspace of the test DB file —
  same file the restart test reuses; doc count assertion is scoped to the
  dashboard label, no cross-test interference (restart test only checks
  session roundtrip + DB bytes, and docs table growth does not shrink bytes —
  byte-equality assertion `122880→122880` could be affected if import runs
  before restart in the same DB file and grows the file. CHECK: restart test
  compares DB bytes before/after relaunch within its own block; the import
  happens earlier in the same run, so the baseline already includes the doc.
  No finding, but the full 15-case run must confirm.)

## 3. Known risks restated (no new findings)
- T18/T19 blocked on owner hardware/keys (B02). T21 pending 30-min soak.
- 60s tauri-driver readiness polls and NSIS async-removal poll are bounded
  and diagnosed; acceptable.
- No autonomous tools, account systems, or unrelated features added. No
  secrets in tree (L0 + L6 scans). No test hooks in production profile.

## Verdict
No defects found in the reviewed slice. Two new L3 cases approved for
execution; their pass/fail decides. Independent review (T25) still required.
