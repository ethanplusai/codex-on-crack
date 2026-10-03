# Use the workflow with OpenCode agents

The OpenCode adapter installs two native Markdown agents:

| Agent | Role | Model |
| --- | --- | --- |
| `astra-flash-orchestrator` | Primary: plan, dispatch and review | Your selected OpenCode model |
| `astra_flash_builder` | Subagent: implement, test and report | Explicit `--worker-model` |

The orchestrator calls OpenCode's native Task tool. No Codex installation,
Codex Router, TOML agent, Codex skill or experimental background-agent feature is
required. **The OpenCode desktop app is sufficient; installing the OpenCode CLI
separately is not required.** The original Codex installer remains available separately.

The package name describes the original workflow, not an OpenCode model ID.
Choose a capable primary model already available in your OpenCode setup. The
adapter does not assume an Astra endpoint exists or map Codex model aliases.
Use your available Flash model for the builder, or explicitly select another
implementation model. Existing benchmark results describe the Codex field run;
OpenCode savings and inference have not been measured by the offline tests.

## Desktop app only

The desktop app uses OpenCode's custom agent configuration. The Python installer
only writes agent files; it never launches an `opencode` executable. Its absence
from your terminal does not mean the desktop app cannot run these agents.

Two setup paths are available:

- **With Python 3.11+:** use the installer below from a terminal. Running a Python
  script does not require the OpenCode CLI. Choose the worker provider/model
  through the app's model picker or your existing provider configuration.
- **Without Python or a CLI:** have the desktop app create the two files from
  this repository's templates, or do the same with a text editor. Follow the
  file-only steps below.

For a local desktop project, put the files in that project's `.opencode/agents/`
directory, then reopen the project or restart the app. For all local projects,
use `~/.config/opencode/agents/`. If the app connects to a remote OpenCode server,
the files must be installed on that server in its project/configuration directory;
placing them only on your laptop does not configure the remote server. Likewise,
shell-only environment overrides may not be present in an app launched from a
desktop icon. A project installation avoids that ambiguity.

### File-only setup (no Python)

1. Copy `opencode/agents/astra-flash-orchestrator.md` from this repository into
   the destination agents directory, keeping its filename.
2. Copy `opencode/agents/astra_flash_builder.md` there as well.
3. In the builder file, replace `{{WORKER_MODEL}}` with the exact quoted OpenCode
   provider/model ID you chose. Use the identifier, not just its friendly display
   name, and do not assume the Codex Router spelling is valid.
4. Replace `{{WORKER_INSTRUCTIONS}}` with the full contents of this repository's
   `WORKER-INSTRUCTIONS.md`, changing references to `Astra` to `orchestrator`.
5. Confirm both placeholders are gone, preserve the YAML frontmatter, and reopen
   OpenCode. Select the `astra-flash-orchestrator` primary agent and your intended
   primary model. No changes to `opencode.json` are needed for normal selection.

Keep a copy of any existing same-named agent before replacing it. File-only
installation does not create the Python installer's undo receipt: to undo,
restore your saved files or remove only the two new agents.

To let the app perform those steps, open this repository in OpenCode, use its
normal Build agent, and send this prompt after filling in your destination and
worker model:

```text
Set up this repository's OpenCode agents for the local project at
<absolute project path>. My chosen worker is <exact provider/model ID>.

Read INSTALL-IN-OPENCODE.md and follow File-only setup. Create the two agent
files in that project's .opencode/agents directory, substituting the worker
model and shared worker instructions exactly as documented. Back up any
same-named files before replacing them. Preserve my provider configuration,
credentials, primary model and unrelated agents. Do not install or require
the OpenCode CLI or Python. Do not launch workers or make inference probes
to test routing. Report the written paths and how to select the primary agent.
```

Using the app's Build agent for setup is an ordinary model conversation and may
consume usage; the file operations themselves need no separate inference probe.
The editor-only route needs no model conversation.

## Python installer (desktop or CLI)

Requirements: Python 3.11+, OpenCode with native custom agents, and an already
configured provider with a tool-capable worker model. Configure authentication
through OpenCode's own provider setup; this installer never handles credentials.

Choose a worker from the providers/models available in the desktop app. Obtain
the exact `provider/model-id` from its model details or your existing provider
configuration; if your app only shows a friendly name, verify the identifier in
the provider's OpenCode configuration before installing. Do not guess a billing
provider or share credentials to identify it.

**Optional, only if you have the CLI:** from this repository folder you can list
the model identifiers with:

```sh
opencode models
```

Choose the exact `provider/model-id`. Provider identifiers and model
paths can differ from Codex Router routes; do not copy a route from the Codex
requirements table without checking it. `opencode models` lists model metadata,
not proof that authenticated inference succeeds. The installer itself invokes
neither OpenCode nor the network.

Replace `provider/model-id` below with your selected identifier. Preview first,
then apply:

```sh
python3 -B install_opencode.py --worker-model 'provider/model-id'
python3 -B install_opencode.py --worker-model 'provider/model-id' --apply
```

By default the agents go in `~/.config/opencode/agents/`. The installer respects
`XDG_CONFIG_HOME` and gives `OPENCODE_CONFIG_DIR` precedence when set. Use
`--config-dir /absolute/config/directory` for an explicit destination, or install
only for one repository:

```sh
python3 -B install_opencode.py --project /path/to/project --worker-model 'provider/model-id'
python3 -B install_opencode.py --project /path/to/project --worker-model 'provider/model-id' --apply
```

Project installs write into `<project>/.opencode/agents/`. Use the same destination
flags for previews, updates and undo. Do not copy the source agent templates
directly: the installer fills the worker model and shared worker instructions.

Only the two agent files and a backup receipt are written. Existing `opencode.json`,
`opencode.jsonc`, `AGENTS.md`, credentials and unrelated agents remain untouched.
The primary agent's Task permission allows only `astra_flash_builder`; the
builder denies Task delegation. These agent-specific rules affect delegation
when these agents are selected; other tool permissions are inherited. Agent
prompts and permission rules are not a filesystem or process sandbox.

## Use

Restart OpenCode, select your intended primary model, and select the
`astra-flash-orchestrator` primary agent using the agent switcher. Then give it
a feature request or an existing plan, for example:

```text
Implement the plan in docs/plan.md. Delegate one coherent implementation and
verification bundle to astra_flash_builder, then review the patch and evidence.
```

No `$astra-flash-orchestrator` skill invocation is needed. Selecting the builder
directly with an @ mention skips the primary planning/review workflow.

The primary sends a complete brief through `task`, using
`subagent_type: "astra_flash_builder"`. It retains the returned task/session ID
and uses `task_id` for a correction when supported. Normal foreground execution
requires no polling loop. One worker writes at a time in the shared workspace.

Before sending private work, check the effective model and agent settings in
your actual session, including project, custom-directory and managed overrides.
During the first authorized useful task, inspect the child-session provider/model
metadata where available. Neither generated configuration nor the worker saying
its name proves routing. Missing models or permissions are blockers; the workflow
must not silently substitute another provider. Installation never makes an
inference request or changes your selected primary model or reasoning settings.

## Update and undo

An update reuses the installed worker model when `--worker-model` is omitted:

```sh
python3 -B install_opencode.py --replace
python3 -B install_opencode.py --replace --apply
```

To change workers, explicitly pass `--worker-model` with `--replace`. Different
existing agent content requires `--replace`; all replaced files are backed up.
Updates keep unrelated files. Repeating an identical install makes no changes.

Use the exact receipt printed by the installer, with the original destination:

```sh
python3 -B install_opencode.py --undo /path/to/receipt.json
python3 -B install_opencode.py --undo /path/to/receipt.json --apply
```

Undo restores replaced agents or removes newly created ones. It refuses if a
managed file has changed since installation. Receipts live under the selected
configuration directory's `astra-flash-install-backups/`; keep them private and
out of version control. Undo leaves backup receipts and empty directories intact.
Undo multiple installations in reverse order.

## Validation and troubleshooting

```sh
python3 -B -m unittest discover -s tests -v
python3 -B scripts/release.py --check
```

The tests use temporary directories and no paid inference. They cover generated
agents, destination selection, previews, replacements, rollback and guarded undo.
They do not prove compatibility with every installed OpenCode version or provider.

If the agents do not appear, check the destination and restart OpenCode. If your
desktop version has a setting to show custom agents, enable it. If the builder
model fails, compare its `model` field with your app's provider/model details
(or `opencode models` if the CLI is available) and check provider authentication
locally. Inspect effective overrides when the runtime
differs from the generated files. Never use the Codex doctor to validate this
adapter; it checks a different host and routing format.

Official references: [agent configuration](https://opencode.ai/docs/agents/),
[config locations and precedence](https://opencode.ai/docs/config/),
[model identifiers](https://opencode.ai/docs/models/),
[CLI model listing](https://opencode.ai/docs/cli/), and the
[native Task implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts).
