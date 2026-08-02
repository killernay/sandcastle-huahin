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
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG, configProblems } from "./config.mts";
import {
  completedBranches,
  implChain as pickImplChain,
  isDirtyWorktree,
  isRateLimited,
  livenessVerdict,
  wantsReview,
} from "./decisions.mts";

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

// Configuration and the rules the loop follows now live in their own modules:
// config.mts owns every knob (and validates them), decisions.mts owns the pure
// rules (fallback chain, liveness verdict, what counts as dirty). This file is
// the effects: containers, git, network, prompts.
const {
  CD_WS, WORKSPACE_DIR, ISSUE_LABEL, ISSUE_SOURCE, DEP_ORDER_FILE, BATCH_SIZE,
  MAX_ITERATIONS, SANDBOX, STORE, INSTALL_CMD, R9_URL, r9key,
  WORKSPACE_HINT, PROJECT_RULES, RATE_LIMIT_WAIT_S,
} = CONFIG;
const IMPL_SMALL = CONFIG.MODEL.IMPL_SMALL;
const IMPL_LARGE = CONFIG.MODEL.IMPL_LARGE;
const modelFor = (role: "PLAN" | "REVIEW" | "MERGE") => CONFIG.MODEL[role];

// Fail before the first token is spent, not deep inside a retry.
for (const problem of configProblems()) throw new Error(`Config: ${problem}`);

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

// Models preflight found live on 9router. Passed to the fallback chain so a
// known-dead model is skipped instead of costing a run.
let liveModels: Set<string> | null = null;

// The chain decision lives in decisions.mts; this file only supplies the facts.
const implChain = (size: "small" | "large") =>
  pickImplChain(size, { small: IMPL_SMALL, large: IMPL_LARGE }, liveModels);

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

  // The verdict itself lives in decisions.mts, so the preflight CLI cannot
  // predict something this loop won't do. Here we only report and abort.
  const verdict = livenessVerdict(available, {
    plan: modelFor("PLAN"), review: modelFor("REVIEW"), merge: modelFor("MERGE"),
    small: IMPL_SMALL, large: IMPL_LARGE,
  });
  for (const w of verdict.warnings) console.warn(`⚠ Preflight: ${w}`);
  if (verdict.fatal.length) {
    throw new Error(
      `Preflight:\n` + verdict.fatal.map((f) => `  ${f}`).join("\n") +
        `\nAnswering: ${[...available].sort().join(", ") || "(none)"}\n` +
        `Fix the MODEL_* ids in .sandcastle/.env, or wait if that is a rate limit.` +
        [...failures].map(([id, err]) => `\n  ${id} → ${err}`).join(""),
    );
  }

  console.log(`Preflight OK — answering: ${verdict.live.join(", ")}`);
  return available;
};

// Persistent shared pnpm store (mounted OUTSIDE the worktree) + the 9router
// gateway env — both baked at container-create time via the SANDBOX provider.
// This is load-bearing: createSandbox() starts the container with
// agentProviderEnv:{}, DROPPING any env passed to claudeCode(). So the gateway
// env MUST ride on the sandbox provider, else the in-sandbox `claude` CLI never
// sees ANTHROPIC_BASE_URL and errors "model may not exist".
// ponytail: sandbox env = the only spot createSandbox actually forwards.
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
// next implementer a tree it didn't write — half-finished edits it will read
// as its own prior work. An earlier version refused to start here and told a
// human to clean up, which turned every Ctrl-C into babysitting. Self-heal
// instead: commit whatever the dead agent left as a WIP on the issue's own
// branch (branch names are deterministic, so the next implementer for that
// issue resumes exactly there), then clear the worktree. Nothing is deleted
// that wasn't committed first.
try {
  const wtRoot = join(process.cwd(), ".sandcastle", "worktrees");
  for (const name of readdirSync(wtRoot)) {
    const path = join(wtRoot, name);
    let dirty = false;
    try {
      // Agents leave their own runtime droppings in the tree (.claude/) —
      // those alone don't count as work worth rescuing.
      dirty = isDirtyWorktree(execSync(`git -C ${path} status --porcelain`, { encoding: "utf8" }));
    } catch {
      continue; // not a worktree (or already gone) — leave it alone
    }
    if (!dirty) continue;
    let rescued = false;
    try {
      execSync(`git -C ${path} add -A -- . ':(exclude).claude'`, { stdio: "ignore" });
      execSync(`git -C ${path} commit -m "WIP: rescued from a killed run (auto-committed at startup)"`, { stdio: "ignore" });
      rescued = true;
    } catch {
      // nothing stageable beyond droppings — clearing is safe
    }
    rmSync(path, { recursive: true, force: true });
    try { execSync("git worktree prune", { stdio: "ignore" }); } catch { /* cosmetic */ }
    console.log(
      rescued
        ? `♻ ${name}: work from a killed run committed as WIP on its branch — the next implementer resumes there`
        : `♻ ${name}: cleared stale worktree (runtime droppings only)`,
    );
  }
} catch {
  // no worktrees dir yet — first run
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
    // "All done" has cried wolf before: tickets existed but wore no ready
    // label, or still wore `blocked` after their dependency shipped. Count
    // what the planner can't see, so the human can tell "backlog empty"
    // from "backlog invisible". Best-effort — never blocks the exit.
    try {
      if (ISSUE_SOURCE === "github") {
        const open = JSON.parse(
          execSync(
            `gh issue list --state open --limit 200 --json number,labels --jq "[.[] | {number, labels: [.labels[].name]}]"`,
            { encoding: "utf8" },
          ),
        ) as { number: number; labels: string[] }[];
        if (open.length > 0) {
          const ready = open.filter((i) => i.labels.includes(ISSUE_LABEL)).length;
          const invisible = open.length - ready;
          const blocked = open.filter((i) => i.labels.includes("blocked")).length;
          console.log(
            `⚠ Not the whole story: ${open.length} open issue(s) remain — ` +
              `${ready} labelled "${ISSUE_LABEL}" (the planner judged them dep-blocked this round), ` +
              `${invisible} INVISIBLE to the planner (no "${ISSUE_LABEL}"; ${blocked} labelled blocked). ` +
              `Label the next wave ready — \`blocked\` is for external holds only, the planner orders dependencies itself.`,
          );
        }
      } else {
        const n = readdirSync(join(process.cwd(), ".sandcastle", "issues")).filter((f) => f.endsWith(".md")).length;
        if (n > 0)
          console.log(`⚠ ${n} local issue file(s) remain in .sandcastle/issues/ — the planner judged them all dep-blocked this round.`);
      }
    } catch {
      // gh offline / no issues dir — the audit is a courtesy, not a gate
    }
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
        //
        // The reviewer is a second full agent: it opens the repo cold and reads
        // it again, so it roughly doubles a ticket's token cost. On a CRUD or
        // config ticket that is a poor trade; on schema, security or anything
        // the planner called `large` it is the whole point. REVIEW_SIZES picks
        // which tiers earn one — "large" is the frugal setting, "" skips review
        // entirely (you are then merging unreviewed agent code).
        const reviewing = wantsReview(issue.size, CONFIG.REVIEW_SIZES);
        if (!reviewing) console.log(`  ↷ ${issue.id}: review skipped (size=${issue.size}, REVIEW_SIZES=${CONFIG.REVIEW_SIZES.join(",") || "none"})`);
        if (reviewing && commitsAhead(issue.branch) > 0) {
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
    .filter((entry) => entry.outcome.status === "fulfilled")
    .map((entry) => entry.issue);
  const completedIssuesWithWork = completedBranches(completedIssues, commitsAhead);
  const branchesToMerge = completedIssuesWithWork.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${branchesToMerge.length} branch(es) with commits:`,
  );
  for (const branch of branchesToMerge) {
    console.log(`  ${branch}`);
  }

  if (branchesToMerge.length === 0) {
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
      BRANCHES: branchesToMerge.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssuesWithWork.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
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

  // Publish the round's work. Deliberately host-side deterministic code, not a
  // line in merge-prompt.md: pushing is a fixed action with real consequences,
  // and the sandbox has no push credentials anyway (the host's do). Opt-in —
  // an AFK loop that pushes unattended is a choice, not a default. Never fatal:
  // a rejected push (someone else moved the branch) must not kill a healthy run.
  if (CONFIG.AUTO_PUSH) {
    try {
      execSync("git push", { encoding: "utf8", stdio: "pipe" });
      console.log("Pushed to remote.");
    } catch (e) {
      console.log(`⚠ push failed (work is safe in local git): ${String((e as { stderr?: Buffer }).stderr ?? e).replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
}

console.log("\nAll done.");
