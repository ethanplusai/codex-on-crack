---
name: crack
description: Lead substantial Codex builds with one configured implementation worker and lead acceptance. Use when the user requests codex-on-crack, names a model to delegate work to, asks to run subagents through Claude, or requests a lead/worker split. Keep host-only work direct; honor explicit external model choices. Workers must not invoke this orchestrator.
---

# Scope, delegate, accept

Keep the user's selected lead model, effort, permissions, and provider. This
skill does not change the composer model. Native workers must be configured
and available through the host's actual delegation tools. Claude sessions use
the explicit adapter below. No hidden model substitution, provider setup,
unapproved coding CLI, or automatic council of reviewers.

## Resolve the user's model request

The user names a model and a job, not an execution backend. Honor existing
route preferences. For native models, use configured roles and actual host
availability. For an explicit Opus 5.5 request, including “run subagents through
Opus 5.5”, read [the external lead reference](references/external-lead.md) and
check that adapter's readiness before rejecting it as a missing native role.
The user does not need to say “Claude subscription” or “external lead”.

Use the adapter's `solo` mode when Opus does the implementation, and
`external-lead` when it plans and reviews work assigned to a native worker.
An explicit model request authorizes that choice within the task's existing
scope and budget; it does not authorize new account setup, an ambiguous billing
route, or broader tool permissions. If multiple configured routes match and no
preference resolves them, ask which route. If unavailable, report the exact gap.
Do not invent support for another Claude model or silently substitute one.

Describe the resolved arrangement briefly, then proceed under existing
approval. External Claude sessions are not native Codex child agents; use the
adapter's lifecycle and usage records. Do not imply the composer changed or
that Claude inherited Codex tools.

## Prepare one useful bundle

Reuse the user's existing requirements and plans. Establish the outcome,
acceptance checks, consequential design choices, and permitted scope. A short
brief usually suffices. The lead owns architecture, material risk, and final
acceptance; the worker owns in-scope discovery, implementation, tests, debugging,
and verification with its available tools. Handle host-only work directly;
explicit external model choices still use their resolved route.

For native delegation, run `node scripts/doctor.mjs` using the session's home/profile.
It is a static check, not proof of serving identity. Reuse unchanged verified
setup evidence. If roles need configuration, use `$codex-on-crack:crack-setup`.
Do not fall back to an arbitrary default agent when readiness fails.

## Choose a configured worker

Honor an explicitly selected role/model. With several approved roles, use
`node scripts/select.mjs --task implementation` (or `ui`, `review`, `research`,
`tests`); add `--role NAME`, `--vision`, or `--min-context N` when appropriate.
Read [model selection](references/model-selection.md) for selection semantics.
The selector explains capability filters and user-declared task preferences; it
does not know which model is universally best. Resolve `needs-choice` with the
user rather than inventing a ranking. Never silently change the lead or effort.

Dispatch the selected exact native role with a compact brief: objective,
acceptance, non-goals, workspace, existing edits, allowed paths, necessary
interfaces, verification, and stop conditions. Include only needed context.
One writer is the default. A named role does not create a worktree or an extra
sandbox. Use the host's actual tool schema; don't invent delegation commands.

## Let the worker finish; review once

Use native completion/wait mechanisms. Do not poll a healthy worker, duplicate
its discovery, or edit its owned files. Continue only independent useful work.
On completion, close/mark the child done as the host requires.

Review the actual changes, including untracked files, against the pre-dispatch
workspace and acceptance. Check specification and quality/security together.
Reuse trustworthy test evidence; independently verify concrete gaps or risks.
Send one consolidated correction request to the same worker when needed. If a
correction fails, diagnose the contract, environment, or capability before
spending again. A configured fallback still needs user-authorized model/provider
scope and an explained reason; it is never an automatic retry loop.

Report what works, the validation, unresolved limits, and observed routing.
Do not auto-commit, push, publish, or change production. Keep checkpoints only at
meaningful resumable boundaries; [the optional template](templates/checkpoint.md)
is available for long work. Planning and parallel-work helpers remain optional.

## Record build outcomes only when requested

Use [build records](references/build-records.md) for `scripts/trial.mjs`.
Ask the user to judge usability and rework; don't fill in their verdict for them.
Keep intended model choices separate from observed session metadata. Missing
usage is unknown. Never infer allowance savings from raw tokens or task counts.

## Optional external project lead

When the user explicitly chooses Opus 5.5 or Claude Code for delegated work,
read [the external lead reference](references/external-lead.md). Use the existing
official subscription login; do not activate this route for unrelated requests:
the host validates a structured request, keeps the selected Codex lead
unchanged, and never executes lead-authored commands or signals a pid file. In
`external-lead` mode the lead plans and accepts while a native worker implements;
in `solo` mode the lead implements and the host only mediates scoped tools. Keep
small host-only work direct. An explicit request for Opus implementation uses
the adapter even though its mode is called `solo`.

To watch a host session, worker sessions, and external-lead runs in one local
view, read [the replay reference](references/replay.md).


## Keep the build visible

At the start of an orchestration workflow, if the optional panel plugin is
available and the user has not declined a visual view, call its `crack_panel`
tool once to open the embedded Codex on Crack view. Prefer that tool over launching a
localhost browser. Reuse an already open view. The host decides where it opens;
this is a workflow action, not a promise to open on every new chat.

Check the returned registration status. If this project or run is absent, say
so and follow the panel skill's configuration guidance under the user's scope.
Before substantial research or implementation, connect this host session using
its exact JSONL path and the panel skill's `connect` command. Use the current
thread id to locate only its matching filename; do not inspect unrelated logs.
Confirm that `crack_panel_status` includes the host session. Add each native
worker's exact session path and each external adapter run as it starts. If the
host log cannot be located, state that coverage gap rather than treating an
empty view as connected. Opening the view alone does not track this conversation.
Never fill a real run view with demo records. If the plugin is absent, keep
working and mention that the panel is an optional installation.

When the user asks to record the build or prepare a replay, load the optional
panel's skill and start its recorder before implementation. Register this host
session and each worker explicitly. Preserve baseline observations, milestones,
available usage and final quality evidence. Report missing coverage; neither
opening a panel nor dispatching a worker automatically captures every source.

For visual questions, follow the panel skill's asynchronous-feedback workflow.
Reuse the open view and stable question ids. At natural work checkpoints, read
current feedback via `crack_panel_status` and act on new replies within scope.
Do not interrupt healthy workers simply to deliver feedback, and do not treat
ordinary feedback as approval of a gated build.
