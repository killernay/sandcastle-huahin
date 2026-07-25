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
# 1. Drop the harness into your repo
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
| `DEP_ORDER_FILE` | Optional build-order file (e.g. BMAD sprint-status.yaml) | `` |
| `GH_TOKEN` | GitHub token (Issues R/W + Metadata R) | — |
| `MODEL_PLAN/REVIEW/MERGE` | Reasoning + QC models | `cc/claude-opus-4-8` |
| `MODEL_IMPL_SMALL` | Fast model for easy issues | `ag/gemini-3.1-pro-low` |
| `MODEL_IMPL_LARGE` | Strong model for hard issues | `kimi/kimi-k3` |

See `.sandcastle/MODELS.md` for the full routing guide.

## Pairs with BMAD (Matt Pocock's planning skills)

This harness is the **execution half**. The natural upstream is the **BMAD
Method** skills — the same ecosystem [Matt Pocock](https://github.com/mattpocock)
builds around Sandcastle. BMAD turns an idea into an ordered, agent-ready backlog;
sandcastle-huahin drains that backlog.

```
  ┌─────────────────────── BMAD (planning) ────────────────────────┐
  bmad-create-prd → bmad-create-epics-and-stories → bmad-sprint-planning
        │                                                    │
        ▼                                                    ▼
   PRD + epics                                    sprint-status.yaml
   as GitHub issues  ──────────┐        ┌──────── (dependency order)
   (labelled ready-for-agent)  │        │
                               ▼        ▼
  └────────────── sandcastle-huahin (execution) ──────────────────┘
     planner reads {{ISSUE_LABEL}} issues + DEP_ORDER_FILE
       → implementer → reviewer → merger → closes issues → re-plans
```

**How they connect — two config values:**

| BMAD produces | sandcastle-huahin reads via |
| --- | --- |
| GitHub issues labelled for the agent | `ISSUE_LABEL=ready-for-agent` |
| `_bmad-output/…/sprint-status.yaml` (build order) | `DEP_ORDER_FILE=…/sprint-status.yaml` |

So the typical full pipeline is:

1. **Plan with BMAD skills** (in your editor / Claude Code): `bmad-create-prd`
   → `bmad-create-epics-and-stories` → `bmad-sprint-planning`. This writes your
   epics/stories as GitHub issues and a `sprint-status.yaml` dependency order.
2. **Execute with this harness**: point `DEP_ORDER_FILE` at that yaml, set
   `ISSUE_LABEL` to your agent label, and run — the planner respects BMAD's
   epic/story order and only picks unblocked work.

**You don't need BMAD.** If you skip it, leave `DEP_ORDER_FILE` empty — the
planner then orders purely by each issue's body, labels, and stated
dependencies. BMAD just gives it a stronger, authoritative build order.

> Note: BMAD writes back to `sprint-status.yaml` during planning, but the
> execution loop's merger does **not** currently update it — so after a run,
> re-sync the yaml's `done` markers from `git log` (or re-run the relevant BMAD
> status step) before the next planning pass, or the planner may think finished
> stories are still pending.

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
