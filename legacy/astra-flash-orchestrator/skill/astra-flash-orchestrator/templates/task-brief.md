# <Task ID>: <Reviewable deliverable>

## Assignment
Executor: astra_flash_builder
Phase: <phase ID>
Workspace: <exact path verified by Astra>
Baseline: <branch/commit plus pre-existing changes, or explicit non-Git snapshot>
Dependencies: <accepted task IDs and the concrete outputs present here>
Report/checkpoint path: <unique task-owned path>

## Goal and non-goals
<Entire coherent bundle, not one microscopic step.>

## Done when
- <Observable behavior and its acceptance ID.>
- <Negative or boundary behavior.>
- <Specified verification evidence.>

## Context and exact contracts
<Only relevant repo patterns, types, error cases and interface signatures.>

## Files and ownership
May change: <literal files/directories, including this task's tests/report.>
Must not change: <other worker scopes and unrelated user work.>
Default exclusions: secrets/.env files, production config, undeclared dependencies
or lockfiles, CI, unrelated migrations, router/Codex configuration, and .git internals.
Explicit exceptions: <none, or the exact user-authorized exception.>

## Implementation freedom
<Important internal decisions left to the worker. Do not prewrite every function.>

## Verification
Working directory: <path>
Commands and expected results:
- `<actual command>` -> <expected result>
Required test cases: <precise happy, negative and boundary cases.>
UI/runtime checks: <observable states or why not applicable.>

## Budget, checkpoint and stop rules
<Run budget and meaningful milestones appropriate for this task; no invented universal duration.>
Continue the in-scope test/code/fix loop autonomously. Report missing contracts,
unsafe conflicts, unavailable environment or repeated failures instead of inventing
requirements. No nested agents/CLIs, no permission bypass, no commits/merges/deploys.

## Required return
Use task-report.md. Include actual commands/exits, changed files, unresolved risks
and the resume checkpoint. STATUS is ready_for_review, blocked, or failed; only
Astra can accept the task.
