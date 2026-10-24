Task ID: <task_id>
Role: <role file>
Baseline commit: <full integrated commit>
Owned paths: <explicit directories/files>
Dependencies already integrated: <task IDs>
Acceptance IDs and required checks: <IDs + commands>
Do not edit: shared state, schemas, dependency manifests/lockfiles, migrations, or another worker's paths.
Worktree and branch: <absolute worktree path + unique branch>

Read AGENTS.md and your role. Confirm git root, HEAD, and baseline before editing. If baseline is absent, request coordinator integration before continuing. Implement only the task, run focused checks, and write .agent/handoffs/<task_id>.md with changed paths, commits, tests, exact limitations, and suggested integration checks. Do not claim your branch tests prove the integrated application. Send needed shared changes to coordinator. Stop if scope conflicts with another worker.

