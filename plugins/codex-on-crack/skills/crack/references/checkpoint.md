# Resumable checkpoints

A checkpoint lets the next session continue without repeating completed work. It
is a short, current status record, not an append-only transcript and not a
substitute for the repository or the tests.

## When to write one

- at a meaningful boundary: the end of a phase, before a handoff, or when you
  have to stop with work unfinished;
- when a decision or constraint would be expensive to rediscover.

## What it records

- the agreed result and scope, and where the spec or plan lives;
- the workspace, baseline, and preserved user changes;
- decisions that are settled, with the reason;
- completed work and how it was verified;
- the active or unfinished work, who owns it, and its current state;
- outstanding risks, blockers, and anything unverified;
- the exact next action, and the authorization that still applies.

Keep the newest state in place of the old. Update or replace stale lines instead
of appending history. Cite file and line for important findings so the next
reader can confirm them against the repository.

The core skill includes an optional fill-in form:
[checkpoint template](../templates/checkpoint.md). In direct mode,
keep the same fields in the task notes or an equivalent local file. Keep
checkpoints local (for example under a `.crack/` directory) unless the project
wants them tracked.
