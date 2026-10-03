# Recording and replay

Record before implementation starts. Keep the original private; choose what to
share afterward. The recorder observes registered sources and makes no model
requests. Opening the panel alone does not start recording.

## Start recording

Ask:

> Use Codex on Crack for this project. Before building, set up the build panel
> and a private recording of this session and its workers. Capture the plan,
> handoffs, available usage, screenshot revisions, validation and my verdict.
> Tell me which sources or counters cannot be captured. Keep exports private.

The host should register the project and known run paths, start recording before
implementation, then add each new worker's exact log path as it becomes known.
Use checkpoints to mark significant steps. Do not search unrelated sessions.

## Capture commands

`PANEL` below is the installed panel plugin's `server/panel.mjs` entrypoint.
In a source checkout it is `plugins/codex-on-crack-panel/server/panel.mjs`.
Set `PANEL` to that absolute path. Requires Node 24.15 or newer.

Create a private sources file with only this build's absolute paths:

```json
{
  "sessions": ["/absolute/path/to/host-session.jsonl"],
  "runs": ["/absolute/path/to/claude-adapter-run"],
  "root": "host-session-id"
}
```

Native worker session logs belong in `sessions`. External adapter run directories
belong in `runs`. Omit unavailable sources instead of inventing them. The panel
configuration's registered runs are also included automatically. The recorder
rereads registrations each sample; update the sources file atomically as workers
start. It does not automatically discover every session or tool invocation.

```sh
mkdir -p .crack/recordings
node "$PANEL" record --out .crack/recordings/build-01 \
  --config /absolute/path/to/panel.json \
  --sources /absolute/path/to/sources.json --details
```

Run this in a terminal that remains alive during the build. Default sampling is
two seconds. `--interval 1000` changes it; `--once` is a diagnostic snapshot.
`--details` retains available plan and activity text locally, not raw transcripts.
Registered screenshot revisions are copied by content hash. Keep `.crack/` out
of version control. Raw captures include private paths and project information.

## Add a checkpoint

Save a JSON file describing a milestone:

```json
{
  "kind": "milestone",
  "label": "Implementation complete"
}
```

```sh
node "$PANEL" checkpoint --recording .crack/recordings/build-01 --file checkpoint.json
```

Supported checkpoint kinds are `plan`, `milestone`, `quality`, `usage`,
`allowance`, `context`, and `interruption`. Checkpoints are supplied observations;
the recorder does not independently verify their contents.

## Stop and export

Stop the recorder with Ctrl-C after final evidence is captured. An abrupt exit
leaves the capture marked `recording`; its existing frames remain exportable.
A completed recording does not mean the build succeeded.

```sh
node "$PANEL" export --recording .crack/recordings/build-01 --out .crack/replay-safe
```

Open the exported `index.html`. It is self-contained, works offline, and includes
play, pause, speed and position controls, historical panel states, registered
agent events and checkpoint history. It cannot launch agents or change reviews.
Checkpoints entered after capture ended appear at the final position.

Default exports replace free text and omit images and checkpoint payloads.
For a private, detailed demo:

```sh
node "$PANEL" export --recording .crack/recordings/build-01 \
  --out .crack/replay-private --details --images
```

Review every frame before sharing. Screenshots can contain private information.
Nothing is uploaded. Export directories must be new. Keep the raw capture so a
new export can be made later; the shareable export is not the master record.

## What the evidence supports

- Panel states, review decisions and screenshot revisions observed at sampling time.
- Registered agents' models, activity, plan steps and available token/cache counters.
- Source timestamps and observed durations, with capture gaps surfaced explicitly.
- Manually recorded account allowance, cost, quality and environmental observations.

Missing counters remain unknown. Per-subtask tokens are not inferred from an
agent total. Session events may include history from before recording started.
Panel and session totals can describe the same work: never add them together.
Source outages and malformed tails are recorded as gaps. Sampling can miss brief
intermediate states. This is a data replay, not a screen video.
