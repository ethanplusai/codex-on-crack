# Optional external project lead

An optional mode for users who already have an official Claude Code subscription
login. The external lead plans work, writes assignment briefs, reviews evidence,
and proposes acceptance. It is not a replacement for the native workflow and it
is selected only for a user-requested Claude arrangement. Naming Opus 5.5
for delegated work is sufficient; the user need not name this adapter or their
subscription. Confirm the existing route and readiness, preserve scope and tool
permissions, and never infer access from a model name alone.

This is a local adapter, not a provider bridge. Three roles stay distinct:

- **Codex host** - the session you are in. Enforces workspace scope, permissions,
  and budget; performs native worker dispatch and desktop/browser actions with
  its own tools; records what actually happened.
- **External project lead** - the official Claude Code client running on the
  existing subscription login, on the exact model `claude-opus-5-5`.
- **Native worker** - the configured lead's native delegation target, unchanged.

Two modes are supported. In `external-lead` mode the lead plans, briefs, and
accepts while a native worker implements. In `solo` mode the external lead does
the implementation itself inside the permitted workspace and the Codex host only
performs explicitly scoped tool mediation (for example browser or desktop
actions) and records evidence. Solo mode rejects worker assignment.

The external lead has no Codex tools. It emits a structured request; the host
validates it and decides whether and how to act. Nothing in this adapter runs a
command that came from a lead-authored file.

## First use

Commands are relative to this skill directory (the directory that contains
`SKILL.md`). Nothing below spends anything except `run` and `resume`.

```sh
# 1. Non-spending readiness: dependencies and capabilities only.
node scripts/lead.mjs doctor

# 2. Validate a lead configuration without launching anything.
node scripts/lead.mjs config --file lead.json

# 3. Validate a lead request against the approved workspace, and see the host
#    action it implies. Nothing is executed.
node scripts/lead.mjs request --file request.json --workspace "$PWD"

# 4. Launch one approved lead session (private capture in runs/lead-1).
node scripts/lead.mjs run --request request.json --prompt prompt.txt --out runs/lead-1

# 4b. Or launch with the opt-in terminal profile so the lead can run its own
#     checks. This is an explicit per-run choice, never an implicit widening.
node scripts/lead.mjs run --request request.json --prompt prompt.txt --out runs/lead-1 --tool-profile terminal

# 5. Resume the same lead for results or corrections. The earlier mode, MCP
#    config, allowlist, required MCP tools, and budget reference are reused.
node scripts/lead.mjs resume --run runs/lead-1 --prompt corrections.txt --out runs/lead-2

# 5b. To widen a files-only run to terminal, say so explicitly and audit it.
node scripts/lead.mjs resume --run runs/lead-1 --prompt corrections.txt --out runs/lead-2 \
  --tool-profile terminal --authorize-profile-transition --reason "host authorized terminal execution"

# 6. Record host or worker evidence next to the run.
node scripts/lead.mjs record --run runs/lead-1 --type worker.result --file worker.json --request request.json

# 7. Stop a run this adapter owns. A stale or forged pid file reaches nothing.
node scripts/lead.mjs cancel --run runs/lead-1
```

`doctor` never claims verification. A missing CLI is `unavailable`; an
unobserved route, login, model, tool profile, or control channel is `unknown`
until a real, approved run reports it.

## Workspace scope

The host checks the request's `workspace` and any `paths` against the workspace
the user approved. The comparison is lexical first (so `/scope/../elsewhere`
never counts as inside `/scope`) and then canonical: the command-line tools
resolve the real path of each existing ancestor and re-attach the remaining
segments, so a symlink inside the scope cannot point outside it. A path that
does not exist yet inside the scope is still accepted.

These checks are **detection after execution, not a sandbox**. The official
client's file tools run in the host's process. A file call outside the workspace
is reported in `summary.json` and fails the run, but it is not prevented by this
adapter. Keep the workspace and the review boundary explicit.

## Tool profiles

Two profiles exist. The default is **`files`**: `Read`, `Write`, `Edit`, `Glob`,
`Grep`. The opt-in profile is **`terminal`**: the same file tools plus `Bash`,
so the lead can run and debug its own checks instead of asking the host to relay
every command.

```sh
node scripts/lead.mjs run ... --tool-profile terminal
```

Choosing the terminal profile changes only the tool list the adapter asks the
official client for. It does not relax anything else:

- No bypass flags. `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
  `--permission-mode`, `--bare`, `--add-dir`, and `--settings` are still refused.
- The run keeps `--restricted`, an empty `--setting-sources`, and `--strict-mcp-config`.
  Whether a `Bash` call needs approval stays with the official client's ordinary
  permission controls and the host environment; the adapter neither weakens nor
  simulates them.
- The exact model and subscription-route checks are unchanged, and there is still
  no API fallback.

**Allowlisting a tool is not filesystem isolation.** `Bash` can do anything the
host user can do. Terminal scope follows the approved workspace and task, and the
adapter does not parse or verify command text, so a command such as `cd .. && ls`
is not evaluated as an escape. File-tool path checks stay detection after
execution, and terminal calls are reported as "not statically path-checked" in
`summary.json`. Do not describe this profile as a sandbox.

`Bash` is a known, counted tool: it appears in `toolUses`, in
`terminalToolUses`, and must be exposed by the session, exactly like the file
tools. An unconfigured tool, a missing required tool, or a denied required tool
still fails the run.

### Changing the profile on a resume

A plain `resume` reuses the stored profile and never widens it. Widening a
files-only run to terminal requires both an explicit request and an explicit
authorization:

```sh
node scripts/lead.mjs resume --run runs/lead-1 --prompt corrections.txt --out runs/lead-2 \
  --tool-profile terminal --authorize-profile-transition --reason "why this was authorized"
```

Rules that hold:

- `--tool-profile terminal` without `--authorize-profile-transition` is refused
  (`profile_transition_required`) before anything launches.
- Only `files -> terminal` is supported. A downgrade, or any other change, is
  refused (`profile_transition_unsupported`).
- The previous run directory is never rewritten. The audit is written into the
  **new** run as `profile-transition.json` and a `profile.transition` replay
  event, and it records the previous run, invocation, session id, and the hashes
  of the previous summary and profile.
- The same Claude session is resumed, and the cumulative usage baseline still
  comes from the previous run's session totals, so the delta stays correct.
- A profile stored before this phase (no `toolProfile` field) is read as
  `files`, never as terminal.

## Request and result protocol

A request is JSON. Unknown keys are rejected, and keys such as `command`,
`shell`, `exec`, or `argv` are rejected outright: a request may describe work,
never carry an executable action.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `requestId`, `runId`, `phase`, `agentId`, `parentAgentId` | Stable identifiers; the run must reuse them |
| `kind` | `worker_assignment`, `host_validation`, `clarification`, or `final_acceptance` |
| `lead` | `{ id, model: "claude-opus-5-5", route: "subscription" }` |
| `objective` | What the lead wants done |
| `workspace` | Absolute path; must be inside the host-permitted workspace |
| `acceptanceChecks` | Non-empty list of checks the result must satisfy |
| `role` | Requested native role; required for worker assignment |
| `budget` | `{ authorized: true, usd: N }`; missing authorization fails closed |
| `paths` | Optional absolute paths, each inside the permitted workspace |

Each kind also requires its own payload:

- `worker_assignment`: `assignment` object with non-empty `role` and `brief`;
  use the same role as the top-level `role`. Optional `workspace` must equal
  the top-level workspace. Optional `acceptanceChecks` and
  `evidenceRequirements` describe the work. Example payload:
  `"assignment": {"role": "configured_builder", "brief": "Implement the scoped feature and run its required checks."}`.
- `host_validation`: non-empty `checks` array of descriptive strings. It may
  repeat `acceptanceChecks`; the host chooses the actual approved tool calls.
- `clarification`: non-empty `question` string.
- `final_acceptance`: non-empty `resultRef` pointing to the lead's evidence
  report. Proposing acceptance does not establish that every gate passed.

A host's initial `run` request can use `host_validation` with matching `checks`
and `acceptanceChecks` to describe the planning/readiness work. The prompt tells
an external lead which kind of request to write next. Always run `request` on
that output before acting; return validation problems to the same lead to fix
rather than silently repairing its request or bypassing the validator.

Solo mode (`--mode solo`) rejects `worker_assignment`.

`record` accepts two result shapes. A **lead** result is bound to the request and
must report the exact lead model on the subscription route. A **worker** result
carries its own agent id and any exact model id (a slash-qualified Router id such
as `deepseek/deepseek-v4.1-flash` is fine) plus its own usage provenance. Every
recorded event needs a `runId` and `agentId` either from `--request` or from
explicit flags; an unattributable event is refused.

## What a run keeps

Each run directory is created `0700` with `0600` files:

| File | Contents |
| --- | --- |
| `stdout.jsonl`, `stderr.log`, `received.jsonl` | Private raw capture; never shared |
| `pid.json` | Runner marker, invocation id, pid, process group, control files, token |
| `run.json` | The authorized profile: mode, model, tool profile, workspace, MCP config, allowlists, budget, ids, any profile transition |
| `summary.json` | Observed models, tools, usage provenance, errors, timings |
| `events.jsonl` | Uniform replay events, appended while the run is in flight |
| `events.public.jsonl` | Shareable projection: ids, status, counters; no transcript bodies |
| `resume-delta.json` | Delta and profile for a resumed session, when resumed |
| `profile-transition.json` | Audit of an authorized tool-profile widening, when one occurred |

The child environment is rebuilt, not inherited blindly: every
credential-shaped override (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CODE_API_KEY`, `DEEPSEEK_*`, `OPENAI_*`, and the rest of the configured
list) is removed, and the small/fast model is pinned to the requested model so
the observed-model check is exact. No token file is read and no credential is
copied. Subscription authentication stays inside the official client.

Events carry `runId`, `phase`, `parentAgentId`, `requestId`, `agentId`, and an
invocation id, plus requested and observed model, route, tool owner, and status.
Every event has a timestamp; when the stream supplies none the runner records
receive time and labels it `atSource: "receive-time"`. Tool calls get a terminal
event whether they succeeded or failed. MCP tools are compared against the exact
configured allowlist: an unconfigured exposed or called tool, a missing required
MCP tool, or a denied required tool fails the run.

## Usage accounting

The CLI's cost field is a list-price equivalent, not a charge. `summary.usage`
keeps the two apart:

- `billing: "not-billed-via-api"`, `equivalentUsd` from the CLI, `billedUsd: null`.
- `accountQuota: null` always; account quota is not observable here.
- Session totals are cumulative (`counterKind: "authoritative-total"`). A resume
  writes `authoritative-total-with-delta` and puts this invocation's increment in
  `resume-delta.json` (`counterKind: "delta-this-invocation"`) and in the session
  event's `data.delta`. Never add a delta to a cumulative total.
- Worker and host events carry their own `usage.route`, `billing`, `billedUsd`
  or `equivalentUsd`, and `costSource`.

There is no hard account-wide spend enforcement. Use host checkpoints and
provider-side budget controls; the adapter records what it actually used.

## Cancellation and fail-closed behaviour

A run reports `ok: false`, and the CLI exits non-zero, when any of these happen:
an observed model other than `claude-opus-5-5`, an unexpected route
(`apiKeySource` other than `none`), a missing result or `modelUsage`, a denied or
missing required tool, a tool call outside the workspace, a non-zero exit, a
deadline, or a host cancellation.

The adapter never substitutes a model or provider, never retries on a different
model, and never falls back to an API-billed route. Cancellation works only
through the owning runner: the runner publishes a heartbeat for its invocation
and polls a control file, and a cancellation must carry the per-run token from
the `0600` pid file. A completed run, a stale pid, a forged marker, or a wrong
token reaches nothing and is reported as completed, `no-live-runner`, or
`refused`. No process is ever signalled from a file, and only the runner's own
child process group is stopped.

## Limits

- Static checks cannot prove login state, serving identity, tool exposure, or
  subscription quota; only a real approved run can.
- Workspace checks are detection after execution, not sandbox enforcement.
- `--tool-profile terminal` allowlists `Bash`; that is not filesystem isolation
  and it does not replace the official client's permission controls.
- Desktop and browser control is a host action. This adapter does not verify it
  and makes no claim about it.
- The `--safe-mode --setting-sources "" --strict-mcp-config` profile is a
  configuration boundary, not filesystem isolation.
