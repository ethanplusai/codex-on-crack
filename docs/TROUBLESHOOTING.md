# Troubleshooting

Commands below use `S=plugins/codex-on-crack/skills/crack/scripts` from this
repository. From an installed plugin, use its `skills/crack/scripts` folder.
Every script prints one JSON value; read `error`, `message`, and `hint`.

## The skills are missing

The installed core skills are `codex-on-crack:crack`,
`codex-on-crack:crack-plan`, and `codex-on-crack:crack-setup`. Earlier seven-skill
experiments are not part of this package. The optional panel separately exposes
`codex-on-crack-panel:crack-panel`. Use the namespaced name or ask in plain words.

To see exactly which skills a new session exposes to the model, run
`codex debug prompt-input` and look for `codex-on-crack:`.

Check that `codex plugin list` shows `codex-on-crack@codex-on-crack` as
`installed, enabled`. Fully quit and reopen the host app, then start a new
session. Check custom `CODEX_HOME` locations and your client's plugin support
before reinstalling.

## Nothing is configured, or doctor says `workflow-ready`

That is a complete state, not an error. Direct work can stay in the selected session
without worker roles; direct work needs no `crack.toml`, no builder, and
no global policy block. Run `$codex-on-crack:crack-setup` only when you want a
delegated builder. `doctor.mjs` reports workflow readiness and delegation
readiness separately, and only delegation is gated on configured roles.

If doctor reports `orphaned_agent_files`, generated role files exist without a
`crack.toml` to explain them. Re-run setup to regenerate them, or remove them if
you no longer want delegation.

## `node` is not found, or is too old

The scripts need Node.js 24.15 or newer on your PATH. The Codex App bundles its
own Node internally, but that copy is not on PATH. Install Node yourself; do not
let an installation assistant install or upgrade runtimes for you.

## `agents_absorbed_keys`

Your config.toml has keys under `[agents]` that do not belong there. A TOML
table header stays active until the next one, so a top-level key written after
`[agents]` is absorbed into it, and Codex refuses to load the whole config. The
error names the keys. Move them above the first table header (or under the
agent role they belong to), then check with `codex doctor`. codex-on-crack
never edits config.toml, and no assistant should edit it to make this check
pass.

## A model I expected is not eligible

`node $S/setup.mjs scan` lists every ineligible model with a `reason` and `why`:

- `not_subagent_capable`: the catalog does not mark it `multi_agent_version:
  "v2"`, which Codex requires for native subagents. Use your router's own
  documented selection controls, republish its catalog, and fully quit and
  reopen the app. Do not let an assistant run `subagents certify`,
  `test-model --live`, or another paid probe to force this, and never falsify
  certification records.
- `duplicate`: the model appears more than once in the catalog. Refresh the
  catalog with the tool that manages it.

A model missing entirely is not in the catalog Codex uses. That catalog is
`model_catalog_json` when your config sets it (codex-router does), and
otherwise the saved `--model-catalog` export, then Codex's own `models_cache.json`.

## Doctor reports `agent_file_stale`, `agent_file_missing`, or `agent_file_edited`

- **stale:** crack.toml, or the provider codex-router uses for a model, changed
  since setup. Run `$codex-on-crack:crack-setup` (or `setup.mjs apply`) to regenerate.
- **missing:** a generated file was deleted. Apply again.
- **edited:** you changed a generated file by hand. Move those edits into
  crack.toml, delete the file, and apply again. Setup refuses to overwrite it.

## `foreign_file`

A `crack_*.toml` agent file, or a crack.toml, exists that codex-on-crack did
not create. Rename or remove it, then retry. Setup never overwrites a file it
does not own.

## A role is unavailable in a new session

The client must support custom agent files and expose native delegation, and
files on disk do not prove the running client loaded them. Fully quit and
reopen the app, then check your client version and any project or managed
overrides. Do not fall back to a different model or an external agent CLI.

## `scope_violation` during integration

The worker changed files outside the task's `allowed_paths`. Nothing was
applied. Treat it as a review finding and send the task back for correction.
Do not widen the scope just to make integration pass.

## A worktree will not remove

`worktree.mjs remove` refuses unintegrated changes and ignored files. Preserve
those files outside the worktree and review/integrate intended changes before
retrying. `--force` is deliberately rejected. Integrated tracked changes are
removed only while the recorded patch is still present in the destination.
A branch with unmerged commits is kept and reported, never deleted.

## `dirty_baseline`

A new worktree starts at a commit and cannot see uncommitted dependency output.
Continue sequentially in the current workspace, or have the user establish a
checkpoint before creating worktrees. The helper never commits automatically.

## `provider_incompatible` or `role_conflict`

A model appearing in a catalog does not prove that the parent provider can serve
it. Select an already compatible parent profile; do not rewrite routing to
silence this check. An inline role definition may override the generated file.
Resolve that specific conflict deliberately. Always dispatch the exact configured
role: a default agent may use a different model.

## Legacy policy or setup lock

Preview `--migrate-legacy` to remove the old marked orchestration policy with a
receipt. It leaves legacy skills and roles intact. Global policy remains opt-in.
A setup lock means another apply/undo may be active. Wait for it to finish; only
recover a stale lock after confirming no setup process owns it.

## Undo refuses because a file changed

This protects edits made after setup, including edits to your personal
AGENTS.md. Preserve those edits, compare the receipt and its backups locally,
then reconcile deliberately. Do not publish receipts or instruction backups.

## No savings or quality guarantee

Real provider usage and task outcomes determine cost and quality. The offline
tests validate setup, planning, and integration helpers, not the performance of
any model. Request metadata is routing evidence; a worker's description of
itself is not.
