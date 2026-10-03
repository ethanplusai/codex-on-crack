# Astra Flash Orchestrator compatibility package

The original Codex and OpenCode installers remain available here. The new
Codex plugin is documented in the [root README](../../README.md).

Run legacy commands from this directory:

```sh
cd legacy/astra-flash-orchestrator
```

- [Install in OpenCode](INSTALL-IN-OPENCODE.md)
- [Original Codex installation](INSTALL-IN-CODEX.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Policy](POLICY.md)
- [Worker instructions](WORKER-INSTRUCTIONS.md)
- [License](LICENSE)

Do not enable both the original and new orchestration policies for the same task.
See the [upgrade guide](../../docs/UPGRADING.md) before switching workflows.

Installer and agent behavior derives from public commit
`68f8d34b7532be2623c804e97f53be337310cb35`. Sample projects and historical benchmark
material are not included. Regression tests build temporary fixtures.

## Contributor checks

```sh
python3 -B -m unittest discover -s tests
python3 -B scripts/release.py --check
```
