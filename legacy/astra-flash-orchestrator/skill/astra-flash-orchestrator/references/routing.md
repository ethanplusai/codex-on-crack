# Native Codex routing

The installed setup has three separate jobs:

1. Codex selects the root and child models.
2. Codex Router forwards the selected child route to its pinned provider.
3. This skill tells Astra when to plan, delegate, review, and integrate.

As documented on September 20, 2026, the vendor API's `deepseek-flash` name
corresponds to V4.1 Flash. Codex Router exposes reviewed routes through DeepSeek,
OpenRouter, opencode Go, Command Code, Nous Research and Ollama Cloud. The
installed `routing.json` records the exact selected route and provider. Do not
substitute an upstream vendor name in the role's model field. See `sources.md`
for the public references.

## Installation bindings

The installer uses direct DeepSeek by default or the reviewed route explicitly
passed with `--worker-route`, then verifies that exact entry exists in the local
model catalog with `multi_agent_version: "v2"`. It never auto-selects a provider.
On later updates and doctor runs, a valid installed `routing.json` preserves that
choice when the option is omitted. It writes a standalone personal agent with the
name `astra_flash_builder` and pins both its route and the catalog's supported
default effort. It does not
require, inherit or change global `[agents].default_subagent_model` or
`[agents].default_subagent_reasoning_effort` values, so unrelated subagents keep
their existing defaults. It leaves root settings, provider URLs, credentials,
and config.toml untouched. Provider keys are entered by the user through the
Router's private local prompt, never through assistant chat.
The child inherits sandbox/approval settings; its `[agents].enabled = false`
prevents recursive subagent tools under the documented custom-agent format.

The public docs describe custom-agent files under `$CODEX_HOME/agents/`. A named
role can pin its own model and effort independently of global child defaults.
Choosing a different existing custom role may therefore change the model. In
particular, keep final review in the root Astra thread.

## Runtime check

Fully quit/reopen the host app, then start a session with Astra selected. Check the installed skill and role are
visible. Run `doctor.py` with the appropriate profile and CODEX_HOME. The optional
`--check-local-router` performs only a loopback `/models` GET, without a model
inference request, without ambient proxies, and without redirects. A successful
catalog check does not verify inference, billing, tools, or sustained execution.

Inspect the actual active session and project overrides. If your client doesn't
load the standalone role format or expose native subagent tools, stop delegation
and identify the incompatibility. Do not write legacy configuration keys based
on guesswork, silently upgrade software, or fall back to an expensive agent.

For the first real delegated task, verify all of the following:

- Root thread still shows Astra; child thread/session metadata shows the exact
  Flash route or an equivalent documented provider mapping.
- Router request/usage metadata confirms the selected provider and upstream model
  for that child request. Do not paste private caller URLs, tokens, or raw logs.
- The child actually executes a small useful task, changes only its scope, and
  returns test evidence; Astra reviews the result independently.

When metadata is unavailable, report that inference routing remains unverified.
A response saying "I am DeepSeek" is not evidence. A green router health check
alone is not an end-to-end test. Do not run `subagents certify`, `test-model
--live`, a smoke test or another paid probe during package installation; the
user's first approved useful build can establish runtime evidence.

## Usage and privacy

Delegation sends the selected task context and tool results to the provider pinned
by the installed worker route. Preserve provider-sharing restrictions on private
repositories; use minimal necessary context and avoid production data and secrets. A worktree
is not an operating-system sandbox. Do not disable approval or sandbox mechanisms
and do not inherit a bypass-permissions CLI from the old package.

Record observed usage only when available. A lighter Astra transcript can reduce
Astra's implementation work, but this package cannot promise a specific usage
reduction, price, latency, quality ranking, or maximum uninterrupted runtime.
