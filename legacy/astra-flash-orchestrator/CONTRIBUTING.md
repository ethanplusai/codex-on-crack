# Contributing

Keep changes focused on the native Astra/Flash workflow, installation reliability, useful task contracts and review evidence. Preserve the user's root model, existing Router and security boundaries.

Use Python 3.11+ with no third-party runtime dependencies. Run from the repository root:

```sh
python3 -B -m unittest discover -s tests -v
python3 -B scripts/release.py --check
```

Tests use temporary synthetic homes and a loopback HTTP fixture. Do not run `install.py --apply` against your real home just to test a contribution. Never add paid inference to tests or CI.

For behavior changes, add meaningful regression tests. Explain the problem, resulting behavior, checks actually run and limitations. Test supported Python versions when changing syntax or standard-library behavior. Real-client/provider checks must be labeled separately from offline tests.

Do not commit credentials, local catalogs, generated routing bindings, receipts, backups, private logs or personal configuration. New sources require attribution and compatible licensing. User data and private task context must not be included in examples.

After changing distributable files, regenerate the inventory with `python3 -B scripts/release.py`, inspect its diff, then run `--check`. The release archive is built from a narrow file selection, not the entire working directory.
