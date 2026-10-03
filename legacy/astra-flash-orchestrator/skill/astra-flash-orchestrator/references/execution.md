# Execution and workspace ownership

## Default: one native writer, no extra harness

The default is one native Flash child in the current workspace for one coherent
end-to-end phase bundle. Astra supplies the contract, dispatches once, waits, and
reviews one completion report. The worker owns in-scope repository discovery,
implementation, tests, debugging, and routine browser/visual QA. This avoids a
second CLI process, environment-variable command string, automatic commits, and
accidental provider bypass. No `FLASH_WORKER_CMD` or external run_worker.sh is needed.

Before editing, capture the workspace root, current branch/HEAD when Git exists,
tracked/staged diff and untracked-file inventory. Preserve relevant pre-existing
file content in a safe local baseline when it is necessary to distinguish the
worker's changes. Never read or copy secrets just to snapshot the workspace.
Do not auto-stash, reset, commit, or discard user changes. Avoid assigning a file
with actively changing unrelated user edits; a filename list alone cannot recover
those edits. Coordinate a safe baseline or work on an independent scope instead.

Tell the worker what state it should see. With a shared workspace, uncommitted
changes are visible and must be preserved. With a Git worktree made from HEAD,
uncommitted changes from the parent are NOT present. Inspect the resulting files;
do not rely on a statement that contracts were "shared."

Astra does not make overlapping changes while the worker owns paths. The worker
does not mutate shared planning/status files assigned to the coordinator. Give
its task report a unique output path. Do not conflate role instructions with
hard filesystem access controls: inherited host permissions remain authoritative.

## Optional: two genuinely independent writers

Parallelism is opt-in per plan. Use at most two Flash writers by default, and only
when their dependencies are satisfied, writable scopes do not overlap, and
separate workspaces are actually available. A separate agent thread alone does
not satisfy workspace isolation. Shared types, dependency manifests/lockfiles,
routes, migrations, generated outputs, and schema files are usually contention
points; serialize them.

For Git worktrees, Astra establishes a known base and records it PER TASK in the
plan/report, not via shared `git config`. Honor the project's Git permissions.
Do not silently commit a dirty base to make worktree creation convenient. Prepare
local dependencies through the project's approved setup, with test-only data and
no production credentials. A worker must not expand its permissions when setup
fails. Worktrees do not isolate processes, credentials, ports, or network access.

Review and integrate each result before a dependent task starts. Run combined
checks after integration; individually passing branches may conflict. Leave
worktrees/branches available for review unless their removal is authorized and
safe. Do not delete a dirty worktree or unmerged result automatically.

## Handoff, persistence, and correction

Give the task's complete brief and just the relevant shared context. Do not tell
a fresh worker "continue what we discussed" without supplying the decisions.
For a long run, let the child perform internal milestones and test/fix loops.
Require one concise completion report and keep verbose logs in the workspace.
Capture progress at meaningful resumable boundaries, not every tool call. Where a
host turn limit interrupts it, resume the same task with its checkpoint; do not
promise that any model or harness can run indefinitely.

Use native wait/message/continuation functions as actually exposed. Choose the
longest practical wait. Do not use repeated list/status calls as heartbeats, request
play-by-play updates, interrupt a healthy run, or duplicate its repository work.
A wait timeout alone is not a blocker. When a worker is genuinely blocked, Astra
resolves the contract or environment question and sends one targeted update. For
rejected work, batch all concrete findings and send one correction request to the
same child. Default to one correction cycle. Recheck only the affected behavior and
accepted dependencies; broaden further only for a material high-assurance risk.

## Git and production boundaries

No automatic commits, staging, branch merges, pushing, deployment, publishing,
or production migrations are included in this workflow. Execute such operations
only under the user's applicable authorization and after actual review. A build
request by itself is not a reason to edit global router settings mid-project.
