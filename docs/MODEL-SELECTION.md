# Choosing models

Select the host model in Codex. The package preserves that choice and configures
worker roles separately.

Ask `crack-plan` to recommend an arrangement, or name the model and task directly:

> Have Opus plan this and Flash implement it. Bring the result back for review.

Recommendations use your configured roles, declared capabilities, route readiness,
and preferences. They do not come from an automatic benchmark of every model.

| Input | How it is used |
| --- | --- |
| Available models and routes | Determine which configured workers can be selected. |
| Required capabilities | Filter roles for requirements such as image input. |
| Your preferences | Honor explicit worker choices and optional task mappings. |

An ambiguous choice is returned with explanations. Missing access does not cause
the package to install a provider, change the host model, or substitute another
billing route.

## Inspect configured roles

From `plugins/codex-on-crack/skills/crack`:

```sh
node scripts/setup.mjs scan
node scripts/select.mjs --task implementation
node scripts/select.mjs --task ui --vision
```

These commands inspect local configuration without starting a model request.
Static eligibility is not proof that a provider will serve a live request.

## Execution routes

Compatible native workers use Codex delegation, including configured routes
through Codex Router. The external Claude adapter targets `claude-opus-5-5`
through the authenticated Claude Code client. These are distinct routes; the
external model does not replace the host selected in the Codex composer.

Use [worker setup](../INSTALL-IN-CODEX.md#choose-models) to configure roles and
[the workflow guide](WORKFLOW.md) to understand dispatch and review.
