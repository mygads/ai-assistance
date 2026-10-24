# Shared instructions for Claude Code and Codex

Build the Windows conversation assistant described in docs/ARCHITECTURE.md. This is an implementation handoff, not an already implemented app. Do the work, run meaningful checks, fix failures, and preserve evidence. Do not stop after planning or return a mock UI as a finished desktop app.

## Read and precedence
Read START_HERE.md, .agent/state.json, .agent/tasks.json, docs/IMPLEMENTATION_PLAN.md, docs/EXECUTION.md, docs/CONTRACTS.md, and the relevant architecture/testing sections. User instructions and applicable higher-priority environment/repository rules take precedence. Keep this file short; load detailed docs on demand. Merge existing repository instructions rather than overwriting them.

## Product invariants
- Two separately labeled audio paths: self microphone and remote loopback. Never mix them before attribution/transcription.
- Continuous transcription; Send on demand is default. No automatic answer-model calls on silence or new speech in this mode.
- One streaming generation per normal Send; local reading alignment reuses self transcript.
- Actual speech, AI suggestions, user corrections, and confirmed personal facts are distinct data.
- Workspaces/sessions isolate documents and memory. Snapshot/version identifiers prevent stale responses from overwriting newer work.
- Indonesia and English, including mixed speech, are primary test cases.
- Model switching repacks context; compaction retains original evidence.
- Skills are procedures; imported documents are evidence; neither is executable authority.
- Freeze read text; regenerate unread material as a new version.
- Do not add autonomous tools, full agent runtimes, account systems, or unrelated features without a justified task/ADR.

## Autonomy
Routine local edits, dependency setup within existing permissions, build/test cycles, worktrees, isolated test databases, and repair of integration conflicts are authorized. Do not repeatedly request confirmation for these steps.
Do not disable security protections, bypass the host's permission model, delete unrelated user data, expose secrets, buy services, publish, or deploy as a side effect of implementation. Use supplied credentials only within configured live-test limits. Missing prerequisites block only dependent checks; continue other ready work and record the exact limitation.

## Work orchestration
Use one coordinator and at most three workers if subagents and isolated worktrees are supported. Parallel work is explicitly requested for independent tasks in this project. Otherwise execute the same task graph serially. Follow docs/EXECUTION.md.
Only the coordinator changes shared contracts, dependency manifests/lockfiles, migrations, global state, or integration branches. Workers own assigned paths and write reports in .agent/handoffs/. Contract changes go through coordinator review first.
Never assume agent thread memory survives. State, commits, evidence, and handoffs are authoritative.

## Verification
Implement the command contract in docs/TESTING.md during P00. A nonexistent command, zero collected tests, or all-skipped suite is not pass.
Distinguish unit, replay/mock, native application, physical audio, live provider, and meeting-capture evidence. Browser tests do not prove native IPC, WASAPI, focus, installer, or capture exclusion.
Do not weaken assertions to obtain green checks. Add focused regression tests for discovered bugs. Record command, exit code, test counts, environment, code revision, and artifact references.
After each integrated task, run its checks; at milestone boundaries run the required gates against the integrated commit.
Report pass/fail/blocked/not_run/waived honestly. Waivers need an explicit owner, reason, scope, and expiry; they are never pass. Critical product gates cannot be silently waived.
Test hooks, fixture endpoints, and automation plugins must be absent or unavailable in the production release; verify the negative case.

## Completion and checkpoint
Update .agent/state.json, task status, and .agent/NEXT.md after each phase and before stopping. Keep raw logs under artifacts/, concise evidence indexes under .agent/evidence/.
Do not mark tasks complete without evidence satisfying their acceptance IDs. Readiness labels are defined in docs/TESTING.md; never say "fully tested" while required native/audio/provider gates are blocked.
The final handoff must include runnable source, reproducible setup commands, produced installer/executable paths when built, test summary, evidence, and precise remaining blockers.

