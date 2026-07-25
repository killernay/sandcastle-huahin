# Keeping up with upstream

There are **two independent things** that update on different schedules. Don't
confuse them.

## 1. The library — `@ai-hero/sandcastle` (npm)

This is the engine (`run()`, `createSandbox()`, `docker()`, providers). It's a
normal npm dependency. **You never git-merge it.**

```bash
# See what changed
npm view @ai-hero/sandcastle version          # latest published
npm ls @ai-hero/sandcastle                    # what you have

# Update
npm install -D @ai-hero/sandcastle@latest
npx tsx .sandcastle/check-models.mts          # smoke-test after upgrading
```

⚠️ If a major bump changes an API this harness uses (e.g. `docker()` options,
`createSandbox()` env handling, `sandbox.run()` signature), `main.mts` may need
edits. Check the library's CHANGELOG on a major bump. The load-bearing coupling
points in `main.mts` are commented with `ponytail:` and "load-bearing" notes —
grep for them:

```bash
grep -n 'load-bearing\|createSandbox\|agentProviderEnv' .sandcastle/main.mts
```

Known coupling (as of `@ai-hero/sandcastle` 0.12.0):
- **9router env must ride on the sandbox provider, not the agent.** `createSandbox()`
  starts the container with `agentProviderEnv:{}`, dropping any env passed to
  `claudeCode()`. We bake `ANTHROPIC_BASE_URL` into `dockerWithStore()` instead.
  If upstream starts forwarding agent env, this could be simplified.

## 2. The harness — this repo's `.sandcastle/`

The `main.mts` loop and the four prompts are **ours**. Matt's repo ships an
*example* harness under its own `.sandcastle/` that we originally based this on.
To see if he improved the example and cherry-pick ideas:

```bash
# One-time: add his repo as a reference remote (not for merging — for diffing)
git remote add upstream https://github.com/mattpocock/sandcastle.git
git fetch upstream

# See how his example harness diverged from ours
git diff upstream/main -- .sandcastle/     # if paths line up
# or browse his example directly:
#   https://github.com/mattpocock/sandcastle/tree/main/.sandcastle
```

Because our harness diverged heavily (9router, difficulty routing, preflight,
fallback), **you cannot auto-merge** his example — history is unrelated and the
files overlap. Port changes by hand: read his diff, decide if the idea helps,
apply it manually to our `main.mts` / prompts.

## Our changes vs. the stock example (so you know what's "ours")

- `main.mts`: 9router gateway env, `modelFor`/`implChain` difficulty routing,
  `preflightModels()`, per-issue sibling-model fallback, `.env` self-loading,
  `WORKSPACE_DIR`/`ISSUE_LABEL`/`DEP_ORDER_FILE` parametrization.
- `check-models.mts`: preflight CLI (new file).
- `plan-prompt.md`: emits `size` per issue; project-agnostic label + dep-order.
- `MODELS.md`: 9router routing guide (new file).

Version pinned when this harness was built: **`@ai-hero/sandcastle` 0.12.0**.
