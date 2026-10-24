# Verification, E2E, and evidence

The automation must implement and run tests; this document is not a test result. Initial gate state is not_run. Test collection must be non-empty. Report skips, expected tests, assertions, and environment limitations.

## 1. Test levels

| Level | Real components | Replaced boundaries | What it proves |
|---|---|---|---|
| L0 static/unit | Domain logic, schemas, matcher, budget functions | No OS/provider dependency | Local behavior and contracts |
| L1 replay integration | Pipeline, real DB, snapshots, cancellation, event normalization | Input WAV/events and provider fixtures | Deterministic multi-component behavior |
| L2 browser UI | React, UI actions, accessibility, screenshots | Native bridge may be mocked and labeled | Browser-visible interactions only |
| L3 native application | Built Tauri binary, real WebView2/IPC/Rust/storage | External STT/LLM may use loopback fixture servers | Actual application integration |
| L4 physical audio | WASAPI and actual available endpoints | Provider may be a fixture sink | Native capture/routing/timing |
| L5 live provider | Actual configured STT/LLM API | Fixture audio/documents are controlled inputs | Protocol, streaming and model behavior |
| L6 meeting/installer | Installed app and available capture/meeting tools | Record exact environment | Install workflow and specific capture compatibility |

L3 must not mock the IPC commands whose implementation is being verified. Test helpers may configure fixtures through a narrow test-only interface; actual session/context/provider code still runs.

No one level implies another. A JSON transcript replay proves no ASR accuracy. WAV replay through an actual STT provider proves ASR on that fixture, not physical mic capture.

## 2. Required command contract

Implement these npm script names in P00, using one package manager and one committed lockfile. Internally delegate to Rust/TypeScript/Windows tools; do not create successful echo placeholders.

| Script | Required behavior |
|---|---|
| npm run doctor | Write capability report: OS/toolchains/WebView/native GUI/audio/key-presence/budget; no secret values |
| npm run setup | Idempotent dependency/browser setup within permissions; preserve user configuration |
| npm run check | Typecheck, lint, Rust fmt/clippy where supported, schema/type drift |
| npm run test:unit | Non-empty TS and portable Rust unit tests |
| npm run test:integration | Real domain/storage/provider-normalization integration with fixture servers |
| npm run test:replay | Clocked two-source transcript/audio scenarios and deterministic outcomes |
| npm run test:ui | Browser component/journey checks; label native bridge replacement |
| npm run test:native | Built Windows Tauri with real IPC and native storage; WebdriverIO/Tauri service |
| npm run test:audio | Actual Windows endpoints and capture diagnostics under exclusive lease |
| npm run test:live | Configured real provider smoke, opt-in/caps, sanitized usage |
| npm run test:soak | Real-time long-run mode; accelerated replay is a different labeled mode |
| npm run test:capture | Specific Windows capture APIs/meeting compatibility matrix |
| npm run package | Release executable/installer; fail if real release cannot build |
| npm run test:installer | Isolated install/launch/persistence/update-policy/uninstall |
| npm run verify | Run applicable matrix and emit authoritative aggregate report |
| npm run verify:release | Strict required gate aggregation; any required blocked/not_run/fail means non-pass |
| npm run report | Evidence index and human-readable verification summary |

doctor and report may exit 0 when their own operation succeeds, but must retain blocked capabilities. Test wrappers use exit 0 for pass, 1 for fail, 2 for blocked prerequisite. The orchestrator understands 2; CI must not accidentally convert it to pass with continue-on-error or shell fallthrough. waivers are explicit states, not successful tests.

Before scripts exist, report that they are not implemented and perform P00. This instruction pack does not supply app test scripts with imaginary green results.

## 3. Core scenarios and assertions

| Scenario | Assertions |
|---|---|
| Continuous manual session | Two live transcript paths; zero answer-model requests until Send; no maintenance LLM request under budget mode |
| Multi-part question | Snapshot contains all selected remote segments and relevant self history |
| Partial revision | Same segment upserted; no repeated text or repeated generation |
| Lagging ASR at Send | Watermark gap displayed/handled; provisional text marked; no silent missing tail |
| Both speakers overlap | Both source labels preserved; self only drives reader cursor |
| Cancel and Send again | Old deltas ignored; each suggestion tied to one generation |
| Shorten/continue/revise | Frozen read prefix stable; unread result receives new version |
| Model switch | Request uses selected actual adapter/model; smaller context repacked with output reserve |
| Fallback midstream | No mixed-provider paragraph; interrupted state explicit |
| Restart | Stored final segments and settings recover; no replay of a provider request without deduplication |
| Workspace switch | Other workspace facts/docs excluded unless explicitly selected |
| Missing evidence | No fabricated biodata or document citation; unknown answer handled |
| Memory contamination | AI suggestion and reading it aloud do not promote an unverified personal fact |
| Compaction | Active question/corrections/names/numbers/source refs retained; originals available |
| Document failure | Failed pages/sections reported; source mapping not invented |
| Release test hooks | Fixture control/automation/debug endpoints absent or rejected in production build |

Use explicit known facts and expected source IDs for deterministic grounding tests. An LLM evaluator may supplement scoring but cannot be the only pass criterion or validate invented personal facts.

## 4. Fixture corpus

Create original, redistributable fixture text/audio/documents with a manifest of source/license, hash, language, speaker role, timing, expected text, and assertions. TTS-generated fixtures are labeled synthetic; do not pretend they represent all human accents.

At minimum:
- Indonesian, English, and mixed speech with technical terms.
- Number/currency/acronym normalization, names, filler, repeated clauses.
- Silence, mid-question pause, overlapping timelines, long and multi-part question.
- Same phrase in several script positions; off-script then rejoin; skipped sentence; repeated paragraph.
- Partial changes that retract a prior hypothesis.
- Reconnect with reset provider timestamps and duplicated network messages.
- Controlled PDFs with known page facts/tables plus malformed/scan cases.
- Cross-language retrieval: English query, Indonesian source and reverse.
- Up to 20 × 30-page generated documents for capacity testing; mark as synthetic scale fixture, not a realistic retrieval-quality benchmark.

Keep source fixtures outside production bundles. Real user documents/audio are not committed as test assets. A browser's Web Speech API is not accepted as proof of Windows WebView2 provider support; use the actual configured adapters.

## 5. Native UI and audio strategy

Use current official Tauri/WebdriverIO documentation. Windows WebView2 and driver route compatibility must be verified during setup. An embedded automation plugin belongs only in the test build and is removed from release. Use Playwright or equivalent browser testing for L2 only; do not confuse it with native verification.

L3 tests launch the actual app and:
- invoke real Rust session creation and transcript persistence;
- connect STT/LLM adapters to local controlled fixture servers;
- click Send and inspect the captured request plus visible streamed response;
- verify hotkeys, windows, focus, resize, source labels, errors, and restart.
Use role/label/test IDs and observable state, not sleep-based guessed timing or only DOM snapshots.

For L4:
- enumerate endpoint IDs; verify selected route and data format;
- play known fixture to selected output, capture with real WASAPI loopback, check duration/energy/correlation/timestamps;
- capture actual mic samples and report available signal/quality without assuming speech happened;
- if an existing approved virtual-audio pair is available, drive deterministic capture through it and label virtual-device evidence;
- do not auto-install kernel/virtual-audio drivers or alter global audio/security settings as a hidden test dependency;
- if controlled mic speech cannot be produced automatically, record the remaining physical-mic scenario as blocked/manual_required while completing other tests.

Disconnect/reconnect physical devices may need lab capability or user action. Simulated device-change events are useful L1/L3 tests but are not hot-plug proof.

## 6. Live provider and budget

Use local secret inputs; never print headers, keys, raw environment, or private documents in artifacts. Detect key availability as a boolean.

Read LIVE_TESTS_ENABLED and configured max spend/duration/call limits. When enabled and keys exist, run bounded live smoke without repeatedly asking for routine authorization. Query/verify current rate definitions to calculate a conservative budget before calls; if pricing/billing units cannot be bounded, mark budget_unknown instead of spending indefinitely.
Stop at cap, throttling, or authentication failure; preserve independent work. Rate-limit each suite, and account for both STT streams. No signup, purchase, new subscription, or publishing is implied.

Test at least:
- STT recognition on controlled Indonesia/English/mixed WAV.
- Interim/final semantics and time mapping.
- LLM streaming with selected actual model, cancellation, and output usage.
- A factual answer grounded in the supplied fixture documents.
- Request token count versus provider/model limits.
- Optional second real provider for actual interchange; fixture-only alternative is reported accordingly.

## 7. Performance and visual checks

Measure click→first useful visible phrase and completion, ASR processing lag, dropped frames, reader wrong jumps, reacquire latency, network, CPU, memory, and WebView2 child processes. Record hardware, versions, sample count, p50/p95, measurement boundaries, and uncertainty.
Initial candidate targets from architecture: local matcher <50 ms/update; click→useful phrase p50 <1.5 s and p95 <3 s on the stated connection. They are design targets. Failure is diagnostic evidence, not permission to relabel the metric as first empty token.

Run a genuine 30–60 minute soak; record wall-clock duration, retries, queue/memory growth, and transcript loss. Fast replay cannot satisfy the real-time soak gate.

Inspect dashboard and overlay screenshots at supported sizes; Windows 100/125/150% scaling where available; long English/Indonesian text; light/dark; reduced motion; keyboard-only use; focus preservation; scrolled/read text stability. Browser viewport emulation is not proof of actual Windows scaling.

Capture exclusion: test Windows capture APIs and installed meeting/recording modes with a visible calibration pattern in the assistant. Verify whether the calibration is absent in capture while the app remains visible locally. Record failed/untested combinations. One successful screenshot does not prove all Zoom/Meet/Teams versions or remote recordings.

## 8. Evidence format and gating

For each run write artifacts/<run-id>/report.json and relevant logs/screenshots/protocol transcripts with secrets removed. Concise index: .agent/evidence/<run-id>.json. Use .agent/schemas/run-report.schema.json.

Include UTC time plus user-facing timezone if shown, host/OS, app revision, dirty-tree fingerprint when relevant, tool versions, test level, named cases, counts, exact command, exit code, duration, boundaries replaced, statuses, and evidence paths.
A pass requires non-empty evidence from the code under test. Screenshots alone do not prove request payloads or persistence. Store hashes for packaged executables/installers and fixture manifests.

Status: pass, fail, blocked, not_run, waived.
Readiness:
- implementation_in_progress;
- replay_verified;
- native_verified;
- hardware_verified;
- provider_verified;
- release_candidate_verified.

These labels can coexist as independent facets; do not infer provider_verified from native_verified. release_candidate_verified requires all configured critical gates, installer smoke, hook-removal check, and independent review. An unsigned development installer is explicitly labeled.

Invalidation:
- Schema/native IPC/storage/audio changes invalidate related L1/L3/L4 gates.
- Provider adapter/config changes invalidate protocol and relevant L5 gates.
- UI/reader changes invalidate reader/visual/native interaction checks.
- Memory/context/document changes invalidate grounding/isolation/compaction checks.
- Packaging/updater changes invalidate release/installer checks.
- Dependency/toolchain changes require build, smoke, and affected platform checks.
Final release is checked against the final integrated revision/artifact, not unrelated earlier branch results.

## 9. CI and local runners

Implement portable static/unit/replay/browser checks in CI, Windows build and native checks on a runner with verified desktop capabilities, and hardware/live/meeting checks on a controlled Windows runner when available.
Do not assume a hosted Windows CI runner has an interactive desktop, enabled audio endpoints, webcam, installed meeting apps, or access to secrets on forked PRs.
CI workflow creation is authorized locally; pushing/enabling external services is not necessary to finish the local deliverable. If there is no configured external repo, deliver workflow files and reproducible local commands.

