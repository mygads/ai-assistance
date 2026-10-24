# Execution, sessions, and parallel work

This document specifies development-agent orchestration. It is separate from the lightweight orchestrator inside the product.

## Coordinator
Exactly one coordinator owns the integration checkout, .agent/state.json, .agent/tasks.json, .agent/acceptance.json, schemas, dependency manifests/lockfiles, migrations, CI, and final gate decisions. Discover existing processes/state before claiming ownership. Use .agent/coordinator-lock.json with run ID, tool, host, checkout, start time, and heartbeat; implement atomic creation during P00. Treat stale locks as uncertain until verifying process/host status; never delete another active coordinator's lock.

Claude Code and Codex can alternate coordinator sessions. They can also work simultaneously as scoped workers in separate worktrees. Their built-in conversation histories are not shared state.

## Startup
1. Read instructions and current state. Record tool and host versions without printing credentials.
2. Inspect git root, branch, status, and recent commits. Initialize git only for a new unversioned project; preserve existing changes.
3. Reconcile phase/task claims with code and evidence.
4. Run doctor and pack validation. Identify available native desktop, audio endpoints, provider credentials, and cost controls as booleans.
5. Select ready tasks from the dependency graph.
6. Continue implementation; do not require a planning approval gate for routine authorized work.

P00 is sequential. Before parallel writes, commit the buildable baseline and versioned contracts. Prefer one small vertical slice with fixture adapters before a broad mock dashboard. The P01 replay/contract barrier must pass; an unavailable native host is recorded as blocked and does not prevent independent portable development.

Task status vocabulary: pending, in_progress, implemented, verified, blocked. An implementation dependency can advance from implemented or verified when interfaces and available focused checks are accepted; implemented never implies its acceptance IDs are fully verified. A task becomes verified only when its required checks and relevant acceptance evidence exist. Release gates require actual verification, not merely implemented dependencies.

## Parallel wave
Recommended capacity: coordinator + at most three workers. This is a limit, not a target; small/dependent changes stay serial.

| Lane | Owned paths after scaffold | Work |
|---|---|---|
| Audio/providers | src-tauri/src/audio/, src-tauri/src/providers/, tests/provider/ | Separate capture, STT, streaming provider adapters |
| UI/prompter | src/features/, src/ui/, src/workers/, tests/ui/, tests/prompter/ | Overlay, dashboard, local alignment |
| Context/data | src-tauri/src/context/, src-tauri/src/memory/, tests/context/, tests/fixtures/documents/ | Import, retrieval, snapshots and memory services |
| Verification | tests/e2e/, tests/native/, .agent/handoffs/review-* | Scoped tests or independent read-only review |

Ownership must be narrowed per task. Provider and audio work can be split only if paths and dependencies remain disjoint. Coordinating tests that touch global setup belongs to the coordinator.

Create explicit git worktrees from the same accepted baseline. Do not rely on a tool's default worktree branch/ref; verify it. Worker handoff includes baseline hash and resulting commits. Do not use two writing agents on one checkout even if their tools allow it.

Only coordinator installs dependencies that change shared manifests/lockfiles. Worker requests are ordinary integration decisions, not user permission questions.

## Merge barrier
Receive handoff → inspect diff and scope → integrate one branch at a time → resolve contract mismatches → run integrated checks → update tasks/state → freeze new baseline. Never merge conflicting changes concurrently or use blanket "ours/theirs" conflict resolution. A worker pass does not replace post-integration checks.

If a contract needs change, pause dependent writers, apply one versioned contract migration, regenerate types, update fixtures, run contract tests, and distribute the new baseline. Do not silently support incompatible event shapes.

## Sessions and milestones
Sessions are bounded implementation units, not mandatory separate chat windows. A capable agent should continue across milestones within one session while resources permit. At natural context boundaries, checkpoint before compaction or switching tools.

Suggested session boundaries:
- S00: P00 foundation and contracts.
- S01: P01 replay/native vertical slice.
- S02: P02 independent lanes and integration barrier.
- S03: P03 live adapters and complete user flow.
- S04: P04 memory/resilience and regression tests.
- S05: P05 native, audio, latency, visual, and soak verification.
- S06: P06 packaging, release checks, independent review.

A pending long soak job can run while the agent performs independent review. Preserve process IDs, output paths, timeouts, ownership, and polling instructions; communicate progress and do not replace a real-time soak with accelerated replay.

## Checkpoint
Coordinator writes:
- state: phase, actual baseline, integrated tasks, gate statuses, remaining blockers;
- NEXT.md: next 1–3 executable actions and relevant file paths;
- handoff: changed behavior, commands/results, evidence paths, decisions;
- active jobs: owned processes, ports, worktrees, and stop/reconnect instructions.

Use short state summaries. Keep raw logs out of instruction files. Workers write per-task handoffs; only coordinator consolidates state. Stop and resume must not lose unsaved user files or audio-session data.

## Blocked work
Missing key/Windows/audio/interactive desktop blocks only relevant gates. Complete other tasks and create a runnable verification path, but do not mark blocked gates pass. Ask for a single consolidated prerequisite only when needed; do not repeatedly ask for existing authorization.

If tools lack subagents/worktrees, retain the same roles, task IDs, ownership, and evidence, executing tasks serially. Do not simulate parallelism or invent worker results.

## Repair loop
Reproduce → identify cause → change smallest coherent implementation → add a regression covering the user-facing failure → run affected checks → run milestone gates → inspect evidence → update status.
Three failed repair attempts should trigger a diagnosis/ADR and a different approach, not silent retries or weakened tests. Continue independent work when the failure is environment-bound.

