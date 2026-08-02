# ADR 0001 — The monitor reads the CLI seam, not the modules behind it

Status: accepted · 2026-08-02

## Context

`ui.mts` gets the run's health by spawning `npx tsx watch.mts` and parsing its
stdout, and the issue list by spawning `npx tsx list-issues.mts` and parsing its
JSON. Two subprocesses per poll.

An architecture review flagged this as friction and proposed importing those
modules directly. At the time the proposal was made it was partly a symptom of a
real problem: nothing in the harness exported anything, so a subprocess was the
*only* seam available. That constraint is now gone — `config.mts` and
`decisions.mts` are imported by every script, and the review explicitly said to
re-decide this one afterwards rather than before.

Re-deciding it: keep the subprocess.

## Decision

The monitor consumes `watch.mts` and `list-issues.mts` through their command-line
interface. It does not import their internals.

## Consequences

What this buys, and why it outweighs two process spawns per poll:

- **The monitor cannot disagree with the operator.** `watch.mts`'s stdout is
  what a human reads when they run the same command. If the monitor computed its
  own verdict from imported pieces, the dashboard could show "healthy" while
  `npx tsx watch.mts` in the terminal says otherwise — and this harness has
  already lost hours to two tools that were supposed to agree and quietly
  didn't (`check-models.mts` re-implementing the loop's liveness policy, kept in
  step by a comment). One verdict, one producer.
- **`ISSUE_SOURCE` stays invisible to the monitor.** `list-issues.mts` is the
  switch between GitHub and local issue files. Consuming its output means the
  monitor works in both modes without knowing either exists.
- **The cost is bounded and known.** Both calls are cached (5s for the health
  verdict, 60s for issues), so the spawns do not scale with browser polls.

What we accept:

- A wording change in `watch.mts`'s output can change what the monitor displays.
  This is a real coupling — the text format *is* the interface — and it is the
  price of the guarantee above. If that becomes painful, the fix is to make
  `watch.mts` emit a stable machine-readable line *in addition to* the human
  one, not to bypass it.

## Not re-litigating

A future architecture review that spots the subprocess and proposes importing
the modules should read this file first. The seam is deliberate. Propose a
change only if the failure mode above (monitor and terminal disagreeing) has
been solved some other way.
