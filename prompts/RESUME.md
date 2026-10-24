Resume implementation using the current checkout, AGENTS.md, .agent/state.json, .agent/tasks.json, .agent/NEXT.md, recent handoffs, git status/log, and evidence indexes.

Reconcile persisted state against actual files, commits, running processes, and test results. Do not trust previous chat claims or resurrect old workers without checking that they exist. Preserve uncommitted user work. Acquire coordinator ownership before writing global state; do not run a second coordinator concurrently.

Continue the next ready tasks, using isolated workers only where the graph and path ownership permit. Fix failures and run required integrated checks. A previous pass from another commit is not proof for changed paths; use the invalidation rules in docs/TESTING.md.

Do not re-plan the entire product or restart completed milestones. Ask only for a genuinely missing external prerequisite after completing independent work. Finish with current evidence and checkpoint, not a promise to test later.

