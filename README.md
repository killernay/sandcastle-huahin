# sandcastle-huahin 🏖️

A batteries-included **[Sandcastle](https://github.com/mattpocock/sandcastle)
harness** that runs AFK coding agents against a GitHub-issue backlog, routed
entirely through a local **[9router](https://github.com/)** gateway.

Named after หัวหิน (Hua Hin) — because sandcastles belong on the beach.

Built on top of the `@ai-hero/sandcastle` library. This repo is **not a fork** —
it's the *harness* (the `main.mts` loop + prompts you customise), wired for:

- **9router routing** — every model (Claude / Gemini / Kimi) goes through your
  local 9router gateway. Your subscription licenses live there, so no per-token
  cost and one place to enable/disable models.
- **Difficulty-based model routing** — the planner tags each issue `small` or
  `large`; small/easy issues go to a fast cheap model (Gemini), large/hard ones
  to a stronger model (Kimi K3). Fully configurable.
- **Preflight that asks, not assumes** — every model must be listed *and* answer
  a one-token request before the run starts: a rate-limited account stays in
  `/v1/models`, and the gateway returns 200 for an id that doesn't exist, so
  either check alone lies. Plan/review/merge are required; implementer tiers fall
  back to each other, and an issue whose models were all rate-limited waits and
  runs again instead of being thrown away.
- **Project-agnostic** — workspace dir, issue label, and dependency-order file
  are all env-driven, so it drops into any repo.

## Quick start (new project)

```bash
# 1. Drop the harness into your repo.
#    `killernay/sandcastle-huahin/.sandcastle` is the SOURCE (this repo) — keep it
#    exactly. The trailing `.sandcastle` is the DESTINATION inside YOUR project.
cd your-project
npx degit killernay/sandcastle-huahin/.sandcastle .sandcastle

# 2. Configure
cp .sandcastle/.env.example .sandcastle/.env
$EDITOR .sandcastle/.env          # set WORKSPACE_DIR, ISSUE_LABEL, GH_TOKEN, …

# 3. Add the npm script + dep (if not present)
npm pkg set scripts.sandcastle="tsx .sandcastle/main.mts"
npm install -D @ai-hero/sandcastle tsx zod

# 4. Build the sandbox image (once per repo — the tag comes from the dir name).
#    Skip if you set SANDBOX=none in .env (host mode: no isolation — see table).
npx sandcastle docker build-image

# 5. Make sure 9router is running, then verify models + image
9router &
npx tsx .sandcastle/check-models.mts

# 6. Run (AFK — survives terminal close). ONE run per repo — see Monitoring.
nohup npm run sandcastle > .sandcastle/run.log 2>&1 &
tail -f .sandcastle/run.log
```

## Monitoring a run

The fast answer, before you read any log:

```bash
npx tsx .sandcastle/watch.mts                                 # exit 1 = needs a human
while :; do npx tsx .sandcastle/watch.mts; sleep 300; done    # a check cycle
```

One line when healthy. When not, it names the failure: two loops running at
once, no output for 20+ minutes, a `PromptError` (a config bug, not a model
one), two iterations in a row that merged nothing, the same issues planned
twice, orphaned containers, worktrees left dirty by a dead run. Each of those is
a real failure this harness has had, and every one of them looks like normal
progress in the log.


Two levels of log. `run.log` is the orchestrator's own narration — phases, the
plan, which branches produced commits. Each agent additionally writes its full
transcript to `.sandcastle/logs/<branch>-<role>.log`.

```bash
# Overview — what the loop is doing
tail -f .sandcastle/run.log

# Overview + every agent at once. Headers (==> file <==) mark who's talking;
# -n 5 keeps it from dumping tens of KB of history on start.
tail -n 5 -F .sandcastle/run.log .sandcastle/logs/*.log

# Just this round's agents (most recently written first)
ls -t .sandcastle/logs/*.log | head -4 | xargs tail -n 5 -F

# One agent, full detail
tail -f .sandcastle/logs/sandcastle-issue-89-implementer.log
```

The glob is expanded once, when you press enter: agent logs created *after* that
don't appear. Re-run the command when a new `[implementer] Started` line shows
up in `run.log`.

**Run only one loop per repo at a time.** Concurrent runs share
`.sandcastle/worktrees/` and `run.log`: one run's `sandbox.close()` deletes a
worktree while the other's agent is still working in it, so agents die with
"the cwd was deleted", commits go uncounted, and the two logs interleave into
something unreadable. Check before starting, and stop a run explicitly:

```bash
ps -eo pid,lstart,command | grep "[m]ain.mts"   # anything already running?
pkill -f "tsx .sandcastle/main.mts"             # stop it
```

### The pile of Docker containers is normal

Each issue in flight holds **two** containers — one from `createSandbox()`, one
from the agent's `sandbox.run()` — so a plan with 3 issues shows 6. Each pair is
bound to that issue's own worktree; they don't share state and don't collide.
The only shared thing is the pnpm store mount, and pnpm locks it itself.

```bash
docker ps --filter name=sandcastle --format "{{.Names}} {{.Status}}"   # what's live
docker ps -a --filter name=sandcastle -q | wc -l                       # leftovers?
docker rm -f $(docker ps -aq --filter name=sandcastle)                 # if any survived
```

Sandcastle removes its containers when the run ends — including after `pkill`,
so an empty list right after stopping is expected, not a sign the run never
started. The `sandcastle:<repo>` image (~2 GB) is built once and reused; leave it
unless you want the next run to rebuild from the `Dockerfile`.

## Configuration (`.sandcastle/.env`)

| Var | What | Default |
| --- | --- | --- |
| `WORKSPACE_DIR` | Subdir with the pnpm workspace (empty = repo root) | `` |
| `ISSUE_LABEL` | GitHub label the planner filters by | `ready-for-agent` |
| `DEP_ORDER_FILE` | Optional build-order file (e.g. a sprint-status.yaml / roadmap) | `` |
| `BATCH_SIZE` | Issues the planner may take per round (parallelism) | `3` |
| `INSTALL_CMD` | What the sandbox runs to make the repo buildable | pnpm install |
| `RATE_LIMIT_WAIT_S` | Pause before retrying an issue whose models were all rate-limited | `90` |
| `GH_TOKEN` | GitHub token (Issues R/W + Metadata R) | — |
| `SANDBOX` | `docker` = isolated image; `none` = on the host — no isolation, and permission prompts stay live (pre-allowlist in `.claude/settings.json` or an AFK run hangs) | `docker` |
| `ISSUE_SOURCE` | `github` = open issues by `ISSUE_LABEL`; `local` = files in `.sandcastle/issues/` — no GitHub or `GH_TOKEN` needed | `github` |
| `MODEL_PLAN` | Planner (reasoning) model | `cc/claude-fable-5` |
| `MODEL_REVIEW/MERGE` | QC models | `cc/claude-opus-5` |
| `MODEL_IMPL_SMALL` | Fast model for easy issues | `ag/gemini-3.1-pro-low` |
| `MODEL_IMPL_LARGE` | Strong model for hard issues | `kimi/kimi-k3` |

See `.sandcastle/MODELS.md` for the full routing guide.

## Local issues — run without GitHub

Set `ISSUE_SOURCE=local` in `.sandcastle/.env` and write one markdown file per
issue in `.sandcastle/issues/`:

```
.sandcastle/issues/
  T01-schema.md        # first line = title, rest = body
  T02-auth.md
  done/                # the merger moves finished issues here
```

- The filename stem is the issue id — keep it branch-safe (letters, digits,
  dashes): the work branch becomes `sandcastle/issue-T01-schema`.
- The planner reads the files exactly like GitHub issues. There are no labels
  in this mode, so `blocked`/`deferred` knowledge goes in `planning-rules.md`
  or the `DEP_ORDER_FILE` instead.
- "Closing" an issue = the merger `git mv`s its file into
  `.sandcastle/issues/done/` inside the merge commit.
- `GH_TOKEN` is not needed; nothing touches GitHub.

## `/sandcastle` — check an install, or set one up

`.sandcastle/skill/SKILL.md` is a Claude Code skill that audits a repo's harness
(files, deps, the three slots below, label, models, prompt wiring, whether a run
is already live, stray containers) and walks a new project through setup. It
ships inside `.sandcastle/`, so every install already has it. `install.sh` links
it for you; after a `degit` install, one line:

```bash
mkdir -p .claude/skills && ln -s ../../.sandcastle/skill .claude/skills/sandcastle
```

Project-scoped on purpose — a relative symlink inside the repo, nothing written
to `~/.claude`, and it follows the harness when you re-sync `.sandcastle`. Commit
it if your repo tracks `.claude/`; if `.claude/skills` is gitignored the link
still works, it just isn't shared with the team. Then `/sandcastle` in that repo: it reads config, never guesses
it — every answer comes from a command it runs.

## Project knowledge — the three things only you can tell it

The harness is generic on purpose: it knows how to plan, implement, review and
merge, but nothing about *your* repo. Three slots carry that knowledge, and they
are the three places to look when the agents do something dumb.

| Where | What goes in | Survives a re-sync? |
| --- | --- | --- |
| `.sandcastle/.env` | `WORKSPACE_DIR`, `ISSUE_LABEL`, `DEP_ORDER_FILE`, tokens | yes — never copied over |
| `.sandcastle/workspace-hint.md` | how to run this repo's checks (real script names) | yes — template ships no such file |
| `.sandcastle/planning-rules.md` | selection rules only you know (finished epics, work blocked on someone outside the repo, deliberately deferred stories) | yes — same |

Everything else in `.sandcastle/` — `main.mts`, the four prompts, `Dockerfile` —
is template code. **Editing those in place works until the day you pull a newer
harness on top and your edits vanish.** Project-specific content belongs in the
three slots above; that's what they exist for.

An empty slot is not an error, just less context: no `planning-rules.md` means
the planner orders by issue bodies, labels and `DEP_ORDER_FILE` alone.

### Tell the agents where the code is — `.sandcastle/workspace-hint.md`

Optional file, no placeholders, plain markdown. It replaces the generic
"run `pnpm typecheck && pnpm test`" hint given to the implementer, reviewer and
merger with this repo's real layout and script names:

```md
The app lives in `apps/web/` (pnpm workspace) — **not** the repo root.

- `cd apps/web && pnpm typecheck` — fastest signal, run it often
- `cd apps/web && pnpm ci` — lint + typecheck + test + build; must pass before you commit

The repo root has no tests. `pnpm test` there exits clean — that is not a green build.
```

Worth the five minutes: an agent that runs tests in a directory that has none
gets exit 0 and reports success. `check-models.mts` can't catch that; only this
file can.

### Tell the planner what you know — `.sandcastle/planning-rules.md`

Also optional, also plain markdown. It is appended to the planner's generic
selection rules as overrides, for the facts no issue tracker states out loud:

```md
- Skip anything under epic-11 (blocked on an external data owner), and stories
  tagged DEFERRED in the dependency-order file (e.g. 5-12, 5-13).
- Epics 1–4 are done. Work the lowest-numbered unfinished epic first.
- Story keys in the yaml look like `8-5-checklist-execution-mobile:` — match by
  the leading `<epic>-<story>` number in the issue title.
```

Without this the planner will happily select an issue that is technically
unblocked and practically dead — the loop then burns a full cycle on it.

## Pairs with [mattpocock/skills](https://github.com/mattpocock/skills)

This harness is the **execution half**. Matt Pocock's skills own the **planning
half** — turning a fuzzy idea into agent-ready, blocking-aware GitHub issues.
sandcastle-huahin then drains that backlog autonomously, in parallel, unattended.

Think of it as a swap for the final `/implement` step: instead of running
`/implement` by hand once per ticket, you point this loop at the labelled
backlog and let it plan → implement → review → merge → re-plan on its own.

### Do the planning FIRST, in one context window

Matt's [`ask-matt`](https://github.com/mattpocock/skills/blob/main/skills/engineering/ask-matt/SKILL.md)
router describes the **main flow: idea → ship**. Run these in your coding agent
(Claude Code / Codex), start to finish, *before* touching this harness:

```
/grill-with-docs   sharpen the idea by interview (writes CONTEXT.md + ADRs)
      │
      ▼
/to-spec           collapse the thread into a spec (PRD) on the tracker
      │
      ▼
/to-tickets        split the spec into tracer-bullet tickets, each declaring
                   its blocking edges — as native GitHub issues
      │
      ▼
/triage            (only for issues you did NOT create — bug reports, incoming
                   requests) move them to agent-ready + apply your agent label
```

> **Keep grill → to-spec → to-tickets in ONE unbroken context window** (don't
> `/compact` between them) so the spec and tickets build on the same thinking.
> That's Matt's rule, and it matters — the tickets are only as good as the
> shared context that produced them.

**Big, foggy effort** (greenfield, or a feature too large for one session)?
Start with [`/wayfinder`](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md)
instead — it charts a map of **decision tickets**, resolves them one at a time,
then hands off to `/to-spec` → `/to-tickets`. Don't point this harness at a
wayfinder map; wait until it's collapsed into real build tickets.

### Then hand the backlog to this loop

Once `/to-tickets` (± `/triage`) has produced labelled GitHub issues:

```bash
# one-time per repo
npx skills@latest add mattpocock/skills   # if you haven't
# /setup-matt-pocock-skills → choose GitHub tracker + your agent label

# then, instead of running /implement per ticket by hand:
nohup npm run sandcastle > .sandcastle/run.log 2>&1 &
```

sandcastle-huahin's planner reads the same issues, respects their blocking edges,
picks the unblocked ones, and runs the implement → review → merge cycle that
`/implement` would — just batched, parallel, and unattended.

### Wiring — one value

Whatever label `/triage` (or your `/setup-matt-pocock-skills` config) applies to
ready tickets, set the **same** value in `.sandcastle/.env` as `ISSUE_LABEL`.
That's the only required wiring — the skills label the issues, this harness reads
that label.

**Dependency order (optional).** `/to-tickets` writes blocking edges into each
issue body, which the planner already honours. If you *also* keep a separate
build-order file (a roadmap, a `sprint-status.yaml`), point `DEP_ORDER_FILE` at
it for a stronger authoritative order; otherwise leave it empty.

### All at once, or one at a time?

- **All at once (recommended):** finish the whole planning flow → get the full
  labelled backlog on GitHub → start the loop and let it drain everything, one
  unblocked batch per iteration. This is what the loop is for.
- **One ticket at a time:** you *can* label a single issue, let the loop do just
  that one, then plan the next — but that throws away the loop's parallelism and
  its blocker-aware ordering. Only do this when tickets are genuinely unknown
  until the previous one lands (i.e. you're really still *planning*, in which
  case `/wayfinder` is the better tool, not a one-ticket loop).

**You don't need Matt's skills at all.** Any workflow that produces GitHub issues
with a consistent label works. The skills just make the planning half pleasant.

## How the loop works

```
preflight (check models live on 9router)
  └─ for each iteration (max 10):
       planner   → reads open {{ISSUE_LABEL}} issues + dep-order → picks ≤3,
                   tags each small/large           [cc/claude-fable-5]
       for each issue in parallel:
         implementer → writes code, commits        [agy | kimi, by size]
         reviewer    → QC, may add commits          [cc/claude-opus-5]
       merger    → merges all branches, closes issues [cc/claude-opus-5]
```

## Keeping up with upstream

The `@ai-hero/sandcastle` **library** and this **harness** update separately —
see [UPSTREAM.md](./UPSTREAM.md).

## License

Harness: MIT (yours to fork/share). The `@ai-hero/sandcastle` library keeps its
own license.
