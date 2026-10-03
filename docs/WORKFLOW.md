# The thin workflow

Choose the lead in Codex. Configure one worker through `crack-setup`. Invoke
`$codex-on-crack:crack` on a meaningful feature you want built.

1. Lead establishes scope, acceptance, and consequential architecture decisions.
2. One worker owns discovery, implementation, tests, debugging, and routine UI QA
   inside that brief.
3. Lead reviews the actual patch and evidence together, requesting one consolidated
   correction when needed.
4. You review the result against the agreed acceptance checks.

The worker is not a separate worktree unless one is explicitly created. Preserve
existing edits and permissions. Small changes and explicitly solo requests stay
with the lead. No additional planning/design/debugging skill bundle is required.

If several workers are configured, a task mapping can express your preference;
capabilities and readiness constrain selection. Ambiguous choices remain choices.
Do not replace the lead, choose a new provider, or invent a fallback automatically.

## Working with an external project lead

If you already have an official Claude Code subscription login, the plugin can
run that client as an optional external project lead for planning, briefs,
review, and acceptance, or in `solo` mode for the implementation itself. The
Codex host stays in charge of scope, permissions, budget, native worker
dispatch, and desktop/browser actions.

Start at the skill directory and use the non-spending checks first:

```sh
cd plugins/codex-on-crack/skills/crack
node scripts/lead.mjs doctor
node scripts/lead.mjs config --file lead.json
node scripts/lead.mjs request --file request.json --workspace "$PWD"
```

Then launch, resume, record, or stop explicitly:

```sh
node scripts/lead.mjs run --request request.json --prompt prompt.txt --out runs/lead-1
node scripts/lead.mjs record --run runs/lead-1 --type worker.result --file worker.json --request request.json
node scripts/lead.mjs resume --run runs/lead-1 --prompt corrections.txt --out runs/lead-2
node scripts/lead.mjs cancel --run runs/lead-1
```

A lead request is data: the host validates it and performs any action itself. No
credentials are read or copied, there is no API fallback, and cancellation goes
through the owning runner rather than a pid file. The mode stays off unless you
invoke it. See the external lead reference in the `crack` skill for the full
protocol, workspace scope, usage accounting, and limits.
