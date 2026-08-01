// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
      // Planner's difficulty call → picks the implementer model.
      // "small" = CRUD/filter/config → agy; "large" = new subsystem, tricky
      // schema/security/algorithm → Kimi K3. Defaults to small if omitted.
      size: z.enum(["small", "large"]).default("small"),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
const MAX_ITERATIONS = 10;

// Load .sandcastle/.env into this process so MODEL_* presets set there take
// effect. Sandcastle's resolver only forwards .env into the *sandbox*, not into
// this host script — so without this, MODEL_* in .env would silently do nothing.
// Inline env (MODEL_IMPL_SMALL=… npm run) still wins; we don't overwrite set vars.
// ponytail: 6-line parser beats adding a dotenv dependency.
for (const line of (() => {
  try {
    return readFileSync(join(process.cwd(), ".sandcastle", ".env"), "utf8").split("\n");
  } catch {
    return [];
  }
})()) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ── Sandbox choice (set SANDBOX in .sandcastle/.env) ─────────────────────────
// docker (default): agents run isolated in the sandcastle image — build it
//   once per repo with `npx sandcastle docker build-image`.
// none: agents run straight on the host. No Docker needed, but NO isolation,
//   and the agent keeps its normal permission prompts — under nohup an
//   unapproved tool call HANGS the run silently. Pre-allowlist what the agent
//   needs in .claude/settings.json before going AFK on this.
const SANDBOX = process.env.SANDBOX ?? "docker";
if (SANDBOX !== "docker" && SANDBOX !== "none")
  throw new Error(`SANDBOX must be "docker" or "none", got "${SANDBOX}"`);

// 9router runs on the host; containers reach it via host.docker.internal,
// host-run agents (SANDBOX=none) via localhost.
// Everything routes through 9router — the user's subscription licenses live
// there, so all models (claude/gemini/kimi) are covered with no per-token cost.
const R9_URL =
  process.env.R9_URL ??
  (SANDBOX === "none" ? "http://localhost:20128" : "http://host.docker.internal:20128");
const r9key = () => {
  try {
    return readFileSync(join(homedir(), ".9router/auth/cli-secret"), "utf8").trim();
  } catch {
    return process.env.R9_KEY ?? "";
  }
};

// ── Model routing (all via 9router, prefix required: cc/… ag/… kimi/…) ───────
// PLAN: Claude Fable (reasoning). REVIEW / MERGE: Claude Opus (QC). IMPL: picked by the
// planner's per-issue difficulty — small/easy → agy (Gemini), large/hard →
// Kimi K3. Override any via env: MODEL_PLAN, MODEL_REVIEW, MODEL_MERGE,
// MODEL_IMPL_SMALL, MODEL_IMPL_LARGE.
const modelFor = (role: "PLAN" | "REVIEW" | "MERGE") =>
  process.env[`MODEL_${role}`] ?? (role === "PLAN" ? "cc/claude-fable-5" : "cc/claude-opus-5");
const IMPL_SMALL = process.env.MODEL_IMPL_SMALL ?? "ag/gemini-3.1-pro-low";
const IMPL_LARGE = process.env.MODEL_IMPL_LARGE ?? "kimi/kimi-k3";

// ── Project layout (parametrized so this harness drops into any repo) ────────
// WORKSPACE_DIR: subdirectory holding the pnpm/package.json workspace, relative
// to repo root. Empty = the workspace IS the repo root. e.g. a monorepo
// might set "apps/web".
// Set in .sandcastle/.env per project.
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "";
// Shell prefix to enter the workspace ("" when it's the root, else "cd <dir> && ").
const CD_WS = WORKSPACE_DIR ? `cd ${WORKSPACE_DIR} && ` : "";

// GitHub label the planner filters open issues by (your "ready for the agent"
// signal). Defaults to "ready-for-agent".
const ISSUE_LABEL = process.env.ISSUE_LABEL ?? "ready-for-agent";
// Where the planner gets its issues (formats live in list-issues.mts):
// github (default) = gh issue list by ISSUE_LABEL; local = .sandcastle/issues/*.md,
// no GitHub or GH_TOKEN involved at all.
const ISSUE_SOURCE = process.env.ISSUE_SOURCE ?? "github";
if (ISSUE_SOURCE !== "github" && ISSUE_SOURCE !== "local")
  throw new Error(`ISSUE_SOURCE must be "github" or "local", got "${ISSUE_SOURCE}"`);
// Optional file holding the authoritative dependency/build order (e.g. a
// sprint-status.yaml or roadmap doc). Empty = no such file; the planner then
// orders by issue body/labels alone.
const DEP_ORDER_FILE = process.env.DEP_ORDER_FILE ?? "";

// How many issues the planner may take per round. Each one runs an implementer
// and a reviewer in its own sandbox, so this is the loop's parallelism dial.
// The ceiling is rarely the machine (agents spend most of their time waiting on
// the model): it's your gateway's throughput, and how often two issues touching
// the same module collide in the merge.
const BATCH_SIZE = process.env.BATCH_SIZE ?? "3";

// What every agent is told about repo layout and how to run checks. This is
// load-bearing, not boilerplate: a generic hint is a false-green risk — an agent
// that runs `pnpm test` at a root with no test script gets exit 0 and reports
// success. Projects override it with .sandcastle/workspace-hint.md (real script
// names, real gotchas); the default below only knows WORKSPACE_DIR.
// ponytail: a file beats a multi-line .env value; absent = generated default.
const WORKSPACE_HINT = (() => {
  try {
    return readFileSync(join(process.cwd(), ".sandcastle", "workspace-hint.md"), "utf8").trim();
  } catch {
    return WORKSPACE_DIR
      ? `The workspace lives in \`${WORKSPACE_DIR}/\` — **not** the repo root. Run every ` +
          `check from there: \`${CD_WS}pnpm typecheck && pnpm test\`, and both must pass ` +
          `before you commit.\n\nThe repo root is not the workspace: \`pnpm test\` there ` +
          `finds no tests and exits clean — that is NOT a green build.`
      : `Run \`pnpm typecheck && pnpm test\` (or this repo's equivalent — read the ` +
          `\`scripts\` in package.json) before committing. A command that finds no tests ` +
          `and exits clean is NOT a green build.`;
  }
})();

// Selection rules only this project knows — which epics are finished, which are
// blocked on someone outside the repo, which stories are deliberately deferred.
// Lives in a file, not in plan-prompt.md, so re-syncing the harness from the
// template can't silently delete a project's planning knowledge.
const PROJECT_RULES = (() => {
  try {
    const body = readFileSync(join(process.cwd(), ".sandcastle", "planning-rules.md"), "utf8").trim();
    return body ? `# PROJECT RULES (override the generic rules above)\n\n${body}` : "";
  } catch {
    return "";
  }
})();

// Is there anything on this branch to merge? Asked of git on the host, not of
// the run: sandbox.run() reports only the commits IT produced, so a branch whose
// work landed in an earlier round is invisible to it. Branches are reused, so
// that case is normal — the implementer opens the branch, finds the job already
// done, and correctly commits nothing. Gating the merge on the run's own commits
// then drops a finished branch, the merge never happens, the issue stays open,
// and the next round plans the same work again. Every iteration, forever.
// ponytail: git already knows; don't infer it from what the agent returned.
const BASE_BRANCH = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
const commitsAhead = (branch: string) => {
  try {
    return Number(execSync(`git rev-list --count ${BASE_BRANCH}..${branch}`, { encoding: "utf8" }).trim());
  } catch {
    return 0; // branch doesn't exist yet — nothing to merge
  }
};

// Seconds to wait before re-running an issue whose every model was rate-limited.
// Provider windows observed in practice: kimi ~1-2 min, gemini a few minutes.
const RATE_LIMIT_WAIT_S = Number(process.env.RATE_LIMIT_WAIT_S ?? 90);

// Is this failure "come back later" rather than "this is broken"? Providers say
// it in their own words, so match on what they actually send.
// ponytail: string matching, because the error crosses an Effect/CLI boundary
// that drops the status code. A false positive costs one extra wait.
const isRateLimited = (e: unknown) =>
  /429|RESOURCE_EXHAUSTED|rate.?limit|quota|usage limit|too many requests/i.test(
    (e as Error)?.message ?? String(e),
  );

// Models preflight found live on 9router (set by preflightModels()). Used to
// skip a known-dead model in the fallback chain instead of wasting a run on it.
let liveModels: Set<string> | null = null;

// Fallback chain per size: preferred model first, then the sibling tier — so a
// dead k3 still gets the work done by agy. We drop any model preflight already
// knows is offline; if that empties the list, fall back to the raw pair (the
// per-run try/catch still guards it).
// ponytail: one retry with the sibling model beats a per-issue dead pipeline.
const implChain = (size: "small" | "large") => {
  const raw = size === "large" ? [IMPL_LARGE, IMPL_SMALL] : [IMPL_SMALL, IMPL_LARGE];
  const live = liveModels;
  if (!live) return raw;
  const filtered = raw.filter((m) => live.has(m));
  return filtered.length > 0 ? filtered : raw;
};

// Preflight: confirm every model we intend to use is actually live on 9router
// right now. Models come and go (a subscription lapses, k3 gets retired) — this
// catches a dead model id up front with a clear message instead of burning a
// planning run only to have the implementer error "model may not exist".
// ponytail: one GET before the loop beats a failed sandbox mid-run.
const preflightModels = async () => {
  const gateway = R9_URL.replace("host.docker.internal", "localhost");
  let listed: Set<string>;
  try {
    const res = await fetch(`${gateway}/v1/models`, { headers: { Authorization: `Bearer ${r9key()}` } });
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    listed = new Set((body.data ?? []).map((m) => m.id));
  } catch (e) {
    throw new Error(
      `Preflight failed: cannot reach 9router at ${R9_URL} (${(e as Error).message}). Is it running? Try: 9router`,
    );
  }

  // Two checks, because each misses what the other catches. The listing catches
  // an id that is wrong or retired. The ping catches an account that is listed
  // but rate-limited or unauthorized — it answers 403/429 the moment an agent
  // uses it, which reads as the agent failing, one wasted round per issue.
  // A ping alone is not enough: the gateway happily returns 200 for a model id
  // that doesn't exist, because the upstream provider accepts the name.
  const ping = async (id: string) => {
    if (!listed.has(id)) return "not on the gateway (check the id)";
    try {
      const res = await fetch(`${gateway}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${r9key()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      if (res.ok) return null;
      const text = (await res.text()).replace(/\s+/g, " ").slice(0, 120);
      return `${res.status} ${text}`;
    } catch (e) {
      return (e as Error).message;
    }
  };

  const wanted = [...new Set([modelFor("PLAN"), modelFor("REVIEW"), modelFor("MERGE"), IMPL_SMALL, IMPL_LARGE])];
  const results = await Promise.all(wanted.map(async (id) => [id, await ping(id)] as const));
  const failures = new Map(results.filter(([, err]) => err !== null) as Array<[string, string]>);
  const available = new Set(results.filter(([, err]) => err === null).map(([id]) => id));
  for (const [id, err] of failures) console.warn(`⚠ Preflight: ${id} answered ${err}`);

  // Hard requirement: the plan/review/merge models MUST be live — there's no
  // fallback for those phases, so a missing one aborts the run.
  const core = [modelFor("PLAN"), modelFor("REVIEW"), modelFor("MERGE")];
  const coreMissing = [...new Set(core)].filter((m) => !available.has(m));
  if (coreMissing.length > 0) {
    throw new Error(
      `Preflight: plan/review/merge models did not answer (no fallback for those phases):\n` +
        coreMissing.map((m) => `  ${m} → ${failures.get(m)}`).join("\n") +
        `\nAnswering: ${[...available].sort().join(", ") || "(none)"}\n` +
        `Fix MODEL_PLAN/REVIEW/MERGE in .sandcastle/.env, or wait if that is a rate limit.`,
    );
  }

  // Soft requirement: the two implementer tiers have mutual fallback, so a
  // missing one is fine as long as the OTHER is live. Warn, don't abort — the
  // per-issue fallback chain routes around the dead one (e.g. you turned off
  // Kimi → all IMPL work flows to agy automatically).
  const smallOk = available.has(IMPL_SMALL);
  const largeOk = available.has(IMPL_LARGE);
  if (!smallOk) console.warn(`⚠ Preflight: IMPL small ${IMPL_SMALL} not answering — those jobs fall back to ${IMPL_LARGE}.`);
  if (!largeOk) console.warn(`⚠ Preflight: IMPL large ${IMPL_LARGE} not answering — those jobs fall back to ${IMPL_SMALL}.`);
  if (!smallOk && !largeOk) {
    throw new Error(
      `Preflight: neither implementer model answered:\n` +
        `  ${IMPL_SMALL} → ${failures.get(IMPL_SMALL)}\n  ${IMPL_LARGE} → ${failures.get(IMPL_LARGE)}\n` +
        `Enable at least one, point MODEL_IMPL_SMALL/LARGE at a live model, or wait out the rate limit.`,
    );
  }

  const liveList = [...new Set([...core, IMPL_SMALL, IMPL_LARGE])].filter((m) => available.has(m));
  console.log(`Preflight OK — answering: ${liveList.join(", ")}`);
  return available;
};

// Persistent shared pnpm store (mounted OUTSIDE the worktree) + the 9router
// gateway env — both baked at container-create time via the SANDBOX provider.
// This is load-bearing: createSandbox() starts the container with
// agentProviderEnv:{}, DROPPING any env passed to claudeCode(). So the gateway
// env MUST ride on the sandbox provider, else the in-sandbox `claude` CLI never
// sees ANTHROPIC_BASE_URL and errors "model may not exist".
// ponytail: sandbox env = the only spot createSandbox actually forwards.
const STORE = "/home/agent/pnpm-store";
// What the sandbox runs once, before the agent starts, to make the repo
// buildable. pnpm by default because that's what the shipped Dockerfile
// installs; an npm/yarn/bun project overrides it in .env rather than editing
// this file, which a harness re-sync would overwrite.
const INSTALL_CMD =
  process.env.INSTALL_CMD ??
  (SANDBOX === "none"
    ? // The host keeps its own pnpm store — rewiring store-dir here would
      // mutate the user's global pnpm config.
      `${CD_WS}pnpm install`
    : `${CD_WS}pnpm config set store-dir ${STORE} && pnpm install`);
const makeSandbox = () => {
  if (SANDBOX === "none")
    return noSandbox({ env: { ANTHROPIC_BASE_URL: R9_URL, ANTHROPIC_API_KEY: r9key() } });
  // The store is gitignored, so a fresh install has no dir yet — and docker
  // refuses to mount a hostPath that doesn't exist.
  mkdirSync(".sandcastle/pnpm-store", { recursive: true });
  return docker({
    mounts: [{ hostPath: ".sandcastle/pnpm-store", sandboxPath: STORE }],
    env: { ANTHROPIC_BASE_URL: R9_URL, ANTHROPIC_API_KEY: r9key() },
  });
};

// Hooks run inside the sandbox before the agent starts each iteration.
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command: INSTALL_CMD,
        timeoutMs: 300_000,
      },
    ],
  },
};

// pnpm uses symlinks into a global store, so copying host node_modules breaks
// the links inside the sandbox. Rely on `pnpm install` in the hook instead.
// ponytail: empty = no copy; pnpm install (hook) rebuilds cleanly in-sandbox.
const copyToWorktree: string[] = [];

// Build a claudeCode agent. 9router env is NOT set here (createSandbox drops
// agent env) — it rides on makeSandbox() instead. This just picks the
// model id and CLI. Used for PLAN/REVIEW/MERGE; IMPL uses implChain(size).
const agent = (model: string) => sandcastle.claudeCode(model);

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Fail fast if any configured model is missing from 9router (expired sub, etc.)
// Fail fast if required models are missing; capture the live set so the
// fallback chain can skip a known-dead implementer model.
liveModels = await preflightModels();

// Worktrees are reused across runs. One left dirty by a killed run hands the
// next implementer a tree it didn't write — half-finished edits it will read as
// its own prior work, commit around, or "fix". Refuse to start instead: the
// cleanup is one command, but the confusion it causes looks like a model going
// haywire. ponytail: report and stop; deleting someone's work is not our call.
const dirtyWorktrees = (() => {
  try {
    return readdirSync(join(process.cwd(), ".sandcastle", "worktrees"))
      .filter((name) => {
        const path = join(process.cwd(), ".sandcastle", "worktrees", name);
        try {
          // Agents leave their own runtime droppings in the tree (.claude/).
          // Blocking a run on those trains you to ignore the guard.
          return execSync(`git -C ${path} status --porcelain`, { encoding: "utf8" })
            .split("\n")
            .some((l) => l.trim() !== "" && !/^\?\?\s+\.claude\//.test(l));
        } catch {
          return false; // not a worktree (or already gone) — leave it alone
        }
      });
  } catch {
    return []; // no worktrees dir yet — first run
  }
})();
if (dirtyWorktrees.length > 0) {
  throw new Error(
    `Uncommitted changes in reused worktree(s): ${dirtyWorktrees.join(", ")}\n` +
      `A previous run was killed mid-edit. Inspect, then either commit the work on its\n` +
      `branch or discard it:\n` +
      dirtyWorktrees
        .map((n) => `  git -C .sandcastle/worktrees/${n} status`)
        .join("\n") +
      `\n  rm -rf .sandcastle/worktrees && git worktree prune   # discard all of it`,
  );
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: makeSandbox(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    agent: agent(modelFor("PLAN")),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: {
      ISSUE_LABEL,
      PROJECT_RULES,
      BATCH_SIZE,
      // The dep-order file's CONTENT, read on the host, or a note when there
      // isn't one. It must be content, not a "!`cat …`" shell block: the library
      // only expands shell blocks written literally in the prompt file and
      // strips its marker from promptArgs values, so an injected block would
      // reach the planner as literal backtick text.
      DEP_ORDER_BLOCK: DEP_ORDER_FILE
        ? (() => {
            try {
              return readFileSync(join(process.cwd(), DEP_ORDER_FILE), "utf8");
            } catch {
              return `(dependency-order file ${DEP_ORDER_FILE} not found)`;
            }
          })()
        : "(No dependency-order file configured — order by issue body, labels, and dependencies.)",
    },
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(
      `  ${issue.id}: ${issue.title} → ${issue.branch}  [${issue.size} → ${implChain(issue.size)[0]}]`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: makeSandbox(),
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer — model picked by difficulty, with sibling-model
        // fallback if the run throws (e.g. 9router drops the model mid-flight).
        const chain = implChain(issue.size);
        let implement:
          | Awaited<ReturnType<typeof sandbox.run>>
          | undefined;
        let lastErr: unknown;
        // A provider rate limit is not a dead model — the windows are short
        // (minutes). Losing a whole issue to one is pure waste, so when every
        // model in the chain is rate-limited we wait once and run it again.
        for (let pass = 0; pass < 2 && !implement; pass++) {
          if (pass > 0) {
            console.warn(`  ⏳ ${issue.id}: every model rate-limited — waiting ${RATE_LIMIT_WAIT_S}s and retrying once`);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_S * 1000));
          }
        for (const model of chain) {
          try {
            implement = await sandbox.run({
              name: "implementer",
              maxIterations: 100,
              agent: agent(model),
              promptFile: "./.sandcastle/implement-prompt.md",
              promptArgs: {
                TASK_ID: issue.id,
                ISSUE_TITLE: issue.title,
                BRANCH: issue.branch,
                WORKSPACE_HINT,
              },
            });
            if (model !== chain[0]) {
              console.warn(`  ⚠ ${issue.id}: primary ${chain[0]} failed, succeeded on fallback ${model}`);
            }
            break;
          } catch (e) {
            // A missing/blank prompt arg is a config bug, not a model failure —
            // no other model can fix it. Retrying buries it as "model failed"
            // once per fallback × issue × iteration, then prints "Execution
            // complete". Fail on the first one instead.
            if ((e as Error).message?.includes("Prompt argument")) throw e;
            lastErr = e;
            console.warn(`  ⚠ ${issue.id}: implementer on ${model} threw (${(e as Error).message}); trying next model`);
          }
        }
          // Only the rate-limit case earns the second pass. Anything else will
          // fail exactly the same way in 90 seconds.
          if (!implement && !isRateLimited(lastErr)) break;
        }
        if (!implement) throw lastErr ?? new Error(`all impl models failed for ${issue.id}`);

        // Review whenever the branch carries work — including work committed in
        // an earlier round that was never merged, which this round is about to.
        if (commitsAhead(issue.branch) > 0) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: agent(modelFor("REVIEW")),
            promptFile: "./.sandcastle/review-prompt.md",
            // review-prompt.md also uses {{TARGET_BRANCH}} (and {{SOURCE_BRANCH}}
            // is available). Do NOT pass them: they are BUILT-IN args the
            // library injects itself (TARGET_BRANCH = the host's branch), and
            // passing one is a hard PromptError, not an override.
            promptArgs: {
              TASK_ID: issue.id,
              BRANCH: issue.branch,
              WORKSPACE_HINT,
            },
          });

          // Merge commits from both runs so the merge phase sees all of them.
          // Each sandbox.run() only returns commits from its own run.
          return {
            ...review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        return implement;
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Every pipeline dying is systemic (bad config, dead gateway, broken prompt) —
  // not "the agents had nothing to commit". Nine more quiet iterations won't
  // fix it, and finishing with "All done." hides the failure. Stop here.
  // ponytail: loud over resilient — with a single planned issue, one flaky run
  // also stops the loop. Rerunning is one command; a silent AFK night isn't.
  const rejected = settled.filter((o) => o.status === "rejected");
  if (rejected.length === settled.length) {
    throw new Error(
      `All ${settled.length} issue pipeline(s) failed this iteration — aborting.\n` +
        `First error: ${(rejected[0] as PromiseRejectedResult).reason}`,
    );
  }

  // Pass every branch that is ahead of the base branch to the merge phase —
  // whether the commits landed this round or an earlier one. A pipeline that
  // threw is excluded: its branch may be half-written.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        commitsAhead(entry.issue.branch) > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: makeSandbox(),
    name: "merger",
    maxIterations: 1,
    agent: agent(modelFor("MERGE")),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
      // How the merger marks an issue done. For local issues the git mv rides
      // the merge commit back to the host repo — that IS the "closed" state.
      CLOSE_CMD:
        ISSUE_SOURCE === "local"
          ? "`mkdir -p .sandcastle/issues/done && git mv .sandcastle/issues/<ID>.md " +
            ".sandcastle/issues/done/<ID>.md` — include this move in your merge commit"
          : '`gh issue close <ID> --comment "Completed by Sandcastle"`',
      WORKSPACE_HINT,
      // Tell the merger to write completed stories back to the dep-order file so
      // the next planning round doesn't treat finished work as pending. Only when
      // a DEP_ORDER_FILE is configured — otherwise there's nothing to update.
      DEP_UPDATE_BLOCK: DEP_ORDER_FILE
        ? `# UPDATE DEPENDENCY STATUS\n\n` +
          `The planner reads \`${DEP_ORDER_FILE}\` to know which stories are done. ` +
          `If you don't update it, the next planning round will think finished ` +
          `stories are still pending and stall.\n\n` +
          `For every story you just merged, find its entry in that file and mark ` +
          `it done (match by the \`<epic>-<story>\` number from the issue title). ` +
          `If the file also tracks a parent/epic-level status, flip that to done ` +
          `once all of its non-blocked children are done. Do NOT touch entries ` +
          `marked BLOCKED or DEFERRED. Include this edit in the same merge commit.`
        : "",
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
