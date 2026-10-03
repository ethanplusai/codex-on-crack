# Agent activity viewer

A local, read-only companion for orchestration tests. No dependencies beyond
Node.js 20+. Nothing is installed into Codex. No model calls, account changes,
telemetry, or transcript uploads. The app is local-only; no GitHub repo was created.

## Open the demo

```sh
cd plugins/codex-on-crack/skills/crack/viewer   # this package's copy
npm start
```

Open the full **Viewer** URL printed in the terminal, including its local access
fragment. The default is an explicitly labeled Sample replay. Select an agent,
inspect its steps, scrub, pause, or change playback speed. Stop with Ctrl+C.
Use `--port 4320` if another viewer occupies the default port.

## Watch an actual test

Use a fresh Codex task for the test. Pass its root session file and each child
session file you want to observe. Files are never searched automatically.

```sh
npm start -- --session /absolute/root.jsonl --session /absolute/child.jsonl \
  --since 2026-09-29T12:00:00Z --details
```

Replace the paths and timestamp; `--since` is optional. Restart with another
`--session` when a new child needs attaching. Existing emitted delegation may show
an unattached worker; its activity stays unknown until its log is attached. Root
identity defaults to the first file; `--root SESSION_ID` overrides it. Use actual
session IDs, not task titles. Include the ancestor files for grandchildren.

`--details` exposes reported plan labels and supported public commentary locally.
Without it the viewer uses generic labels. Prompts, private reasoning, raw tool
arguments and output bodies are excluded in both modes. Redaction of detailed text
is best effort: inspect the screen before recording. Observed model metadata is a
client label, not proof of which backend model served the request.

Native adapter coverage: session/parent metadata, turn starts/completions/abort,
model labels, direct tool names, direct `update_plan` calls, and delegation results.
Batched tools appear as “Tool batch”; nested commands are not executed or parsed.
Worker return is awaiting review; root completion is “Turn complete”. Lead
acceptance, verification success and undeclared plans cannot be inferred from raw
text or a successful tool call. Missing events remain missing. A Watching source
means the file is readable, not that the agent is alive. Observed span is first to
last observed activity, not active computation time. Historical sessions can
contain unrelated turns; use `--since` or start a fresh task.

## Explicit plans and review evidence

For tests needing a richer plan or acceptance markers, append explicit lifecycle
events to a separate local JSONL file. This requires no changes to Codex settings
or installation of a skill. Run these commands at real milestones, not on a timer.
Use actual session IDs when combining explicit events with native logs.

```sh
node src/emit.mjs --file .local/test.jsonl --agent lead --type agent.created \
  --data '{"title":"Build the test project"}'
node src/emit.mjs --file .local/test.jsonl --agent lead --type agent.started
node src/emit.mjs --file .local/test.jsonl --agent worker --parent lead \
  --type agent.created --data '{"title":"Implement the board"}'
node src/emit.mjs --file .local/test.jsonl --agent worker --parent lead \
  --type plan.updated --data '{"steps":[{"step":"Implement and test persistence","status":"in_progress"}]}'
npm start -- --events .local/test.jsonl --root lead --details
```

Then append `agent.returned`, `review.changes_requested`, `verification.reported`
(with `{"status":"passed"}` or `failed` / `not-run`), or `review.accepted` as those
facts occur. Do not let a worker self-approve. The emitter validates each event
and appends it with a unique ID and timestamp. The viewer sees it on the next poll.
`--events` and `--session` can be repeated and combined. These commands are opt-in
instrumentation, not yet automatic hooks in codex-on-crack.

Schema: `{schemaVersion:1,eventId,agentId,parentAgentId,at,type,data}`. Supported
types and plan validation are defined in `src/model.mjs`. Event history retains
plan revisions. One worker may own multiple turns; it keeps one identity.

## Recording and sharing

- Screen recording can show local detail; review it first.
- **Export safe replay** previews the transformation before downloading JSON.
  It replaces IDs/names, assignments, plan labels, model labels, and activity text
  with generic values. Timing, topology, statuses and verification flags remain.
- **Open replay** runs entirely in the browser; it does not upload the file.
  Sample exports stay labeled Sample. Imported captures are labeled Recorded.
- Replay speed uses event timestamp gaps, with a 60-second maximum wait between
  events for presentation; timestamps remain original. Use scrubbing for long gaps.
- Export does not prove quality or cost savings. Keep actual test artifacts,
  human verdicts and reconciled usage in the existing personal trial report.

## Validation

```sh
npm test
# Optional UI checks with an installed Playwright:
PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs VIEWER_URL='PRINTED_URL' node test/browser.mjs
```

Tests cover parentage, exclusions, time filtering, task-name aliases, return vs
acceptance, validation, privacy defaults, duplicate events, partial lines,
truncation/disconnection, API access checks, and live append. Browser checks cover
selection, correction/acceptance, safe export/import, HTML-as-text, mobile layout.

The server binds only to 127.0.0.1 and requires a random per-launch token for data.
It rejects foreign Host/Origin and all mutation HTTP methods. It has no arbitrary
file-read endpoint. It is a local developer tool, not a hosted multiuser service.
Log schemas are adapter-specific and can change. Missing/malformed source records
are counted, not treated as successful work. Logs must be newline-terminated;
unfinished lines remain pending. Very large imported replays are limited to 5 MB
and 20,000 events. Native live history is held in memory; use fresh test sessions.
