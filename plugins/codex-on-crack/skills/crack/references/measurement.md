# Controlled trials

Use fresh paired sessions with identical initial repository, prompt, root model,
effort, tools, permissions, and acceptance checks. Do not reuse a session that
has already solved the task. Keep prior lessons, global orchestration policies,
and unrelated roles out of the baseline. Do not weaken the baseline's normal
native capabilities. Record the actual models each condition uses.

Compare stock Codex, the thin workflow with same-model workers, and (only when
approved) the thin workflow with a different worker. Freeze conditions before
scoring; count failures, human intervention, and all retry/review usage. A single
pilot demonstrates operability, not improved cost or quality.

Report acceptance first, then root usage, all-session usage, time and human
intervention. Export the complete root and every descendant session privately:
`node scripts/report.mjs --plan <plan.json> --root-session <id>
--session-log <root.jsonl> --session-log <child.jsonl>`.
This counts cumulative native client snapshots once per session, includes only
linked descendants, and leaves missing usage unknown. Verify export coverage
from the host; the importer cannot discover omitted children. Provider labels
may be unavailable. Client usage is not service identity or actual billing.

`--router-log <path>` optionally provides a separate diagnostic window, never
run attribution. Native workers are absent from that log and unrelated requests
may be present. Do not use its numbers as savings evidence.

The report counts each task's final rung, not all escalation events. Retain a
separate timestamped intervention/escalation trace and recordings. Redact all
exports before publishing. Require equal held-out acceptance and report total
resources per accepted outcome; avoid lines-of-code productivity claims.
