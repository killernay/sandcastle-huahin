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
