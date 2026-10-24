# Implementation plan and gate criteria

All application tasks start pending. Commands listed here are target interfaces to implement in P00, not proof they currently exist. Task dependencies and ownership are in .agent/tasks.json. Values in required_checks refer to npm scripts except review, which means an independent review deliverable; do not invent an npm review command to impersonate a reviewer.

## P00 — foundation, environment, contracts (serial)
Inspect existing repository and instructions. Establish TypeScript/React/Vite and Tauri/Rust layout; use a supported toolchain discovered from current official docs. Pin resolved dependencies and commit lockfiles. Create canonical schemas/types, fixture adapters, isolated test-data roots, sanitized logs, and command entrypoints.
Implement doctor, setup, check, unit/integration, replay, browser, native, audio, live, soak, package, and report entrypoints as defined in TESTING.md.
Deliver: a launchable skeleton, fixture/mock mode clearly labeled, one minimal invoke/response roundtrip, and non-empty tests. An unavailable external environment must yield blocked, never a green placeholder.
Gate: build portable pieces, type/lint/unit/contract checks, browser launch, Windows build/native launch when host supports it. Record actual unavailable gates.

## P01 — first vertical slice (serial critical path)
Create two independent audio-source interfaces and a replay source. Normalize transcript partial/final revisions with a session clock. Provide a minimal real Rust storage/context/send path and streamed fixture response. Reuse self transcript for a basic local cursor.
Prove the flow: replay self+remote → persisted transcript → click Send → actual Rust context snapshot → fixture streaming adapter → visible naskah → self speech replay advances cursor.
The replay may replace external audio/STT/LLM boundaries; native IPC, context assembly, data storage, and cancellation must remain real in native integration tests.
Gate: no LLM-call event before Send; role separation; no duplicated partial; response version/cancel; cursor self-only; persistence across restart.

## P02 — independent implementation lanes (parallel after P01)
Audio/provider lane: WASAPI device routing, timestamps, reconnect, provider interfaces and fixture servers.
UI/prompter lane: reading overlay, stable paragraph anchors, local sequence matcher, skip/repeat/off-script recovery, keyboard/mouse and accessibility.
Context lane: document import, page/section provenance, FTS retrieval, pinned context, workspace isolation.
Coordinator owns migration/schema amendments and integrations. Tests are developed alongside each lane, not postponed to the end.
Gate: per-lane checks and one-at-a-time merge barrier; all replay flows still pass on integrated baseline.

## P03 — full live flow and model switching (serial integration)
Implement Soniox and Deepgram STT adapters according to current provider docs, with fixtures matching observed provider messages. Implement at least one real streaming LLM adapter and a second provider or compatible endpoint adapter for switch/fallback testing.
Support per-session model config, language output choice, context limits, bounded cancellation/retry, usage reporting, and prompt snapshot inspection in test builds.
Send takes a stable snapshot; overlapping speech continues; stale generations cannot overwrite newer responses.
Gate: fixture protocol/error tests; native dual-input flow; configured live smoke when credentials/caps exist; evidence distinctly labels every boundary. A model selector alone is not proof of actual model interchange.

## P04 — memory and robustness (parallel bounded tasks)
Implement separate profile/project/session/episodic/procedural stores; corrections, provenance, confirmed/draft states, conflicts, rollback, session summaries, scoped recall, and compaction budgets.
Implement fault recovery: lost device, STT disconnect, LLM timeout, interrupted generation, missing document page, restart and WAL/data integrity.
Learning is feedback-backed and versioned. Reading AI text does not verify personal facts. Budget profile has zero unsolicited generative calls while live; post-session consolidation is an explicit policy/action.
Gate: memory isolation and contamination tests; restart recovery; compaction retains active questions and evidence references; regression suite for failures.

## P05 — complete product verification (bounded parallel diagnostics; shared devices serial)
Run native UI through WebdriverIO/Tauri service with real IPC. Run Windows WASAPI loopback tests, actual available mic checks, provider smoke, reading alignment corpora, UI screenshots at Windows scaling levels, focus/hotkey/multi-window checks, and real-time soak.
Native physical-audio tests own an exclusive test-device lease; do not run competing endpoint/capture tests in parallel.
Use capture-exclusion compatibility checks for installed tools and supported capture modes, recording app/OS versions. Do not claim universal invisibility.
Measure click→useful phrase, ASR lag, dropped audio, resources including WebView2, false cursor jumps, and recovery time. Performance thresholds are candidates; adjust with an ADR and measured tradeoff, not to conceal failure.
Gate: TESTING.md release-candidate matrix and evidence for every acceptance ID. Missing environment remains blocked.

## P06 — package, independent review, final rehearsal (serial release gate)
Build release with test features/plugins removed. Produce Windows executable/installer on a Windows-capable build path. Exercise install/start/settings/persistence/uninstall on an isolated test profile/VM, preserving user data according to documented policy.
Verify updater signature behavior with test keys and a local test endpoint; production signing credentials are external prerequisites. An unsigned local build can be delivered accurately labeled; do not claim trusted publisher signing without the key/certificate.
Independent reviewer inspects integrated code/evidence, reproduces checks, and reports defects. Fix and rerun impacted gates plus final smoke. Hash final artifacts and associate them with the tested revision.
Deliver: source, installer/exe when produced, setup instructions, verification report, evidence indexes, resource/latency results, known limitations, and next actions for blocked gates.
No external publishing/deployment is part of this phase.

## Definition of completion
"Implementation complete" means required features exist and mapped checks pass at their supported levels.
"Release candidate verified" additionally requires real Windows UI/audio/provider evidence and installer checks. Report the narrower state if prerequisites are missing.
A plan, mock dashboard, browser screenshot, or scripted fixture response is not the finished requested application.

