# Security and privacy

codex-on-crack installs agent guidance, role agent files, and a few scripts.
Guidance, file scopes, and git worktrees are not operating-system security
boundaries. Your existing sandbox, approval, and repository restrictions
continue to apply.

The three core skills guide the agent, which can edit project files through its
existing tools within the user’s authorization. The optional panel has a separate
skill and server. The bundled scripts have the filesystem effects listed below.

## What the scripts may write

- `$CODEX_HOME/crack/crack.toml`, `$CODEX_HOME/agents/crack_*.toml`, and their
  backups and receipts under `$CODEX_HOME/crack-backups/`.
- With explicit `--migrate-legacy`: removal of the old marker-delimited policy
  block, preserving its contents in the undo receipt. Legacy roles/skills remain.
- Only with your consent (`--policy`): a marker-delimited block in
  `$CODEX_HOME/AGENTS.md`, or in `AGENTS.override.md` when that file has content.
- `worktree.mjs` only: `<repo>/.crack/` and a `/.crack/` line in
  `.git/info/exclude`.

The setup scripts never write `config.toml`; a test enforces that every other target is
refused. They refuse to write through symlinks, refuse to overwrite files they
did not create or that you edited, and never commit, push, or deploy.

## The optional build panel

`plugins/codex-on-crack-panel` is opt-in and separate from the main plugin. It
reads only the workspaces, run directories, and images its `panel.json` names,
resolving real paths inside registered roots and re-verifying each file through
its open descriptor (no symlinks, size limits, regular files only). It writes
only its own state directory (review records, launch history, profile leases,
and copies of the exact confirmed launch/resume inputs) and, when you enable
launching and confirm a launch, a new run directory through `lead.mjs`. The
localhost panel binds `127.0.0.1` behind a per-launch token with Host/Origin
checks and JSON-only mutations. That token authenticates a local client, not a
person, and is not a boundary against other processes running as your OS user;
recorded decisions name the channel they arrived by, not who clicked. It never accepts a command, path,
or process id from the browser, never signals a process it did not start, and
never returns prompts, transcripts, control tokens, or paths. Inside a host, it
shares bounded facts about a run or review only when you click it, and it sends
a chat message only after you confirm the exact text. Its host settings are view
preferences stored in its own state directory. See its
[README](plugins/codex-on-crack-panel/README.md#security-model).

## Static setup boundaries

- Setup, doctor, selection, and local trial recording do not call models. The
  external Claude runner explicitly launches the official client, which uses
  the authorized subscription route; real delegated work uses its provider.
- Run `subagents certify`, `test-model --live`, a router smoke test, or any
  other paid probe. Delegated tasks later send their selected context and tool
  output to the configured provider; get the right authorization for private
  repositories, and minimize shared context.
- Echo config contents, credentials, or private router URLs. Parser errors and
  unexpected errors are reported without quoting source text.

The Codex plugin manager can register marketplace/plugin settings separately.
Role instructions and model catalog entries do not prove actual routing. Verify
client-recorded child metadata before using a role for private work.

Enter provider credentials only through your provider's private setup flow.
Never paste a provider key into assistant chat.

Never publish authentication files, API keys, private router capability URLs,
local model catalogs, receipts, instruction backups, or unredacted task and
provider logs. The synthetic credentials in this repository's tests are fake.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository when the
maintainer has enabled it. Otherwise, open a minimal issue asking for a private
contact, without exploit details, secrets, or private logs. No response-time
guarantee is offered.

Useful reports include the plugin, client, and Node versions, the affected
behavior, and a synthetic reproduction. Keep security checks in place while
investigating: do not disable router authentication or approval controls to
make a test pass.
