---
name: crack-plan
description: Start a substantial build with Codex on Crack. Inspect the user's own configured models and readiness, recommend a lead/worker/tool shape with reasons, and let the user decide before work starts. Use before delegating; keep small or solo tasks direct.
---

# Plan one build, then choose

Use this when the user wants to start a meaningful build and has not already
decided how to divide it. The goal is a short, honest plan built from what is
actually configured, with the final choice left with the user.

## Resolve named models before recommending

A request such as “run subagents through Opus 5.5” already selects a model.
Follow the model-request routing in [crack](../crack/SKILL.md); the user need
not specify the subscription or adapter. The native planner below does not
inventory Claude Code access, so a missing native role is not proof that Opus
is unavailable. Check the external adapter separately when requested. Keep
route ambiguity, missing access, and unsupported model versions explicit.

## Gather local facts only

Run `node scripts/plan.mjs` (add `--task implementation|ui|review|research|tests`
when the work is known). It reads the model catalog Codex already uses, the
generated roles, and static readiness. It makes no model call, changes no
configuration, and never probes a provider.

## Recommend with reasons, then let the user decide

When several configured workers qualify, offer the recommendation the planner
returns and say why in its terms: a role whose configured `tasks` list includes
this category, a conventional role name for the task, and a generated file that
is present and unmodified. Label that as a qualitative judgement about fit, not
a measured ranking, and accept a different choice without argument.

If the user already named a worker role or a mode, honor it: do not re-ask for a
decision that is already made. If they named something that does not qualify,
say exactly which requirement failed rather than substituting another model.

## Keep the roles distinct

- The **Codex host model** is whatever the user selected in the composer. A
  skill cannot change it.
- A **configured worker** implements one bounded bundle and is reviewed.
- The optional **external project lead** is a different thing: the official
  Claude Code client on an existing subscription login, on the exact model
  `claude-opus-5-5`, with no Codex tools and no API fallback. Read
  `../crack/references/external-lead.md` before offering it.

Host-only solo work needs no worker. Explicit Opus implementation uses the
external adapter's `solo` mode and its readiness checks. When no configured worker
qualifies, say so and suggest `$codex-on-crack:crack-setup`; do not invent a
substitute.

## Hand off

Once the shape is agreed, hand the work to `$codex-on-crack:crack` with the
chosen route and worker, or keep a host-only task direct. For replay of a
host session and worker sessions, read `../crack/references/replay.md`.

## Keep the claims honest

- Catalog presence is not account access, provider routing, or quality.
- No allowance, quota, savings, or price claims. Missing usage stays unknown.
- Terminal tooling is an allowlist, not filesystem isolation; scope follows the
  approved workspace and task.
