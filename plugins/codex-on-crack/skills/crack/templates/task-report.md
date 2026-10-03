# <Task ID> report
STATUS: <ready_for_review | blocked | failed>
Role agent and rung: <crack_<role>, primary | fallback>
Workspace and baseline: <actual path and baseline>
Thread ID: <host-observed ID, if available>

## Changes
<Changed paths including untracked files, and behavior. List pre-existing changes separately.>

## Acceptance evidence
<For each acceptance criterion: implementation location, check/evidence location,
and observed result or explicitly missing evidence. This map guides review; it
is not self-approval. Include relevant failure/state-transition checks.>

## Verification evidence
<Each actual command, working directory, exit code, result, and log location.
Keep full logs on disk; summarize repeated passes and include failing assertions
with enough context to diagnose them.>

## Remaining risks or decisions
<Missing checks, limitations, and blockers. Never claim acceptance.>

## Resume checkpoint
<Completed steps, unfinished work, the last failure, and the exact next action.>

---
# Review record (reviewer role, then orchestrator)
Spec compliance: <pass | changes requested | blocked, with evidence>
Quality and security: <pass | changes requested | blocked, with evidence>
Orchestrator spot checks: <actual commands, or visual/runtime checks>
Routing evidence: <host or router metadata, never the worker's own claim>
Decision: <accepted | changes requested | escalated | blocked>
Review cycles on this rung: <count>
Integration status: <what is present in the dependent workspace>
