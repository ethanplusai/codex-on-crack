# Planning without doing the implementation twice

## Process selection

A one-line correction does not need a design document, a task manifest, or a
worker. A bounded feature needs a short design, task brief, and review evidence.
An ambiguous application/rebuild needs discovery, a written spec, dependency
phases, and explicit integration checks. Scale the paperwork to the uncertainty.

For a request already developed with Superpowers or GSD, read its actual spec and
plan. Preserve terminology, requirements, and accepted decisions. Add a routing
and execution mapping, not a rival plan. This skill is self-contained and does
not depend on a command named `superpowers:planning`. Use installed skill names
as exposed by the host; do not pretend an absent skill ran.

## Astra's design work

Establish the user-visible result, out-of-scope work, constraints, current repo
patterns, and uncertain assumptions. Compare meaningful alternatives only where
there is a real decision. Settle data ownership, component boundaries, interface
signatures, error states, and backward compatibility. Define testable behavior
before delegation, including negative cases. For security-sensitive behavior,
Astra owns threat analysis and core correctness, not merely a final glance.

An already-authorized plan-and-build request does not need a second ceremonial
approval. Material unresolved product choices, destructive changes, external
publication, costs outside the approved provider/workflow, and production access
remain distinct decisions. Follow the current user and repository permissions.

## Phases and task bundles

A phase is an integration milestone. A task bundle is the work a single worker
can finish and Astra can independently accept or reject. Prefer one vertical,
end-to-end bundle per phase when the contract is stable. Split only for a genuine
dependency, ownership, risk, workspace, or independent acceptance boundary—not to
manufacture progress checkpoints. For example:

- Foundation: establish shared types and fixtures, including contract tests.
- Implementation: build a complete bounded behavior against those contracts.
- Integration: connect consumers, validate error states and system behavior.

These are examples, not mandatory layers for every project. Prefer vertical
working slices to disconnected scaffolding. A page with loading/error/empty
states and its tests can be one bundle; creating every file as a separate child
usually adds unnecessary orchestration.

Plan dependency edges explicitly. A task starts only after its prerequisites are
accepted and present in its actual workspace. Capture repository paths and sample
patterns from inspection rather than inventing them. Unknown future contracts
remain unresolved tasks, not ready-to-dispatch briefs. Update the remaining plan
when evidence changes; don't send a stale brief because it was written first.

## A ready brief

Supply the expected behavior, non-goals, relevant context, exact interface shapes,
allowed paths, forbidden changes, test cases, verification commands, prerequisites,
completion report, and stop conditions. Include short examples or pseudocode when
a tricky contract needs them. Do not write all implementation code or dictate
every token; reserve implementation discretion for Flash inside the contract.

A long worker run should mean sustained execution of a clear assignment, not an
unbounded self-directed project. Require a checkpoint when interrupted or blocked,
and otherwise expect one completion report after the worker's internal test/fix and
routine UI-validation loop. Let the host's continuation facilities carry the same
assignment forward. Long context capacity is not a reason to send every file or
every past message.
