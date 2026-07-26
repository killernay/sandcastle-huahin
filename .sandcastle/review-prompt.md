# TASK

Review the changes on branch `{{BRANCH}}` for issue {{TASK_ID}} along **two axes**
— Spec (does it do what the issue asked?) and Standards (is it clean and correct?)
— then apply refactors and fixes directly on the branch.

# CONTEXT

## The originating issue

!`gh issue view {{TASK_ID}}`

## Branch diff (three-dot, against merge-base)

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# AXIS 1 — SPEC (does the code match what was asked?)

Read the issue above (and any parent PRD it references). Check the diff against it:

- Is every acceptance criterion / requirement in the issue actually implemented?
- Are the stated edge cases handled?
- Did the implementer do **only** what the issue asked — no scope creep, no
  unrelated changes?
- Are the new/changed behaviours covered by tests **at a public seam** (not
  coupled to internals, not tautological)? If a required behaviour has no test,
  add one (red → green).

If the code does NOT satisfy the issue, fix it — implement the missing behaviour
test-first. This axis is about correctness-vs-intent, and it comes first: clean
code that does the wrong thing is still wrong.

# AXIS 2 — STANDARDS (is the code clean, safe, maintainable?)

Follow the coding standards in @.sandcastle/CODING_STANDARDS.md. Look for:

- Unnecessary complexity/nesting; redundant code or abstractions to consolidate.
- Unclear names; comments that just restate the code.
- Nested ternaries (prefer if/else or switch); overly clever one-liners.
- Unsafe casts, `any` types, unchecked assumptions.
- Security: injection, credential leaks, unvalidated input at trust boundaries.

This is also where **refactoring** happens (the implementer deliberately left it
out of its red→green loop). Improve *how* the code reads without changing *what*
it does — preserve all behaviour and keep tests green.

Maintain balance — don't over-simplify into something harder to debug, don't
collapse helpful abstractions, don't merge unrelated concerns.

# EXECUTION

1. Do the Spec axis first, then Standards. Make changes directly on the branch.
2. Run the checks below after your changes — everything must stay green.

{{WORKSPACE_HINT}}

3. If you changed anything, commit describing the review fixes (Spec gaps closed,
   refactors applied). If the code already satisfies the issue and is clean, do
   nothing.

Once complete, output <promise>COMPLETE</promise>.
