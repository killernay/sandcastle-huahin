# Swapping models per phase (agy / kimi / claude via 9router)

Each of the 4 phases picks its model from an env var. Unset = Opus on your
Claude subscription (free). Set a **9router model id** (contains a `/`) to route
that phase through the local 9router gateway instead.

## Env vars

| Var            | Phase        | Default (unset)   |
| -------------- | ------------ | ----------------- |
| `MODEL_PLAN`   | planner      | claude-opus-5   |
| `MODEL_IMPL`   | implementer  | claude-opus-5   |
| `MODEL_REVIEW` | reviewer     | claude-opus-5   |
| `MODEL_MERGE`  | merger       | claude-opus-5   |

A bare id (`claude-opus-5`) → native Claude subscription.
An id with `/` (`kimi/kimi-k2.7-code`, `ag/gemini-3.1-pro-low`, `cc/claude-opus-5`)
→ routed through 9router at `http://host.docker.internal:20128` using the key at
`~/.9router/auth/cli-secret`.

## 9router model ids (run `9router` then `curl localhost:20128/v1/models`)

- kimi:   `kimi/kimi-k2.7-code`, `kimi/kimi-k2.5-thinking`, `kimi/kimi-k3`
- gemini: `ag/gemini-3.1-pro-low`, `ag/gemini-pro-agent`, `ag/gemini-3-flash`
- claude: `cc/claude-opus-5`, `cc/claude-sonnet-5`, `ag/claude-opus-4-6-thinking`

## Recipes

```bash
# All Opus on subscription (default — just run it)
npm run sandcastle

# Cheap reviewer: Opus implements (subscription), Kimi reviews (9router)
MODEL_REVIEW=kimi/kimi-k2.7-code npm run sandcastle

# Everything on Kimi (fast/cheap, lower quality on hard tasks)
MODEL_PLAN=kimi/kimi-k3 MODEL_IMPL=kimi/kimi-k2.7-code \
MODEL_REVIEW=kimi/kimi-k2.5-thinking MODEL_MERGE=kimi/kimi-k2.7-code \
  npm run sandcastle

# Gemini implements, Opus reviews (catch Gemini's mistakes on subscription)
MODEL_IMPL=ag/gemini-3.1-pro-low npm run sandcastle

# Persist a combo: put the vars in .sandcastle/.env — dotenv loads them.
```

## Prereqs

- 9router running on the host: `9router` (listens on :20128). Verify:
  `curl -s localhost:20128/v1/models | head`
- Key auto-read from `~/.9router/auth/cli-secret`; override with `R9_KEY`.
- Gateway URL override: `R9_URL` (default `http://host.docker.internal:20128`).

## Cost note

- Native `claude-*` (no slash) = your Claude subscription (free, rate-limited per 5h).
- Anything through 9router = billed by that provider's key in 9router.
- Recommended: implementer on subscription Opus, reviewer on cheap Kimi.
