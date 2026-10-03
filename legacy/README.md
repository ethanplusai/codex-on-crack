# Original Astra Flash Orchestrator

This directory preserves the public 1.2.0 installer and skill package from commit
`68f8d34b7532be2623c804e97f53be337310cb35`, including OpenCode support,
original Codex installation, tests, license, and contributor attribution.
Installer, skill, and OpenCode agent behavior is preserved. Bundled sample
projects were removed; plan-validation tests now construct temporary fixtures.
Documentation and manifests were updated to match.

Run its commands from that directory, not the new repository root. Its Python
installer requires Python 3.11+. Do not apply both orchestration policies to
the same task. The root README describes the new Codex plugin workflow.

Historical benchmarks, development notes and sample projects are excluded.
