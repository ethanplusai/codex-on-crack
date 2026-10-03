---
name: crack-setup
description: Configure or change the approved worker models for codex-on-crack, inspect available models and compatibility, preview role files, or undo a setup. The user selects the lead in Codex. Setup preserves root settings, credentials, unrelated agents, and config.toml.
---

# Choose workers; preserve the lead

Helpers live in `../crack/scripts/`. Keep the user's existing model/provider
choices. Installing skills alone does not configure workers or change the lead.

1. Run `node ../crack/scripts/setup.mjs scan` with the session's home/profile.
   Show relevant eligible models, efforts, image support, context, and exclusions.
   Catalog presence is not account access or a working provider route. Do not
   rank capabilities the catalog does not establish or invent prices.
2. Read an existing `crack.toml` before proposing changes. Start with one builder
   chosen by the user. Additional roles can map to `implementation`, `ui`,
   `review`, `research`, or `tests` with a `tasks` array. These are user preferences,
   not demonstrated model strengths. Set the exact model and a supported effort;
   keep fallback optional. Never change the selected lead to make setup pass.
3. Write a draft in a task-owned directory. Preview with
   `node ../crack/scripts/setup.mjs plan --roles DRAFT` and show the concrete
   model/effort and file changes. Apply the agreed configuration with
   `node ../crack/scripts/setup.mjs apply --roles DRAFT`. If the specific model
   choices or global writes aren't yet authorized, obtain that decision after
   producing the preview. Don't repeat approval already given for those choices.
4. Return the receipt path and explain that a fresh client session must load the
   generated native roles. Run `doctor.mjs`; then use a real authorized task to
   verify child metadata. No paid installation smoke test is needed.

Draft shape (replace the model with an exact eligible ID):

```toml
schema_version = 1
[roles.builder]
model = "MODEL_FROM_SCAN"
writes = true
tasks = ["implementation", "tests"]
brief = "Implements the scoped task and verifies it for lead review."
```

Role names use lowercase letters/digits/underscores and cannot end `_fallback`.
Read-only roles set `writes = false`. Use capability/route checks, not a model's
brand, to determine whether a proposed setup is compatible. A model recommendation
does not grant permission to share private source with a new provider.

The current adapter conservatively checks the inherited parent provider.
Native-model and Router-model catalog entries may both exist without a compatible
mixed-provider session. Stop and explain an incompatible route; do not rewrite
endpoints, credentials, or permissions. Custom-role model settings take precedence
over a spawn override, so verify the role actually names the selected model.

Default to no global policy during initial setup. If an old orchestrator policy
is active, explain the conflict and use an authorized `--migrate-legacy` preview
rather than leaving both workflows active. This backs up/removes only its marked
policy block; old role and skill files remain. Do not migrate merely to inspect
or compare the packages.

Use `--profile` consistently; setup records profile/catalog for future checks.
An offline `--model-catalog` can supply metadata only when it does not conflict
with the configured catalog. Setup never refreshes a provider or reads credentials.
Undo previews with `setup.mjs undo --receipt PATH`; `--apply` restores only when
no later edits would be overwritten. Preserve receipts and hand-edited files.
