# Optional parallel execution

Use only for independent tasks with explicit ownership and acceptance criteria.
For a dependency plan, validate it with `node scripts/validate-plan.mjs <plan.json>
--repo-root <repo>`. The default cap is one writer; increase it only when the
plan establishes independent work. Skip accepted tasks on resume. Do not rerun
completed waves just because the validator lists their structural order.

Each parallel writer needs an isolated worktree. `node scripts/worktree.mjs add
--repo <repo> --task <id>` requires a clean committed baseline. When user work,
new briefs, or accepted dependency changes are uncommitted, continue sequentially
in the current workspace. Do not auto-commit, discard changes, or ask a worker
to recreate missing prerequisites to evade the guard. A later parallel wave
also requires a valid baseline containing its prerequisites.

Give each child the full brief and actual dependency outputs. Readers may run
alongside writers only when their findings do not require a stable view of the
files those writers are editing. Shared test services and build outputs can
conflict even with disjoint source paths.

After root acceptance, preview integration:
`node scripts/worktree.mjs integrate --repo <repo> --task <id> --allowed <path>`.
Add `--apply` to apply the patch without a commit. Scope violations require a
correction; never enlarge the scope just to make integration pass.

Removal uses `node scripts/worktree.mjs remove --repo <repo> --task <id>`.
It refuses remaining ignored files, changed worker patches, and patches no
longer represented in the destination. No automatic forced cleanup of those
files is supported. Preserve work and leave the directory in place if unsure.
