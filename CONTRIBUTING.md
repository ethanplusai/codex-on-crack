# Contributing

Focus on useful orchestration, reliable installation, and evidence of the result.
Preserve the user's selected host model, provider setup, permissions, and the
boundaries in [SECURITY.md](SECURITY.md).

## Development setup

Node.js 24.15 or newer is required. Core helpers use a vendored TOML parser;
the panel has pinned SDK and development dependencies. See [SOURCES.md](SOURCES.md).

```sh
npm ci --prefix panel
npm run build --prefix panel
node scripts/release.mjs
npm test
npm run test:legacy
node scripts/release.mjs --check
```

Regenerate the inventory after source changes and inspect its diff. The tests
check it, so stale hashes cause packaging tests to fail. Without the panel's
dependencies, some SDK/UI/build checks skip; that is not a full release check.

Tests use temporary homes, synthetic fixtures, and temporary Git repositories.
The plugin installation test uses a scratch `CODEX_HOME` and an installed
`codex` binary (`CODEX_BIN` can select it); it skips when no binary exists.
Never apply worker setup to your real profile to test a contribution, and never
add paid inference to automated tests or CI.

## Repository map

| Path | Purpose |
| --- | --- |
| `plugins/codex-on-crack/skills/` | Three core skills and their helpers, adapter, and replay viewer. |
| `panel/src/` | Panel controller, MCP server, and shared UI source. |
| `panel/test/` | Panel security, protocol, host-bridge, and UI tests. |
| `plugins/codex-on-crack-panel/` | Installable panel plugin and generated runtime. |
| `scripts/` | Product install/doctor/undo and inventory/archive helpers. |
| `tests/` | Core and packaging tests. |
| `docs/` | Installation and product usage guides. |

Edit panel source, then rebuild; do not hand-edit generated server bundles.
Add regression tests for behavior changes where they catch a meaningful failure.
Report the problem, resulting behavior, checks actually run, and remaining limits.
Separate real-client or provider evidence from mock/protocol tests.

Keep credentials, logs, local catalogs, receipts, backups, and personal settings
out of changes. Do not publish private implementation notes or repository history
as a side effect of preparing a release. New dependencies need compatible
licensing and attribution. Changes to docs alone need link/content and packaging
checks, not paid model runs.
