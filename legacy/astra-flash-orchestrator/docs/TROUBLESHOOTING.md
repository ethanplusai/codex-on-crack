# Troubleshooting

## The skill is missing

Check that installation ended with `Installed` or `Already installed`, not only a successful dry run. The expected file is `~/.agents/skills/astra-flash-orchestrator/SKILL.md`. Fully quit/reopen the host app, then start an Astra session. Check custom home locations and client skill discovery before reinstalling.

## Expected worker route is missing or different

The direct default is `deepseek/deepseek-v4.1-flash`. A new alternate-provider
install requires the exact documented `--worker-route`. An installed doctor or
later update reuses the valid generated routing binding automatically; a doctor
run from a fresh source checkout needs the option again. Establish the
Router/provider configuration using the Router's own documentation first. An
entry in a model catalog alone does not establish credentials or paid inference
access. The installer does not auto-detect or silently substitute a provider.

Enter API keys yourself through the Router's private local prompt; never paste
one into assistant chat. If the route is absent, stop package installation and
finish provider setup separately.

## Router URL is rejected

Only HTTP(S) loopback URLs are accepted. Supported paths are `/v1` and `/_codex-router/<capability>/v1`, optionally with a trailing slash. Remote endpoints, queries, fragments and embedded URL credentials are rejected. Do not post a private capability URL in an issue.

## Static doctor passes but live catalog check fails

The optional doctor request deliberately does not read authentication files or send credentials. A Router requiring authentication may reject `/models`; a stopped Router or network restriction may also cause failure. Normal Codex requests can use an authenticated route. Keep authentication enabled and use the Router's documented diagnostic tools. Report only redacted HTTP status/error categories.

## The offline HTTP fixture cannot bind a port

One test starts a temporary local HTTP server. A restrictive sandbox can block it. Run the offline suite in an environment that permits a loopback fixture through the normal approval mechanism. Do not disable security controls or skip the failed test and call the suite passing.

## Custom role is unavailable in a new session

The installed client must support standalone personal agent TOML files and expose native delegation. Files on disk do not prove the running tool supports them. Check your installed client and project/managed overrides. Do not fall back to a different model or external agent CLI.

## Existing skill or role conflicts

The installer refuses symlinked targets, duplicate skill locations and differing package-owned files. Review existing content before using `--replace`; keep the resulting receipt. Do not remove unrelated skills to resolve discovery.

## Undo refuses because a file changed

This protects later edits, including changes to the shared personal AGENTS file. Preserve those edits, compare the receipt and backup locally, then reconcile deliberately. Do not publish receipts or original instruction backups.

## No savings or quality guarantee

Provider usage and real task outcomes determine cost and quality. Offline tests validate installation and planning helpers, not the performance of either model. Request metadata is routing evidence; a worker's self-description is not.

## Flash is visible in the picker but unavailable for delegation

The merged catalog must advertise the exact selected route with
`multi_agent_version: "v2"`. A model entry or default-subagent setting alone is
insufficient. Use the installed Router's documented selection and catalog
publication controls, then fully quit/reopen the app. Do not let an installation
assistant run `subagents certify`, `test-model --live`, a smoke test or another
paid probe to make this check pass. Decide separately whether to spend provider
credit on certification yourself. Do not manually falsify certification records
or claim selection proves runtime capability.
