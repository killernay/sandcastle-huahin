---
name: sandcastle
description: "Audit or set up the sandcastle-huahin AFK coding-agent harness in a repo. Use when the user says 'sandcastle check', 'sandcastle setup', asks whether a sandcastle run is configured correctly, wants to install the harness into a project, or a run produced no commits / failed silently."
trigger: /sandcastle
---

# /sandcastle

Two modes. Pick by what the repo already has.

- `.sandcastle/` missing → **SETUP**
- `.sandcastle/` present → **CHECK** (default; also use after a run misbehaves)

Never guess a value. Every item below is a command whose output decides the
answer. Report a table of PASS / WARN / FAIL with the fix next to each failure,
then offer to apply the fixes — don't apply silently.

## CHECK

Run these from the repo root. Each line is one check.

```bash
# 1. harness files
ls .sandcastle/{main.mts,plan-prompt.md,implement-prompt.md,review-prompt.md,merge-prompt.md,Dockerfile}

# 2. deps + script  (FAIL → npm i -D @ai-hero/sandcastle tsx zod; npm pkg set scripts.sandcastle="tsx .sandcastle/main.mts")
ls -d node_modules/@ai-hero/sandcastle && npm pkg get scripts.sandcastle

# 3. real .env, not just the example  (FAIL → cp .sandcastle/.env.example .sandcastle/.env and fill it)
test -f .sandcastle/.env && grep -c "^GH_TOKEN=." .sandcastle/.env

# 4. WORKSPACE_DIR points at a real workspace (empty value = repo root is the workspace)
W=$(grep -m1 "^WORKSPACE_DIR=" .sandcastle/.env | cut -d= -f2); ls "${W:-.}/package.json"

# 5. the false-green guard — see "Three slots" below
test -f .sandcastle/workspace-hint.md

# 6. optional planner knowledge
test -f .sandcastle/planning-rules.md

# 7. DEP_ORDER_FILE, if set, must exist
D=$(grep -m1 "^DEP_ORDER_FILE=" .sandcastle/.env | cut -d= -f2); [ -z "$D" ] || ls "$D"

# 8. the label exists and has open issues
L=$(grep -m1 "^ISSUE_LABEL=" .sandcastle/.env | cut -d= -f2); L=${L:-ready-for-agent}
gh label list --search "$L" | head -3; gh issue list --state open --label "$L" --limit 5

# 9. models live + sandbox image built + prompt args wired + no built-in overridden
npx tsx .sandcastle/check-models.mts

# 10. how many runs are live — ONE line per run, 0 before you start another
ps -eo pid,lstart,command | grep "[t]sx .sandcastle/main.mts"

# 11. containers: 2 per issue in flight is normal; only non-zero with NO run live is a leak
docker ps -a --filter name=sandcastle -q | wc -l

# 12. worktrees left dirty by a killed run — the next implementer would inherit them
for w in .sandcastle/worktrees/*/; do [ -d "$w" ] && git -C "$w" status --porcelain | head -3; done
```

Count runs with the `[t]sx` pattern, not `main.mts` — one run is two processes
(the tsx wrapper and its node child), so a looser grep reads as two runs.

Check 9 covers models, the sandbox image, `{{PLACEHOLDER}}`s no one passes, and
built-in args being passed. Read its output rather than re-deriving it.

## Three slots — the only project-specific config

Everything else in `.sandcastle/` is template code that a future harness sync
overwrites. If a project's knowledge lives in a prompt file, the next sync
deletes it. Put it here instead:

| File | Holds | Absent means |
| --- | --- | --- |
| `.sandcastle/.env` | `WORKSPACE_DIR`, `ISSUE_LABEL`, `DEP_ORDER_FILE`, `GH_TOKEN` | broken — the run needs it |
| `.sandcastle/workspace-hint.md` | how to run this repo's checks, with real script names | a generic hint; an agent that runs `pnpm test` where there are no tests gets exit 0 and calls it green |
| `.sandcastle/planning-rules.md` | selection rules only this repo knows: finished epics, work blocked on someone outside the repo, deliberately deferred stories | the planner orders by issue bodies, labels and `DEP_ORDER_FILE` alone |

When check 5 fails, draft `workspace-hint.md` from the workspace's real
`package.json` scripts — name the commands that must pass before a commit, and
say plainly which directory has no tests. Confirm the draft with the user; you
can read the scripts, but only they know which one is the gate.

## SETUP

```bash
npx degit killernay/sandcastle-huahin/.sandcastle .sandcastle
cp .sandcastle/.env.example .sandcastle/.env
npm i -D @ai-hero/sandcastle tsx zod
npm pkg set scripts.sandcastle="tsx .sandcastle/main.mts"
npx sandcastle docker build-image
mkdir -p .claude/skills && ln -s ../../.sandcastle/skill .claude/skills/sandcastle
```

Then fill the three slots (interview the user — do not invent epics, labels or
script names), and finish with CHECK. Only when CHECK is clean:

```bash
9router &                                              # the gateway must be up
nohup npm run sandcastle > .sandcastle/run.log 2>&1 &
```

## One run per repo

Concurrent runs share `.sandcastle/worktrees/`, so one run's `sandbox.close()`
deletes a worktree while the other's agent is still working in it: agents die
with "the cwd was deleted", commits go uncounted, and both write the same
`run.log`. Check 10 must be empty before starting. To stop a run:

```bash
pkill -f "tsx .sandcastle/main.mts"
ps -eo pid,command | grep "[t]sx .sandcastle/main.mts"   # expect nothing
docker ps -a --filter name=sandcastle -q | wc -l         # expect 0; sandcastle cleans up after itself
```

`main.mts` is read once at start, so editing it mid-run changes nothing until a
restart — but the **prompt files are read on every agent run**. Copying a newer
prompt over a live run makes it reference args the in-memory `main.mts` never
passes, and on the `sandbox.run` path a missing arg is collected interactively:
under `nohup` that hangs the run instead of failing it. Sync prompts only while
stopped.

## Reading a run

`run.log` narrates the loop; each agent writes its own transcript under
`.sandcastle/logs/`. Agent logs do **not** contain the prompt, so grepping them
for prompt text proves nothing.

```bash
tail -f .sandcastle/run.log                                    # overview
tail -n 5 -F .sandcastle/run.log .sandcastle/logs/*.log        # overview + every agent
ls -t .sandcastle/logs/*.log | head -4 | xargs tail -n 5 -F    # this round only
```

The glob expands once — re-run it when a new `[implementer] Started` appears.

## While it runs — check on a cycle, not on a hunch

```bash
npx tsx .sandcastle/watch.mts                                   # one verdict, exit 1 if unhealthy
while :; do npx tsx .sandcastle/watch.mts; sleep 300; done      # every 5 min
```

It reads the run log, git, `ps` and `docker` and reports the failures that are
otherwise invisible for hours: two loops at once, no output for 20+ minutes (a
stalled or hung agent), a `✗`/`PromptError` pipeline failure, two iterations in
a row that merged nothing, the same issues planned twice, orphaned containers,
worktrees a dead run left dirty. Healthy output is one line.

Run it before answering "how's it going" — the run log's last ten lines look the
same whether the loop is working or spinning.

## When a run ends with no commits

In order, stop at the first that explains it:

1. Two runs at once (check 10) — the failure looks like random agent deaths.
2. `✗ <id> … failed:` lines in `run.log` — read the error, don't assume a model
   problem. A `PromptError` is a config bug: an arg no one passes, or a built-in
   (`TARGET_BRANCH`, `SOURCE_BRANCH`) being passed when the library supplies it.
3. Agents ran but committed nothing — usually the workspace hint: they ran checks
   in a directory with no tests, saw green, and had nothing to fix.
4. Work parked on a branch: `git log main..sandcastle/issue-<id> --oneline`. The
   merge phase only counts commits from the run that just happened, so a branch
   whose issue lost the `ISSUE_LABEL` never gets picked up again — merge it by
   hand or relabel the issue.
