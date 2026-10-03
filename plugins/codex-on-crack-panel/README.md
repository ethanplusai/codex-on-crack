# Codex on Crack (optional interface)

A local build panel for registered codex-on-crack runs:

- **Overview** — phase → lead run → recorded workers and host requests, the
  selected run's state, timings, tokens, and a tool/lifecycle activity list.
- **Review** — a project inbox of visual questions, current material, and
  feedback you can submit without interrupting the agent. Explicit approval
  and change requests remain separate actions. A decision binds to the exact evidence revision.
- **Usage & routes** — recorded token/cache counters per run, elapsed versus
  API-active time, list-price equivalents (not bills), and each route's
  configured versus verified status.
- **Launch** — registered launch profiles, their gates, and a confirmation
  dialog. Off unless you enable it.

It reuses the existing pieces: launch/resume/cancel go through
`skills/crack/scripts/lead.mjs` and its control channel; run state, activity,
and usage come from the replay bridge (`skills/crack/viewer/bridge.mjs`) and
reducer. Nothing scans for sessions and nothing calls a model unless you
confirm a launch.

This plugin is separate from `codex-on-crack` on purpose. Installing the main
plugin never starts this server; this one is listed as `AVAILABLE` in the
repository marketplace and only runs if you add it.

## Opening the panel

Ask **“Open the build panel.”** The panel skill calls the embedded `crack_panel`
MCP App first. The Codex on Crack entrypoint supports sidebar and thread
placement. The review tool opens the same surface. Host support
controls which surfaces appear. The core orchestration skill requests the view
once when starting a build if the panel is installed. This is not a global
new-chat startup hook, and opening the view does not register a run.

With no valid workspace, the first-run screen explains the workflow and offers
**Explore an example**. Where host messaging is available, **Connect this
project** previews a request before sending it to the conversation. A repaired
first-run configuration is picked up on refresh, without replacing any active
controller. An explicit example request can use `crack_panel({demo: true})`.
The example is labelled and cannot start paid work.

Version 0.3.0 adds phase navigation, a review shortcut, model handoffs, selected
run metrics, activity filters, and responsive light/dark views. Browser and
protocol validation do not establish that every Codex build exposes the same
entrypoints or refreshes an already-open view after a plugin update.

## Two ways to open it

| Surface | Command | Status |
| --- | --- | --- |
| Localhost fallback (any browser) | `node server/panel.mjs serve --config <panel.json>` | Implemented; browser-tested by the root reviewer |
| Demo (localhost) | `node server/panel.mjs serve --demo` | Implemented; generated data, permanently labelled |
| MCP App: “Codex on Crack” panel | via `.mcp.json` when the plugin is installed | Protocol-tested with the client SDK and `AppBridge`; installed 0.5.1 server checked. Host extensions depend on the client. |

Commands are relative to this directory. `server/` is a prebuilt,
self-contained bundle, so only Node 24.15+ is required. This folder holds only
runtime files because Codex copies a plugin folder verbatim into its cache;
sources, tests, and the pinned dependencies live in [`panel/`](../../panel) at
the repository root. From source, the same commands work with
`node panel/src/cli.mjs …` (the localhost fallback has no dependencies; `mcp`
needs `npm ci --prefix panel`).

### Localhost fallback

```sh
node server/panel.mjs check --config /absolute/panel.json   # validates; launches nothing
node server/panel.mjs serve --config /absolute/panel.json   # prints http://127.0.0.1:4327/#token=…
node server/panel.mjs serve --demo --port 0                 # demo on a free port
```

Open the full printed URL. The token travels in the URL fragment, is kept in
session storage, and is removed from the address bar. Stop with Ctrl+C.

### MCP App in Codex (opt-in)

In a scratch home first:

```sh
CODEX_HOME=/absolute/scratch-home codex plugin marketplace add /absolute/codex-on-crack
CODEX_HOME=/absolute/scratch-home codex plugin add codex-on-crack-panel@codex-on-crack
```

The server reads its configuration from `$CRACK_PANEL_CONFIG`, then
`$CODEX_HOME/crack/panel.json`, then `~/.codex/crack/panel.json` (read-only).
Whether the host forwards `CODEX_HOME` to plugin MCP servers is not verified;
with no configuration the panel says which path it looked at and offers the demo.

### Host integration

The MCP App uses only features from the official ext-apps and
`@openai/mcp-extensions` SDKs, and each one depends on what the host
advertises when the view connects. If the host doesn't advertise a feature,
the control isn't shown; the view never simulates a feature. The localhost
fallback has none of these features.

| Feature | What the panel does | Needs from the host |
| --- | --- | --- |
| Entrypoints | One **Codex on Crack** entrypoint supports global and thread placement. It accepts an optional registered `runId` or `reviewId`. The review tool can select a review in the same surface without advertising another entrypoint. An unknown id selects nothing, and the panel says so. | `openai/ui` entrypoints |
| Deep links | Accepts app-relative links only: `/`, `/overview`, `/review`, `/usage`, `/runs/<id>`, `/reviews/<id>`. A link selects a registered item. It never navigates away or starts an action, and other links are refused with a notice. | `openai/deepLink` in host context |
| Selection context | When you click a run or review, the panel shares bounded facts about it: id, label, state, model or gate, timing, and counts. It never shares transcripts, activity, logs, run errors, evidence, hashes, or paths. Opening the panel or following a link shares nothing. | `openai/modelContext`, or standard `updateModelContext` with text |
| Discuss in chat… | Shows the exact one-line message for the selected run or review. The message is sent as you only when you confirm, and is never sent automatically. | `openai/message`, or standard `message` with text |
| Display mode | **Full screen** / **Exit full screen**, shown only when the host reports the current mode and offers the other. | `displayMode` + `availableDisplayModes` |
| Theme | Host theme, style variables, fonts, safe-area insets, and the interaction cursor. Inline mode does not claim the viewport height. | host context `theme` / `styles` |
| Settings | View preferences only: **Default view** and **Show completed runs**. They are stored in `stateDir/preferences.json` and can be saved only once a configuration is loaded. Launching, approvals, models, routes, and roots are never settings. | `openai/settings` |
| Mentions | `@` search over registered runs and reviews by id or label, at most 8 results. A mention resolves to the same bounded facts as selection context, and the search never reads the filesystem. | composer mentions (`search_mentions`) |

## Configuration (`panel.json`)

Everything the panel can read is named here. Paths are absolute and must
resolve, after following symlinks, inside a registered workspace (except
`stateDir`, which the panel owns).

```json
{
  "schemaVersion": 1,
  "stateDir": "/abs/project/.crack/panel",
  "workspaces": [{ "id": "app", "root": "/abs/project", "label": "My app" }],
  "runs": [{ "id": "lead-1", "dir": "/abs/project/.local/runs/lead-1", "label": "Design lead" }],
  "routes": {
    "host": { "label": "Codex host", "model": "gpt-6-astra", "route": "host" },
    "worker": { "label": "Builder", "model": "deepseek/deepseek-v4.1-flash", "route": "router" }
  },
  "reviews": [{
    "id": "design", "title": "Dashboard layout", "gate": "early-design",
    "reference": "/abs/project/design/reference.png",
    "actual": "/abs/project/design/actual.png",
    "checks": ["Cards share one row", "Primary action uses the accent"]
  }],
  "launch": {
    "enabled": false,
    "profiles": [{
      "id": "impl", "label": "Implementation lead", "workspace": "app",
      "request": "/abs/project/.local/request.json", "prompt": "/abs/project/.local/prompt.txt",
      "resumePrompt": "/abs/project/.local/corrections.txt",
      "runsDir": "/abs/project/.local/panel-runs", "mode": "solo", "toolProfile": "files",
      "requiresApproval": "design", "feedbackFrom": "design"
    }]
  }
}
```

- `runs` are **observed only**: the panel shows them but cannot cancel or
  resume them.
- A launch profile runs `lead.mjs run` with exactly the confirmed request and
  prompt bytes (validated with the adapter's own request validator), into a new
  directory under `runsDir`. The bytes that matched the confirmation hashes are
  copied into a new private `stateDir/inputs/<run>/` and the adapter reads those
  copies, so editing the registered files after confirming changes nothing.
- `requiresApproval` makes both **launch and resume** wait for that review's
  approval of its **current** evidence (controller-enforced; the image bytes are
  hashed again at enforcement). A completed run cannot be resumed past evidence
  submitted or replaced after its approval. If corrections should run without
  that approval, register a separate profile without `requiresApproval`; there
  is no bypass flag.
- `feedbackFrom` appends the latest change request to the resume prompt; the
  composed prompt is snapshotted the same way.
- At most one run per profile is active. A lease file in
  `stateDir/leases/` is taken before any check and held until the child exits,
  so concurrent launches, a launch racing a resume, and several panel processes
  sharing one `stateDir` (localhost panel plus MCP server) cannot both start a
  run. A lease is reclaimed only when neither the panel process nor its child
  still exists (probed with signal 0); a live lease is never removed and no
  process is signalled because of a lease file.
- Keys such as `command`, `args`, `env`, or `pid` are rejected.
- `launch.claudeBin` exists only so tests can point at a mocked CLI.

## Security model

- **Loopback only.** The fallback binds `127.0.0.1`, needs the per-launch bearer
  token on every API call, accepts only a loopback `Host`, rejects a foreign
  `Origin`/`Sec-Fetch-Site`, and requires an explicit `POST` with
  `Content-Type: application/json`, a matching `Origin`, a ≤16 KB JSON object,
  and only the expected fields. Strict CSP, `frame-ancestors 'none'`, no-store.
- **Registered roots only, verified at read time.** Artifacts are addressed by
  review id and side, never by path. Every file the panel reads (evidence,
  registered request/prompt, and each run file: `run.json`, `summary.json`,
  `resume-delta.json`, the event streams) goes through one reader: open with
  `O_NOFOLLOW|O_NONBLOCK`, then check through the descriptor that it is a
  regular file within its size limit and still the inode its registered
  canonical path names, and read the bytes from that descriptor. A run
  directory swapped for a symlink (even one inside the root), a symlinked,
  oversized, or FIFO run file marks the run **Unreadable** instead of being
  followed. The replay bridge never opens run files itself: it runs over a
  private copy of the verified bytes. State files (`reviews.jsonl`,
  `launches.jsonl`, leases, inputs) are never read or appended through a
  symlink or a hard link. Only PNG, JPEG, GIF, and WebP identified by content
  are served (no SVG).
- **Approvals bind to the bytes shown.** The snapshot carries each image's
  hash; the view fetches images pinned to that hash (a changed file returns
  `409 stale_evidence`), and a decision must echo the evidence hash, which is
  recomputed from freshly read bytes when the decision is recorded. Display
  caching keys on device, inode, size, mtime, and ctime, so an in-place rewrite
  with a restored mtime is still seen.
- **No commands, no PIDs.** The browser and the MCP App can only name a
  registered profile or a run id. Cancel works only for a child this panel
  process spawned, through the adapter's authenticated control channel (with a
  `SIGINT` to its own child as fallback); observed runs are never signalled.
- **No secrets in the UI.** The snapshot is an allowlist: labels, codes,
  counters, and the replay's redacted activity text. Prompts, transcripts,
  tool arguments, `pid.json`, control tokens, and paths are never returned.
- **Decisions record a channel, not a person.** `local-ui` means a local client
  presented the per-launch bearer token with a same-origin request; `mcp-app`
  means the host forwarded an app-only tool call with a per-view nonce (it
  relies on the host enforcing app-only visibility, so it is labelled
  *host-recorded*). Neither is cryptographic proof that a human clicked. The
  token authenticates a local client and is **not a security boundary against
  another process running as the same OS user**, which can read the token from
  the terminal output or log. Model-visible tools can read status and submit
  evidence (which makes earlier approvals stale); none can record a decision.
- **Host features are user-initiated and bounded.** Selection context is sent
  only on your click. A message is sent only after you confirm its exact text.
  Labels are cleaned to one line of at most 80 characters and framed as data,
  not instructions. Neither feature can decide, launch, resume, or cancel.
  View preferences are written like the other state files: an exclusive
  private temporary file is renamed into place, and the preferences file is
  never read through a symlink. Unknown keys and values are refused.
- **Demo is separate.** `--demo` uses generated data in its own temporary state,
  `provenance: demo`, a `demo-ui` decision channel, and cannot launch, resume,
  or cancel.

## Usage semantics

Per-run cumulative session totals from the bridge (a resumed session replaces
its earlier total; never summed). Elapsed is wall clock; “active” is the CLI's
reported API time. Missing counters render as unknown. Subscription list-price
equivalents are labelled as not bills; quota is never inferred from tokens.

## Development

From the repository root:

```sh
npm ci --prefix panel        # pinned: @modelcontextprotocol/sdk 1.31.0, ext-apps 1.7.5,
                             # @openai/mcp-extensions 0.1.0, zod 4.4.3; esbuild, jsdom (dev)
npm run build --prefix panel # regenerates plugins/codex-on-crack-panel/server deterministically
npm test --prefix panel      # controller, HTTP, MCP (client SDK), host (AppBridge), UI (jsdom), build freshness
```

The repository's `npm test` includes these; SDK, UI, and freshness checks skip
when `panel/node_modules` is absent.

`ext-apps` stays on 1.7.x because `@openai/mcp-extensions@0.1.0` requires it;
2.x moves to the split v2 server packages.

## Known limits

- The 0.5.1 installed server passed SDK checks. Host extensions depend on the
  connected client; see [troubleshooting](../../docs/TROUBLESHOOTING.md).
- SDK 1.31 `McpServer` does not emit tool-level icons, so entrypoints fall back
  to the server icon advertised in `initialize`.
- App-view decisions rely on the host honouring app-only tool visibility.
- The host integration features above were protocol-tested against the
  official `AppBridge` in memory, not in a real host. Which of them a given
  Codex build advertises, and what form its deep-link URLs take, is not yet
  recorded.
- The SDK registers `settings.read` and `settings.update` without app-only
  visibility, so the assistant can see them. They hold only view preferences.
- Lifecycle ownership is per process: a run launched from the localhost panel
  is observed (not cancellable) from the MCP server process, and vice versa.
- Native worker dispatch is a Codex host action; the panel lists the request
  and never executes it.

## Capture and offline replay

The runtime also provides `record`, `checkpoint`, and `export` commands. Use
`node server/panel.mjs record --out NEW_DIRECTORY --config PANEL_CONFIG --details`
to sample registered runs and evidence. Add `--sources SOURCES_JSON` to register
this host's and native workers' exact JSONL session paths. The sources object
accepts `sessions` (absolute log paths), `runs` (absolute adapter run directories),
and optional `root` (session id). Update it as workers start. No global scanning
or model calls are performed. Keep the process alive until evidence is complete.

Append supplied observations with `checkpoint --recording DIRECTORY --file JSON`;
the object needs `kind` (plan, milestone, quality, usage, allowance, context or
interruption) and `label`. Stop capture with Ctrl-C. Then use
`export --recording DIRECTORY --out NEW_EXPORT_DIRECTORY` to create an offline
HTML replay. Default exports replace free text and omit screenshots and detailed
checkpoints. `--details --images` explicitly includes them for a private demo.
Review before sharing. Captures are private, read-only observations, not videos;
missing usage stays unknown and overlapping counters must not be summed.

See the source repository's [recording guide](../../docs/RECORDING.md) for the
fresh-session workflow, allowance checkpoints, coverage limits and commands.

## Show the host session immediately

Before research or delegation, connect the exact current session log:

```sh
node server/panel.mjs connect --session /absolute/current-session.jsonl \
  --workspace /absolute/project --label "Project host"
```

Add `--details` to show available local message and plan text. The default shows
generic messages and plan labels. The command validates workspace identity and
backs up existing configuration. It never scans account logs or starts models.
The `sessions` configuration array holds `id`, `file`, `workspace`, `label` and
optional `details`. Files must be canonical absolute regular JSONL paths.
Native workers are connected the same way. External adapter runs remain in
`runs`. MCP state polls refresh read-only source registrations while preserving
controller ownership and lifecycle permissions. A host between turns is labelled
accordingly, not marked as a completed project.

The activity view shows source-recorded messages, tool calls/completions, plan
updates, lifecycle and usage. Hidden reasoning and raw tool-output bodies are
excluded. Nested tool batches and their operations can both appear, so event
counts are observations, not a count of unique user actions. Registered native
sessions are automatically included by the recorder.

## One project, one review inbox

The project strip keeps all registered projects accessible. Each project groups
its host sessions, workers, run history and reviews. The main tool is the only
advertised panel entrypoint; review selection uses that same view. Codex owns
the desktop tab lifecycle, so this cannot close or merge old tabs already open
in the host. Reuse the main view when posting more questions.

Register a question from the host:

```sh
node server/panel.mjs ask --workspace /absolute/project --id logo-direction \
  --label "Logo direction" --question "Which silhouette should we develop?" \
  --file /absolute/project/design/logo-studies.png
```

Use one stable id for the question. `--file` is optional for a written question.
Existing questions can update their wording; changed wording invalidates earlier
responses. Submit revised images through the evidence tool to retain revisions.

The view displays the current material at a useful size, with any distinct
supporting reference collapsed. There is no comparison slider. **Send feedback**
saves a revision-bound response without sending a chat message or interrupting
a worker. It does not approve a gate. **Approval actions** are separate.

The agent reads current replies through `crack_panel_status` at natural work
checkpoints. Delivery is cooperative, not an immediate push or an automatic
resume. The inbox distinguishes waiting questions from saved feedback, and
retains prior replies in history. Drafts survive ordinary refreshes within the
open view, but unsent drafts are not durable across closing the tab.
