# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will
allow you to complete the task.

Read `CONTEXT.md` if it exists so your test names and interface vocabulary match
the project's domain language, and respect any ADRs in the area you're touching.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION — test-driven (red → green)

Build the change test-first, in **vertical slices**: one test → just enough code
to pass it → repeat. Each test is a tracer bullet that responds to what the last
slice taught you. Do NOT write all the tests first (horizontal slicing) — that
tests imagined behaviour and locks in structure before you understand it.

**Pick the seams first.** A seam is the public boundary you observe behaviour at —
an exported function, an HTTP route, a CLI command. Before writing a test, decide
which seams you're testing at, and prefer the fewest, highest seams. Test *at*
seams, never against internals. If the issue implies a new seam, choose the
highest reasonable one.

The loop, per slice:

1. **RED** — write ONE failing test at a seam. It must fail for the right reason
   (run it, see it red). Assert against an independent source of truth (a
   known-good literal, a worked example, the spec) — never recompute the expected
   value the way the code does.
2. **GREEN** — write only enough implementation to make that one test pass.
   No speculative features, no anticipating later tests.
3. **REPEAT** — next slice, informed by what you just learned.

Avoid these test anti-patterns:
- **Implementation-coupled** — mocking internal collaborators, testing private
  methods, or asserting via a side channel (querying the DB instead of the
  interface). Tell: the test breaks on a refactor when behaviour didn't change.
- **Tautological** — the assertion recomputes the expected value the same way the
  code does, so it can never disagree with the code.
- **Horizontal slicing** — all tests first, then all code.

**Refactoring is NOT part of this loop.** Get to green with a working, tested
slice. Broad cleanup/refactor happens in the review stage — don't gold-plate here.

# FEEDBACK LOOPS

{{WORKSPACE_HINT}}

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
