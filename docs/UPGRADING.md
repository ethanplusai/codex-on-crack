# From Astra Flash Orchestrator to Codex on Crack

Codex on Crack is the next iteration of Astra Flash Orchestrator. The scope grew
from one model pairing to selectable workers, a Claude Code route, host-tool
handoffs, and a workspace panel. The original Astra + Flash arrangement remains
available when its native role and route are configured.

## What an update does and does not change

Pulling repository changes updates the source checkout. It does not automatically
migrate an installed skill, replace a managed policy, change a provider, or refresh
an existing conversation. Plugin installation and worker configuration are
separate steps. Keep the original install receipt and a copy of your working
checkout until you have verified the replacement.

| Original setup | New setup |
| --- | --- |
| Personal `astra-flash-orchestrator` skill | Three plugin skills: `crack-plan`, `crack-setup`, `crack` |
| Named `astra_flash_builder` role | Compatible configured worker roles, chosen explicitly |
| Astra plans, Flash builds, Astra reviews | That arrangement plus other supported lead/worker combinations |
| Managed Astra/Flash policy | Optional managed policy, with a scoped legacy migration and undo receipt |
| Original measurement visual | Optional workspace panel, visual feedback, usage, and replay |

## Try it without replacing your current workflow

1. Keep a copy of the old checkout and its install receipts. Do not reset a clone
   with local changes to obtain the update.
2. Read [the installation guide](../INSTALL-IN-CODEX.md) and check the required
   client, Node.js version, and model access before changing your setup.
3. Install the core plugin, then the optional panel, using
   [the installation guide](../INSTALL-IN-CODEX.md).
4. Ask setup to inspect your existing roles and available routes. Keep your
   current lead model and credentials. Installation makes no paid model requests.
5. Try a small, useful build that you authorize, then inspect the result and usage.

## Switch the existing Codex installation

From the updated checkout in a stable location:

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-on-crack@codex-on-crack
codex plugin add codex-on-crack-panel@codex-on-crack
```

The last command is optional. Start a new conversation and ask:

> Set up Codex on Crack using my existing models and routes. I have an
> Astra Flash Orchestrator installation. Check for its managed policy and show
> the exact migration before applying it. Preserve my host model, permissions,
> credentials, unrelated instructions, and original role files. Do not run paid
> inference during setup. Keep an undo receipt.

Setup supports `--migrate-legacy` for an explicitly agreed policy transaction.
It backs up and removes only the recognized legacy marked block. Old skill and
role files remain in place. Do not run both orchestration policies for one task.
Custom or unrecognized policy text needs individual review; do not delete it to
force setup through. Restart the client when needed to load changed agent files,
after ongoing work has finished.

Start a fresh chat for the first build. A successful install is not proof of a
working model route; verify that with your first authorized task.

## If you want to go back

Use the new setup transaction's undo receipt as described in the
[install guide](../INSTALL-IN-CODEX.md#undo-worker-setup). Preview undo first;
it refuses to overwrite later edits. Remove the optional plugins separately if
you no longer want them. Plugin removal alone does not restore roles or policy.
Do not delete shared provider configuration, keys, or the entire agents directory.

## OpenCode users

The original repository also supports OpenCode. This Codex plugin installation
is not an OpenCode migration. Keep using your existing OpenCode installation
and its instructions; do not apply Codex policy changes to that setup.
The original package, installer and tests are preserved unchanged under
[`legacy/astra-flash-orchestrator`](../legacy/astra-flash-orchestrator/README.md).
Run its commands from that directory. See the root
[OpenCode guide](../INSTALL-IN-OPENCODE.md) for the entry point.

## Repository name

The product is called Codex on Crack. The existing Astra Flash Orchestrator URL
remains the transition link. Renaming a GitHub repository does not update a local
folder name or install a plugin. If the repository is renamed later, follow its
published instructions for updating your clone's remote.
