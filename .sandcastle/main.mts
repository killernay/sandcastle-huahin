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
import { readFileSync } from "node:fs";
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

// 9router runs on the host; containers reach it via host.docker.internal.
// Everything routes through 9router — the user's subscription licenses live
// there, so all models (claude/gemini/kimi) are covered with no per-token cost.
const R9_URL = process.env.R9_URL ?? "http://host.docker.internal:20128";
const r9key = () => {
  try {
    return readFileSync(join(homedir(), ".9router/auth/cli-secret"), "utf8").trim();
  } catch {
    return process.env.R9_KEY ?? "";
  }
};

// ── Model routing (all via 9router, prefix required: cc/… ag/… kimi/…) ───────
// PLAN / REVIEW / MERGE: Claude Opus (reasoning + QC). IMPL: picked by the
// planner's per-issue difficulty — small/easy → agy (Gemini), large/hard →
// Kimi K3. Override any via env: MODEL_PLAN, MODEL_REVIEW, MODEL_MERGE,
// MODEL_IMPL_SMALL, MODEL_IMPL_LARGE.
const modelFor = (role: "PLAN" | "REVIEW" | "MERGE") =>
  process.env[`MODEL_${role}`] ?? "cc/claude-opus-4-8";
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
// Optional file holding the authoritative dependency/build order (e.g. a
// sprint-status.yaml or roadmap doc). Empty = no such file; the planner then
// orders by issue body/labels alone.
const DEP_ORDER_FILE = process.env.DEP_ORDER_FILE ?? "";

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
  let available: Set<string>;
  try {
    const res = await fetch(`${R9_URL.replace("host.docker.internal", "localhost")}/v1/models`, {
      headers: { Authorization: `Bearer ${r9key()}` },
    });
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    available = new Set((body.data ?? []).map((m) => m.id));
  } catch (e) {
    throw new Error(
      `Preflight failed: cannot reach 9router at ${R9_URL} (${(e as Error).message}). Is it running? Try: 9router`,
    );
  }

  // Hard requirement: the plan/review/merge models MUST be live — there's no
  // fallback for those phases, so a missing one aborts the run.
  const core = [modelFor("PLAN"), modelFor("REVIEW"), modelFor("MERGE")];
  const coreMissing = [...new Set(core)].filter((m) => !available.has(m));
  if (coreMissing.length > 0) {
    throw new Error(
      `Preflight: required (plan/review/merge) models not on 9router: ${coreMissing.join(", ")}\n` +
        `Available: ${[...available].sort().join(", ")}\n` +
        `Fix MODEL_PLAN/REVIEW/MERGE in .sandcastle/.env or re-enable in 9router.`,
    );
  }

  // Soft requirement: the two implementer tiers have mutual fallback, so a
  // missing one is fine as long as the OTHER is live. Warn, don't abort — the
  // per-issue fallback chain routes around the dead one (e.g. you turned off
  // Kimi → all IMPL work flows to agy automatically).
  const smallOk = available.has(IMPL_SMALL);
  const largeOk = available.has(IMPL_LARGE);
  if (!smallOk) console.warn(`⚠ Preflight: IMPL small model ${IMPL_SMALL} is offline — those jobs will fall back to ${IMPL_LARGE}.`);
  if (!largeOk) console.warn(`⚠ Preflight: IMPL large model ${IMPL_LARGE} is offline — those jobs will fall back to ${IMPL_SMALL}.`);
  if (!smallOk && !largeOk) {
    throw new Error(
      `Preflight: BOTH implementer models are offline (${IMPL_SMALL}, ${IMPL_LARGE}).\n` +
        `Available: ${[...available].sort().join(", ")}\n` +
        `Enable at least one in 9router, or point MODEL_IMPL_SMALL/LARGE at a live model.`,
    );
  }

  const liveList = [...new Set([...core, IMPL_SMALL, IMPL_LARGE])].filter((m) => available.has(m));
  console.log(`Preflight OK — live on 9router: ${liveList.join(", ")}`);
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
const dockerWithStore = () =>
  docker({
    mounts: [{ hostPath: ".sandcastle/pnpm-store", sandboxPath: STORE }],
    env: { ANTHROPIC_BASE_URL: R9_URL, ANTHROPIC_API_KEY: r9key() },
  });

// Hooks run inside the sandbox before the agent starts each iteration.
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command: `${CD_WS}pnpm config set store-dir ${STORE} && pnpm install`,
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
// agent env) — it rides on dockerWithStore(model) instead. This just picks the
// model id and CLI. Used for PLAN/REVIEW/MERGE; IMPL uses implChain(size).
const agent = (model: string) => sandcastle.claudeCode(model);

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Fail fast if any configured model is missing from 9router (expired sub, etc.)
// Fail fast if required models are missing; capture the live set so the
// fallback chain can skip a known-dead implementer model.
liveModels = await preflightModels();

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
    sandbox: dockerWithStore(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    agent: agent(modelFor("PLAN")),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: {
      ISSUE_LABEL,
      PROJECT_RULES,
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
        sandbox: dockerWithStore(),
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
        if (!implement) throw lastErr ?? new Error(`all impl models failed for ${issue.id}`);

        // Only review if the implementer produced commits
        if (implement.commits.length > 0) {
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

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
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
    sandbox: dockerWithStore(),
    name: "merger",
    maxIterations: 1,
    agent: agent(modelFor("MERGE")),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
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
