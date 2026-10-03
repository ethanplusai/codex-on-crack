# Model choice without a hidden ranking

The lead is the model selected by the user in Codex. Workers are exact configured
native roles. The package makes no claim that every model can orchestrate, use
all tools, or reach every provider in every host session.

`select.mjs` reads the installed role configuration, local capability metadata,
and static readiness. It makes no model call and changes nothing. A task mapping
expresses the user's preference: for example a `ui` role with image support for
screenshot work, or a `research` role permitted only to read. It is not a learned
claim that the chosen model is better at that task.

```sh
node scripts/select.mjs --task implementation
node scripts/select.mjs --task ui --vision
node scripts/select.mjs --task review --role reviewer
```

With no explicit mapping, builder can serve implementation. Explicit `--role`
selects a configured role but cannot bypass routing, effort, permission, or
requested capability checks. A unique ready match can be recommended. Several
matches require a choice; no match requires setup or a changed requirement.
Unknown context/image capability does not satisfy a required capability.

The lead may dispatch a selected role only through available native tools and
within the user's approved model/provider scope. Recommendations do not switch
the current lead, install roles, or guarantee provider identity. Recheck actual
session overrides when they differ from the inspected configuration.

What can improve later: observations from representative personal trials can
inform new task mappings. Record task category, model/effort, outcome, rework,
checks, and usage first. Do not automatically learn from one subjective score,
compare unrelated projects as controlled benchmarks, or let a low token count
outweigh unacceptable quality. No universal model-strength database ships here.

Model Counsel is a separate optional consultation engine: it asks configured
reviewer models for independent opinions and synthesizes them. It is neither this
selector nor a prerequisite. Invoking a council on every routing decision would
add requests and latency; keep it for a consequential disputed decision when
explicitly wanted, without treating its recommendation as execution permission.
