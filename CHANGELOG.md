# Changelog

## Unreleased: launch preparation

- Explain the transition from Astra Flash Orchestrator and add a scoped upgrade guide.
- Show a synthetic workspace walkthrough and visual feedback in the README.
- Remove personal project names from documentation and regression fixtures.
- Exclude agent context and raw capture paths from release archives.
- Preserve the original public package and OpenCode installers under `legacy/`.
- Require Node.js 24.15+ for the supported package and development environment.

## 2.2.2 / panel 0.5.1

- Workspace selection sits above Overview, Review, and Usage & routes.
- Review counts, run history, usage, launch profiles, and route verification
  follow the selected workspace; switching views preserves that selection.

## 2.2.2 / panel 0.5.0

- One project destination groups host sessions, run history and visual questions.
- A visual feedback inbox replaces side-by-side and slider comparison controls.
- Revision-bound feedback is saved without interrupting a session; explicit
  approval stays separate and agents read replies at natural work checkpoints.
- Stable question registration and live refresh avoid opening a new panel per run.

## 2.2.1 / panel 0.4.1

- Text-only Codex on Crack tab and header branding.
- Explicit host and native worker session connections, including planning,
  messages, tool activity, lifecycle and available usage before delegation.
- Read-only registration refresh preserves controller ownership and permissions.
- Source outages and partial logs remain visible; turns ending are not treated
  as finished projects. Native session sources join recordings automatically.


## Core 2.2.0 / panel 0.4.0

- Record registered build-panel snapshots, screenshot revisions and session
  events locally, with checkpoints for plans, quality, allowance and context.
- Export a standalone offline replay with playback, scrubbing, source events,
  and checkpoints. Free text and images are excluded by default.
- Keep historical experiments and session-specific notes outside the release tree.

## Core 2.1.2 / panel 0.3.0

- Add phase navigation, model handoffs, activity filters and first-run setup.
- Prefer the embedded panel when an orchestration workflow starts.
- Resolve explicit Opus requests through the existing configured Claude route.
