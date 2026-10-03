# <Task ID>: <Reviewable deliverable>

## Assignment
Role agent: crack_<role> (rung: primary | fallback)
Phase: <phase ID>
Workspace: <exact path you verified: the main workspace, or .crack/worktrees/<task ID>>
Baseline: <branch/commit plus pre-existing changes; a worktree does not contain uncommitted main-workspace changes>
Dependencies: <accepted task IDs and the concrete outputs present in this workspace>
Report path: <unique task-owned path>

## Goal and non-goals
<The whole coherent bundle, not one microscopic step.>

## Done when
- <Observable behavior and its acceptance ID.>
- <Relevant failure boundary or state/ownership invariant.>
- <Required verification evidence.>

## Context and exact contracts
<Reference existing requirements rather than copying a transcript. Include only
the relevant repository patterns, types, error cases, and interface
signatures. For a cheaper model: exact paths and signatures, a short example of
the expected shape, and the neighboring file to imitate.>

## Lessons that apply
<Rules copied from .crack/lessons.md, or "none".>

## Files and ownership
May change: <exactly this task's allowed_paths.>
Must not change: <other tasks' scopes and unrelated user work.>
Default exclusions: secrets and .env files, production config, undeclared
dependencies or lockfiles, CI, unrelated migrations, router or Codex
configuration, and .git internals.

## Implementation freedom
<Internal decisions left to the worker.>

## Verification
Working directory: <path>
Commands and expected results:
- `<actual command>` -> <expected result>
Required test cases: <happy, negative, and boundary cases.>
UI or runtime checks: <observable states, or why not applicable.>
If a check fails, reproduce it, diagnose the cause, and verify the in-scope fix.

## Stop rules
Continue the in-scope test/code/fix loop on your own. Report missing contracts,
unsafe conflicts, an unavailable environment, or repeated failures instead of
inventing requirements. No nested agents or CLIs, no permission changes, and no
commits, merges, or deploys.

## Escalation context
<Fallback rung only: the failed attempt's report and the review findings,
verbatim. Delete this section for a primary rung.>

## Required return
Use task-report.md: STATUS (ready_for_review, blocked, or failed), the actual
commands and exit codes, changed files including untracked files, acceptance
criterion -> implementation -> evidence locations, unresolved risks, and a resume
checkpoint. Keep full logs in task-owned files; surface failures and missing checks. Only the orchestrator accepts a task.
