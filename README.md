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

# 5. Run (AFK — survives terminal close)
nohup npm run sandcastle > .sandcastle/run.log 2>&1 &
tail -f .sandcastle/run.log
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

## Pairs with [mattpocock/skills](https://github.com/mattpocock/skills)

This harness is the **execution half**. It's built to sit downstream of
[Matt Pocock's skills](https://github.com/mattpocock/skills) — small, composable
agent skills for real engineering (planning, triage, PRDs, tickets) that work
with any model. Those skills turn an idea into a **labelled GitHub-issue backlog**;
sandcastle-huahin drains that backlog autonomously.

```
  ┌──────────── mattpocock/skills (planning, in your agent) ───────────┐
   idea → PRD → tickets → /triage (applies your agent label to issues)
                                          │
                                          ▼
                          GitHub issues labelled ready-for-agent
                                          │
  └──────────────── sandcastle-huahin (execution loop) ───────────────┘
     planner reads {{ISSUE_LABEL}} issues → picks ≤3, tags small/large
       → implementer → reviewer → merger → closes issues → re-plans
```

Install Matt's skills and run setup (from their README):

```bash
npx skills@latest add mattpocock/skills
# then in your agent: /setup-matt-pocock-skills
#   → choose GitHub as the issue tracker
#   → choose the label /triage applies to ready tickets
```

Whatever label you pick in `/triage`, put the same value in
`.sandcastle/.env` as `ISSUE_LABEL`. That's the only wiring needed — the skills
label the issues, this harness reads that label.

**Dependency order is optional.** If your planning flow also emits a build-order
file (a `sprint-status.yaml`, a roadmap doc, anything), point `DEP_ORDER_FILE`
at it and the planner will respect that order. If not, leave it empty — the
planner orders by each issue's body, labels, and stated dependencies alone.

**You don't need Matt's skills either.** Any workflow that produces GitHub issues
carrying a consistent label works. The skills just make the planning half
pleasant.

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
