# Sources and provenance

Public documentation checked September 20-21, 2026. These are original package
instructions and utilities, not a copy or distribution of Superpowers, GSD,
Compound Engineering, or Codex Router, apart from the vendored parser listed
below. Upstream documentation and local client behavior may change independently.

## Vendored code

- [smol-toml](https://github.com/squirrelchat/smol-toml) 1.8.0, BSD-3-Clause,
  copyright Squirrel Chat et al. Its `dist/*.js` files are vendored unmodified in
  `plugins/codex-on-crack/skills/crack/scripts/lib/vendor/smol-toml/`, together
  with its LICENSE. It parses TOML, because Node has no built-in parser.

## Panel dependencies

The optional panel uses pinned versions of the official MCP SDK, MCP Apps SDK,
and OpenAI MCP extensions package. Its reproducible dependency tree is recorded
in [`panel/package-lock.json`](panel/package-lock.json); development uses esbuild
and jsdom. Unlike the core helpers, the panel is not dependency-free. The runtime
bundle is checked in so users do not need an npm install to open it. Review the
bundled dependencies' licenses and notices as part of [contributor checks](CONTRIBUTING.md).

## Official Codex documentation

- [Build skills](https://learn.chatgpt.com/docs/build-skills): local skill layout,
  user discovery under ~/.agents/skills, explicit/implicit invocation, metadata.
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): child
  model defaults, custom agent configuration and model precedence, native roles.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference):
  model_catalog_json, user configuration and profile considerations.
- [Codex customization](https://developers.openai.com/codex/customization/overview):
  distinction between durable AGENTS guidance, skills, external tools and agents.

## Primary project/vendor documentation

- [Codex Router repository](https://github.com/duolahypercho/codex-router): published
  provider-specific model IDs, preserved native routing, local catalog/URL setup.
- [Codex Router V4.1 Flash route tests](https://github.com/duolahypercho/codex-router/blob/main/test/deepseek-v4-1-flash.test.mjs):
  reviewed provider slugs and upstream model mappings for DeepSeek, OpenRouter,
  opencode Go, Command Code, Nous Research and Ollama Cloud.
- [Codex Router installation guide](https://github.com/duolahypercho/codex-router/blob/main/docs/INSTALL.md):
  health/doctor process and explicit paid smoke-test distinction.
- [DeepSeek models](https://api-docs.deepseek.com/quick_start/pricing/): direct API
  name deepseek-flash and the documented V4.1 Flash version association.
- [OpenRouter DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash):
  OpenRouter model identity, provider routing and tool support.
- [Superpowers brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md):
  discovery/design before implementation.
- [Superpowers writing-plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md):
  explicit file/contracts/tests and independently reviewable deliverables.
- [Superpowers subagent-driven-development](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md):
  bounded implementer context, task review and broad final review. Its
  spec-then-quality review order informs the reviewer role.
- [GSD Core](https://github.com/open-gsd/gsd-core): dependency waves of fresh
  worker contexts, and plans small enough to finish and verify independently.
- [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin):
  each unit of work should make the next easier. This informs the practice of recording reusable project lessons.
- [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex): prior art for a
  Codex workflow layer and its plugin marketplace layout.

## Provenance

The package contains original workflow instructions and Node utilities (Python in 1.x). Its design was informed by the public references above. Upstream projects are referenced, not bundled or relicensed.
