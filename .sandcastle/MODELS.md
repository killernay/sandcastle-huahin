# Swapping models per phase (agy / kimi / claude via 9router)

Each of the 4 phases picks its model from an env var. Unset = Opus on your
Claude subscription (free). Set a **9router model id** (contains a `/`) to route
that phase through the local 9router gateway instead.

## Env vars

| Var                | Phase       | Default            |
| ------------------ | ----------- | ------------------ |
| `MODEL_PLAN`       | planner     | `cc/claude-opus-5` |
| `MODEL_IMPL_SMALL` | implementer | `ag/gemini-3.1-pro-low` |
| `MODEL_IMPL_LARGE` | implementer | `kimi/kimi-k3`     |
| `MODEL_REVIEW`     | reviewer    | `cc/claude-opus-5` |
| `MODEL_MERGE`      | merger      | `cc/claude-opus-5` |

There are two implementer tiers, not one: the planner tags each issue
`small` or `large` and the model follows. A single combined implementer
variable does not exist; `config.test.mts` fails if a doc invents one.

Every id routes through 9router, including the Claude ones — the `cc/` prefix
is what says so. Defaults live in exactly one place, the knob table at the top
of `config.mts`; this table is checked against it by `config.test.mts`.

Values come from `.sandcastle/.env`, read by `config.mts` (one small parser, no
dotenv dependency). Inline env still wins: `MODEL_REVIEW=… npm run sandcastle`.

## Combos — one id, an ordered list of models

9router lets you define a **combo**: a virtual model holding real ones in
order, tried per call. Point `MODEL_*` at combos and no phase is ever a single
point of failure — a rate-limited provider costs one hop, not the run. This is
the recommended setup; see the README's "Point each phase at a 9router combo"
for the concrete lists and the reasoning.

```bash
MODEL_PLAN=plan          # combo: opus → sol
MODEL_REVIEW=opus        # combo: opus → sol-review
MODEL_MERGE=merge        # combo: opus → terra
MODEL_IMPL_SMALL=impl-small
MODEL_IMPL_LARGE=impl-large
```

Combos are edited in the 9router dashboard and take effect on the next call —
no `.env` edit, no restart. `check-models.mts` probes them like any other id.

## Recipes

```bash
# Defaults — just run it
npm run sandcastle

# Cheap reviewer: keep Opus planning, hand QC to Kimi
MODEL_REVIEW=kimi/kimi-k2.7-code npm run sandcastle

# Everything on Kimi (fast, cheaper, weaker on hard tickets)
MODEL_PLAN=kimi/kimi-k3 MODEL_IMPL_SMALL=kimi/kimi-k2.7-code \
MODEL_IMPL_LARGE=kimi/kimi-k3 MODEL_REVIEW=kimi/kimi-k2.5-thinking \
MODEL_MERGE=kimi/kimi-k2.7-code npm run sandcastle

# Gemini takes the easy tickets, Kimi keeps the hard ones
MODEL_IMPL_SMALL=ag/gemini-3.1-pro-low npm run sandcastle

# Skip review on easy tickets — roughly halves tokens per small ticket
REVIEW_SIZES=large npm run sandcastle

# Persist any of these: put them in .sandcastle/.env (config.mts reads it).
```

Check a combination before spending tokens on it:

```bash
npx tsx .sandcastle/check-models.mts   # every id must answer, not just be listed
npx tsx .sandcastle/config.mts         # what the loop will actually use
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
