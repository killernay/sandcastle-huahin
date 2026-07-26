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
- **Preflight + live-model fallback** — checks `GET /v1/models` before running.
  Plan/review/merge models are required; implementer models fall back to their
  sibling tier automatically if one is offline (e.g. you turned Kimi off).
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

# 4. Make sure 9router is running, then verify models are live
9router &
npx tsx .sandcastle/check-models.mts

# 5. Run (AFK — survives terminal close). ONE run per repo — see Monitoring.
nohup npm run sandcastle > .sandcastle/run.log 2>&1 &
tail -f .sandcastle/run.log
```

## Monitoring a run

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

## Configuration (`.sandcastle/.env`)

| Var | What | Default |
| --- | --- | --- |
| `WORKSPACE_DIR` | Subdir with the pnpm workspace (empty = repo root) | `` |
| `ISSUE_LABEL` | GitHub label the planner filters by | `ready-for-agent` |
| `DEP_ORDER_FILE` | Optional build-order file (e.g. a sprint-status.yaml / roadmap) | `` |
| `GH_TOKEN` | GitHub token (Issues R/W + Metadata R) | — |
| `MODEL_PLAN/REVIEW/MERGE` | Reasoning + QC models | `cc/claude-opus-4-8` |
| `MODEL_IMPL_SMALL` | Fast model for easy issues | `ag/gemini-3.1-pro-low` |
| `MODEL_IMPL_LARGE` | Strong model for hard issues | `kimi/kimi-k3` |

See `.sandcastle/MODELS.md` for the full routing guide.

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
                   tags each small/large           [cc/claude-opus-4-8]
       for each issue in parallel:
         implementer → writes code, commits        [agy | kimi, by size]
         reviewer    → QC, may add commits          [cc/claude-opus-4-8]
       merger    → merges all branches, closes issues [cc/claude-opus-4-8]
```

## Keeping up with upstream

The `@ai-hero/sandcastle` **library** and this **harness** update separately —
see [UPSTREAM.md](./UPSTREAM.md).

## License

Harness: MIT (yours to fork/share). The `@ai-hero/sandcastle` library keeps its
own license.
