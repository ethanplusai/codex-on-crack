# Install Codex on Crack

You need Node.js 24.15+, a Codex client with plugin support, and your own model
access. For external Opus sessions, install and authenticate the official Claude
Code client. Native workers require a compatible configured model route.

## Install the plugins

Keep this checkout in a stable folder. From its root:

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-on-crack@codex-on-crack
```

Add the optional activity and review panel:

```sh
codex plugin add codex-on-crack-panel@codex-on-crack
```

These commands register the local package in your Codex installation. They do not
make paid model requests or configure provider credentials. Start a fresh chat
after installing so the skills load.

## Choose models

Select your host model in the Codex composer. In a new chat, ask:

> Help me set up Codex on Crack. Check my configured models and routes,
> recommend a worker, and show me the setup changes before applying them.

Setup preserves the selected host, effort, provider configuration, credentials,
and unrelated roles. A compatible role in local metadata is not proof of a
successful request to that provider.

If you already use Astra Flash Orchestrator, follow the
[upgrade guide](docs/UPGRADING.md). Use one orchestration policy for a task;
setup does not silently replace a legacy policy.

## Start a project

> Help me plan this feature. Recommend who should do what, define acceptance
> checks, and agree on the plan with me before building.

Or request a supported arrangement directly:

> Run subagents through Opus 5.5.

To observe the build, ask to connect the workspace and its runs to the panel.
See [panel configuration](plugins/codex-on-crack-panel/README.md) and
[recording and replay](docs/RECORDING.md).

## Update

Update this checkout, then run the plugin installation commands again. Restart
the client when generated agent files change and start a fresh conversation.
Keep the checkout in place while the installation references it.

## Terminal setup

```sh
node plugins/codex-on-crack/skills/crack/scripts/setup.mjs scan
node plugins/codex-on-crack/skills/crack/scripts/setup.mjs plan --roles /absolute/path/to/draft.toml
node plugins/codex-on-crack/skills/crack/scripts/setup.mjs apply --roles /absolute/path/to/draft.toml
node plugins/codex-on-crack/skills/crack/scripts/doctor.mjs
```

Use `--profile` consistently if configuring a named profile. Generated roles and
configuration live under `$CODEX_HOME/agents/` and `$CODEX_HOME/crack/`;
setup receipts live under `$CODEX_HOME/crack-backups/`.

## Undo worker setup

```sh
node plugins/codex-on-crack/skills/crack/scripts/setup.mjs undo --receipt /absolute/path/to/receipt.json
node plugins/codex-on-crack/skills/crack/scripts/setup.mjs undo --receipt /absolute/path/to/receipt.json --apply
```

Undo previews first and refuses to overwrite later edits. Reverse newer
transactions before older ones. Keep receipts. Removing a plugin and undoing
worker setup are separate actions; plugin removal does not restore roles or
policy changes.
