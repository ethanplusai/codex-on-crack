# Astra's acceptance gate

Treat the worker report as a claim requiring evidence. Review the actual changed
files relative to the task's captured baseline, including new untracked files.
Do not include unrelated pre-existing edits in the worker's attribution, and do
not overlook newly created files because `git diff HEAD` doesn't show them.

## Lens 1: specification compliance

Map every acceptance criterion to code, test, or observed behavior. Check contract
names/types, failure cases, boundary conditions, compatibility, and the stated
non-goals. Detect missing behavior, work outside scope, placeholder implementations,
and invented requirements. Confirm tests exercise the intended behavior rather
than a stub. Identify any acceptance criteria that the environment cannot verify.

## Lens 2: quality and risk

Look for logic defects, unintended data flow, security/authorization errors,
unsafe concurrency, lifecycle cleanup, poor error handling, brittle test mocks,
weakened types, and unwanted dependencies or configuration changes. Match existing
repository conventions without demanding a gratuitous rewrite. Review all changed
code for the current task; do not paste the whole patch into chat as a ritual.

Apply both lenses in one batched Astra review of the patch and evidence. They are
not a requirement for two tool loops or two more agents. An independent reviewer
may be useful for high-risk work only when its model and permissions are explicitly
selected and its cost is justified. With Flash configured globally as the child
default, an ordinary unnamed reviewer will not automatically be Astra.

## Verify and decide

Start from the worker's concrete evidence: commands, exit statuses, salient output,
and visual artifacts. Inspect the actual changed files. Independently rerun only a
targeted check when evidence is missing, a failure is plausible, integration adds
new risk, or a high-assurance concern warrants confirmation. Do not rerun the full
suite or repeat browser QA as a ritual. For environment-blocked checks, record
exactly what wasn't verified. Do not claim acceptance of a requirement whose
verification is missing.

The valid outcomes are accepted, changes requested, or blocked. Only Astra assigns
accepted. Return all file-specific findings and expected corrections in one request
to the same worker. Re-review the affected fixes and run phase-level integration
checks only at a genuine integration boundary. One correction cycle is the default;
a second requires a stated material high-assurance concern. Passing isolated tests
does not establish cross-task compatibility or overall completion.
