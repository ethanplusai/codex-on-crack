# Optional build records

Use a fresh task for a trial when possible. Before building, record the outcome
you want and a few concrete acceptance checks. Pick a lead in Codex and configure
workers separately. Keep plain and orchestrated runs distinguishable.

From this skill directory:

```sh
node scripts/trial.mjs start --dir /PATH/TO/PROJECT/.crack/trials --id feature-01 \
  --task "Build the requested feature" --mode orchestrated --category implementation \
  --lead-model EXACT_LEAD --worker-model EXACT_WORKER \
  --acceptance "Main flow works; persistence survives reload; relevant checks pass"
```

Optionally add `--lead-effort high` and repeat `--worker-effort high` in the
same order as worker models. Omitted efforts remain unknown; these labels do not
configure the models.

Then do the work with the normal orchestrator. Do not add extra planning phases
just to fill a trial form. At the end, ask the user whether the result was usable,
how much repair time it needed, and what mattered. Record their answer:

```sh
node scripts/trial.mjs finish --dir /PATH/TO/PROJECT/.crack/trials --id feature-01 \
  --quality usable --checks passed --rework-minutes 0 --notes "User tested the main flow"
node scripts/trial.mjs list --dir /PATH/TO/PROJECT/.crack/trials
node scripts/trial.mjs show --dir /PATH/TO/PROJECT/.crack/trials --id feature-01
```

Use `needs-fixes` or `unusable` when appropriate. `--checks` records reported
verification status, not proof from an automated test runner. Don't record a human
verdict before the human has tried the result. A plain run needs no worker model.
Use a new ID for each run; completed records cannot be silently rewritten.

Optional usage: at finish, pass `--root-session ID` and repeat `--session-log PATH`
for the explicitly chosen root and every descendant export. Only linked sessions
are counted; verify export completeness yourself. The tool does not search all
sessions, send logs anywhere, or retain their raw contents. Intended model labels
and observed metadata remain distinct. Client labels don't prove serving identity.

Missing usage stays unknown. Input, cached input (a subset), and output are
separate. Reused long sessions include unrelated history; whole-session totals
cannot be presented as isolated feature cost. Elapsed wall time includes pauses.
Account allowance is shared: if you note a before/after percentage, also note
other sessions and reset times. Do not convert token counts into allowance savings.

Build records can help you review your own results. Different features, user familiarity,
cache state, and subjective judgments prevent treating their simple comparison as
a controlled benchmark. Keep artifacts or test evidence with the project so later
you can revisit quality, not just the score.
