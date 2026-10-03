# Replay: registering sources explicitly

The viewer ships inside this skill at `viewer/`. It reads only the sources you
name on the command line and serves them on `127.0.0.1` behind a per-session
token. It never scans for sessions on its own.

## One view for host, worker, and external lead

```sh
VIEW=<this skill directory>/viewer

# External lead runs (a run directory, live or finished)
node "$VIEW/bridge.mjs" --run <run-dir> --out .local/replay
node "$VIEW/serve.mjs"  --run <run-dir> [--run <run-dir>]

# Codex host and native worker sessions (their own jsonl files)
node "$VIEW/serve.mjs" --session <host-session.jsonl> --session <worker-session.jsonl>

# One view with everything, so the relationship is visible at once
node "$VIEW/serve.mjs" --session <host-session.jsonl> --session <worker-session.jsonl> --run <run-dir>

# A previously exported normalized event file
node "$VIEW/serve.mjs" --events <normalized.jsonl>
```

`--root <agent-id>` selects the root when a session file is ambiguous; by
default the first `--session` file is the root, and descendants are included
through their recorded parent links.

## Where the session files come from

Codex records session jsonl per session; pass the files belonging to the host
turn and to each native worker explicitly. Do not paste a directory: the viewer
has no directory-scanning mode on purpose. If you do not know which files belong
to the turn, register the host session first, confirm it appears in the view,
then add each worker file in turn.

## What the public view shows, and what it never shows

Shown: agent role label (project lead / project lead · solo / worker), model
label, status, observed span from event timestamps, tool activity, plan step
counts, and recorded token/cache counters. The final activity line for each run
summarises the tool mix and the recorded usage, including a clearly labelled
list-price equivalent that is not a charge.

Never shown: transcripts, prompts, tool arguments or outputs, file paths, tool
ids, invocation/request/session ids, phases, or billing strings. Plan text is
replaced with generic labels by default. Add `--details` to opt in to local
plan, assignment, and commentary text from native sources. This can reveal
project information despite pattern redaction; review it before a demo. Use
the UI safe-export action for sharing, rather than sharing the live state.

## Usage semantics

- One session-scope record per model per run, from the authoritative cumulative
  totals. Successive runs of the same Claude session replace the earlier total;
  they are never summed.
- A different Claude session is a different agent, so two sessions can never
  overwrite each other's totals.
- Per-invocation deltas stay in the local `usage-summary.json` (and in the run's
  own `resume-delta.json`).
- Missing counters stay missing: the view says so instead of inventing zeros.
- Account quota is not observable here, and no allowance or savings claim is
  made.

## Offline and live

Replay works the same offline (from the exported bundle) and live: a run that is
still in flight shows a provisional state, and the view refreshes as the source
files grow. `bridge.mjs --out <dir>` writes `replay.jsonl`, `replay.json`, and
`usage-summary.json`; the bundle is redacted and safe to import into the UI or
share.
