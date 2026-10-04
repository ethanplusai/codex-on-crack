# Choosing verification

Read this when you are deciding what evidence a change needs. The goal is an
honest check of the actual behavior, not a fixed count of stages.

## Match evidence to the feature

- Identify the observable result the user asked for and check that journey, not
  only an internal function.
- Cover the negative and boundary cases that could silently change behavior:
  invalid input, empty or missing data, ordering, limits, and error paths.
- Check integration points and any real UI state the change touches. A screenshot
  or a driven browser session is evidence; a claim that it "should render" is not.
- When the feature persists data, exercise the failure boundaries: a rejected
  write, a partial failure, a concurrent change, and recovery after restart.
  Load this only for persistence work, not as boilerplate for every task.

## Prefer the smallest honest check

Check buildability and the affected behavior before expensive corpus audits or
benchmarks. A failed prerequisite should lead to one concrete correction, not
more checks that cannot establish acceptance yet. Do not repeat an unchanged
timed-out workload; first identify its expensive path or missing prerequisite.
For latency comparisons, require equal successful work and disclose differing
output counts; equal inputs or a zero-decision run alone cannot prove a gain.

Run the targeted test for the behavior you changed. Widen to the full suite when
shared code, packaging, configuration, or a release inventory makes the wider run
the honest check. Do not rerun an entire suite after every small edit, and do not
call a passing test suite proof of a user journey it never exercised.

## Keep evidence separable from claims

Record each command with its working directory, exit status, and the result that
matters. When a check cannot run, say so and why. Missing evidence is missing,
never a pass, and a worker report is an index to the artifacts, not a substitute
for inspecting them.

## Blocking findings

A confirmed defect that can lose or corrupt data, or that breaks authorization or
a security boundary, blocks acceptance even when every automated check passes.
Report it with its evidence instead of trading it against a passing suite, and
keep looking for the same class of problem when the change touches persistence,
permissions, or tenancy.

## Independent scrutiny

Use a second independent pass when a concrete risk or inadequate evidence
justifies it, not by default. Fresh context on the same model can help; a
different model is not automatically a better reviewer.
