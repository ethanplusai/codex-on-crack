# Security and privacy

This package installs agent guidance and a native role. Guidance, file ownership and Git worktrees are not operating-system security boundaries. Existing sandbox, approval and repository restrictions continue to apply.

Installation does not run inference. A later delegated task sends its selected context and tool outputs to the configured provider. Obtain the appropriate authorization for private repositories and minimize shared context.

Enter provider credentials only through Codex Router's private local prompt.
Never paste a provider key into assistant chat. A package install does not
authorize `subagents certify`, `test-model --live`, smoke tests or other paid
inference probes; missing route certification is reported as a prerequisite.

Never publish authentication files, API keys, private Router capability URLs, local model catalogs, installation receipts, instruction backups or unredacted task/provider logs. Synthetic test credentials in this repository are deliberately fake.

For a suspected vulnerability, use GitHub's private vulnerability reporting on this repository when the maintainer has enabled it. If unavailable, open a minimal issue requesting a private contact without exploit details, secrets or private logs. Do not use public issues to transmit sensitive evidence. No response-time guarantee is currently offered.

Useful reports include the package/client/Python version, affected behavior and a synthetic reproduction. Preserve security checks while investigating; do not disable Router authentication or approval controls to make a test pass.
