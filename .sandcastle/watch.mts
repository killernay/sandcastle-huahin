// Health check for a running (or just-finished) loop. Answers one question —
// "is this thing actually making progress right now?" — from the run log, git,
// ps and docker. Exits 0 when healthy, 1 when something needs a human.
//
//   npx tsx .sandcastle/watch.mts          # once
//   while :; do npx tsx .sandcastle/watch.mts; sleep 300; done
//
// Every rule here is a failure that actually happened and cost hours to notice,
// because the loop keeps printing cheerful lines while doing nothing useful.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Minutes without a single byte of new output before we call it stalled. Agents
// think for a long time between tool calls; 20 is quiet even for a slow one.
const STALL_MIN = Number(process.env.SANDCASTLE_STALL_MIN ?? 20);

const root = process.cwd();
const logDir = join(root, ".sandcastle", "logs");
const runLog = join(root, ".sandcastle", "run.log");
const sh = (cmd: string) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const problems: string[] = [];
const notes: string[] = [];

// ── Is exactly one loop running? ─────────────────────────────────────────────
// Two runs share .sandcastle/worktrees/, so one deletes the other's tree
// mid-edit. It surfaces as agents dying at random, which reads like anything
// but the real cause.
// ponytail: counts loops host-wide, not per repo — a second project running its
// own harness reads as a duplicate here. Confirm with the pid list before
// killing anything; matching each pid's cwd needs lsof and isn't worth it.
const runs = sh(`ps -eo pid,command | grep "[t]sx .sandcastle/main.mts" | wc -l`);
const runCount = Number(runs || 0);
if (runCount > 1) problems.push(`${runCount} loops running host-wide — if more than one is in THIS repo they will delete each other's worktrees. Check: ps -eo pid,lstart,command | grep "[t]sx .sandcastle/main.mts"`);

const log = (() => {
  try {
    return readFileSync(runLog, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  } catch {
    console.log("no .sandcastle/run.log — nothing has run in this repo yet");
    process.exit(runCount > 1 ? 1 : 0);
  }
})();

// ── Is anything still being written? ─────────────────────────────────────────
// The stall case: an agent waiting on input nobody will type, or a sandbox that
// died without the loop noticing. Newest byte anywhere is the heartbeat.
const newest = (() => {
  let t = 0;
  try { t = statSync(runLog).mtimeMs; } catch {}
  try {
    for (const f of readdirSync(logDir)) {
      const m = statSync(join(logDir, f)).mtimeMs;
      if (m > t) t = m;
    }
  } catch {}
  return t;
})();
const idleMin = Math.round((Date.now() - newest) / 60000);
if (runCount > 0 && idleMin >= STALL_MIN) {
  problems.push(`no output for ${idleMin} min — the loop is running but nothing is being written. Check the newest log in .sandcastle/logs/.`);
}

// ── Did any pipeline throw? ──────────────────────────────────────────────────
const failures = log.split("\n").filter((l) => l.trimStart().startsWith("✗ "));
for (const f of failures.slice(-3)) problems.push(`pipeline failed: ${f.trim().slice(0, 160)}`);
if (/Prompt argument|PromptError/.test(log)) {
  problems.push(`PromptError in the log — that is a config bug (an arg no one passes, or a built-in being passed), not a model problem.`);
}

// ── Is it merging, or spinning? ──────────────────────────────────────────────
// The expensive silent failure: every iteration plans the same issues, finishes
// with 0 branches, merges nothing, and says "Execution complete" each time.
const iterations = [...log.matchAll(/=== Iteration (\d+)\/(\d+) ===/g)].map((m) => Number(m[1]));
const outcomes = [...log.matchAll(/Execution complete\. (\d+) branch\(es\)/g)].map((m) => Number(m[1]));
const zeroRuns = outcomes.slice(-2).filter((n) => n === 0).length;
if (outcomes.length >= 2 && zeroRuns === 2) {
  problems.push(`the last 2 iterations merged nothing — the loop is re-planning work it never lands. Check that finished branches are ahead of the base branch: git rev-list --count <base>..<branch>`);
} else if (outcomes.length >= 1 && outcomes[outcomes.length - 1] === 0) {
  notes.push(`last iteration produced 0 branches — one is normal (agents had nothing to commit), two in a row is not`);
}

// Same issues planned twice running is the other face of the same problem.
const plans = [...log.matchAll(/Planning complete\.[\s\S]*?(?=\n\[|\n===|$)/g)].map((m) =>
  [...m[0].matchAll(/^\s+(\d+):/gm)].map((i) => i[1]).sort().join(","),
);
if (plans.length >= 2 && plans[plans.length - 1] === plans[plans.length - 2] && plans[plans.length - 1] !== "") {
  notes.push(`the last 2 rounds planned the same issues (${plans[plans.length - 1]}) — expected only if their work is genuinely unfinished`);
}

// ── Leftovers ────────────────────────────────────────────────────────────────
const containers = Number(sh(`docker ps -q --filter name=sandcastle | wc -l`) || 0);
if (runCount === 0 && containers > 0) problems.push(`${containers} sandcastle container(s) running with no loop — orphaned. docker rm -f $(docker ps -aq --filter name=sandcastle)`);

// Worktrees are legitimately dirty while agents work in them; only a leftover
// from a dead run is a problem, and the next start will refuse to run anyway.
if (runCount === 0) {
  try {
    // Same rule as main.mts: agent runtime droppings under .claude/ don't count.
    const dirty = readdirSync(join(root, ".sandcastle", "worktrees")).filter((n) =>
      sh(`git -C .sandcastle/worktrees/${n} status --porcelain`)
        .split("\n")
        .some((l) => l.trim() !== "" && !/^\?\?\s+\.claude\//.test(l)),
    );
    if (dirty.length > 0) problems.push(`worktree(s) left dirty by a stopped run: ${dirty.join(", ")} — the next start will refuse until you clear them`);
  } catch {}
}

// ── Report ───────────────────────────────────────────────────────────────────
const base = sh("git rev-parse --abbrev-ref HEAD");
const iter = iterations.length ? `${iterations[iterations.length - 1]}` : "?";
const merged = outcomes.reduce((a, b) => a + b, 0);
console.log(
  `loop=${runCount} iteration=${iter} branches-merged=${merged} containers=${containers} idle=${idleMin}m base=${base}`,
);
for (const n of notes) console.log(`  note: ${n}`);
for (const p of problems) console.error(`  PROBLEM: ${p}`);
process.exit(problems.length > 0 ? 1 : 0);
