# ISSUES

Open issues labelled {{ISSUE_LABEL}} (already filtered to work-ready):

<issues-json>

!`gh issue list --state open --label {{ISSUE_LABEL}} --limit 100 --json number,title,body,labels --jq '[.[] | {number, title, body, labels: [.labels[].name]}]'`

</issues-json>

# DEPENDENCY ORDER

{{DEP_ORDER_BLOCK}}

# TASK

Pick the issues that are safe to work **in parallel right now**. Rules, in order:

1. **HARD SKIP** — never select an issue whose labels include `blocked` or
   `deferred`, or that the dependency-order source marks BLOCKED / DEFERRED.

2. **Respect epic / milestone order.** Work the lowest-numbered unfinished
   epic first. Do not start epic N+1 while epic N still has unstarted stories
   that later stories depend on. (Skip this rule if issues aren't grouped into
   epics.)

3. **Respect story order within an epic.** An issue is **unblocked** only if
   every story it depends on is already `done` (per the dependency-order source,
   or per the issue body's stated dependencies when there's no such file).

4. **No file-overlap conflicts.** If two candidate issues would touch the same
   module, select only the earlier one this round.

5. **Batch size:** select at most **3** issues this round. Fewer is fine. The
   outer loop re-plans after each merge, so remaining work is picked up next cycle.

{{PROJECT_RULES}}

For each selected issue assign branch `sandcastle/issue-{id}` (exact format, no slug).
Deterministic so re-planning preserves accumulated progress.

Also judge each issue's **difficulty** and set `size`:
- `"small"` — CRUD on an existing pattern, a filter/export, a config screen, a
  copy/label change, anything that follows a module already in the codebase.
- `"large"` — a new subsystem, non-trivial schema or migration design, security/
  permission logic, an algorithm, cross-cutting refactors, or anything with
  tricky edge cases. When unsure between the two, pick `"large"`.

The size routes the implementer model (small → a fast model, large → a stronger
one), so be honest: over-calling `small` on hard work produces weak code.

# OUTPUT

Output as JSON wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "40", "title": "Realtime transport", "branch": "sandcastle/issue-40", "size": "large"}]}
</plan>

Every issue MUST include `size` ("small" or "large"). Include only selected
unblocked issues (max 3). If everything ready is blocked, emit
`<plan>{"issues": []}</plan>` so the run exits cleanly. Always emit the tags.
