// Preflight: everything that can be wrong before a run costs tokens — models
// that don't answer, a sandbox image nobody built, a GitHub token scoped to
// another repo, a prompt placeholder main.mts never passes.
//
// It shares config.mts and decisions.mts with the loop, so it cannot disagree
// with the thing it is meant to predict. It used to re-implement the model
// liveness policy and the .env parser, kept in step by a comment.
//
//   npx tsx .sandcastle/check-models.mts
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG, configProblems } from "./config.mts";
import { livenessVerdict } from "./decisions.mts";

const { PLAN, REVIEW, MERGE, IMPL_SMALL, IMPL_LARGE } = CONFIG.MODEL;
const local = (u: string) => u.replace("host.docker.internal", "localhost");

// Listed on the gateway is not the same as usable: a rate-limited account keeps
// its entry in /v1/models and only fails when an agent calls it. Ask each model
// for one token instead. (The reverse is true too — the gateway answers 200 for
// an id that doesn't exist — so both checks have to pass.)
let available = new Set<string>();
let reachable = false;
const answers = new Map<string, string>();
try {
  const res = await fetch(`${local(CONFIG.R9_URL)}/v1/models`, { headers: { Authorization: `Bearer ${CONFIG.r9key()}` } });
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const listed = new Set((body.data ?? []).map((m) => m.id));
  reachable = true;

  await Promise.all(
    [...new Set([PLAN, REVIEW, MERGE, IMPL_SMALL, IMPL_LARGE])].map(async (id) => {
      if (!listed.has(id)) return answers.set(id, "not on the gateway");
      try {
        const r = await fetch(`${local(CONFIG.R9_URL)}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${CONFIG.r9key()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        });
        if (r.ok) available.add(id);
        else answers.set(id, `${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 70)}`);
      } catch (e) {
        answers.set(id, (e as Error).message.slice(0, 70));
      }
    }),
  );
} catch (e) {
  console.error(`✗ cannot reach 9router at ${CONFIG.R9_URL} — is it running? (${(e as Error).message})`);
}

const live = (id: string) => (available.has(id) ? "answers ✓" : `✗ ${answers.get(id) ?? "MISSING"}`);
console.log("Phase          Model                      9router");
console.log("─".repeat(62));
for (const [phase, id] of [["PLAN", PLAN], ["IMPL (small)", IMPL_SMALL], ["IMPL (large)", IMPL_LARGE], ["REVIEW", REVIEW], ["MERGE", MERGE]] as const)
  console.log(`${phase.padEnd(14)} ${id.padEnd(26)} ${reachable ? live(id) : "?"}`);
console.log("─".repeat(62));
console.log(`9router key: ${CONFIG.r9key() ? "present ✓" : "MISSING ✗"}   reachable: ${reachable ? "yes ✓" : "NO ✗"}`);

// The sandbox image (SANDBOX=docker only). The library derives the tag from the
// repo dir name and only errors at the first container create — after the
// planner already spent tokens. Catch it here.
const IMAGE = `sandcastle:${basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_.-]/g, "-") || "local"}`;
let sandboxProblem = "";
if (CONFIG.SANDBOX === "docker") {
  try {
    execSync(`docker image inspect ${IMAGE}`, { stdio: "ignore" });
  } catch {
    try {
      execSync("docker info", { stdio: "ignore" });
      sandboxProblem = `image ${IMAGE} MISSING ✗ — build it: npx sandcastle docker build-image`;
    } catch {
      sandboxProblem = "docker daemon not running ✗";
    }
  }
  console.log(`Sandbox img: ${IMAGE} ${sandboxProblem ? "✗" : "present ✓"}`);
} else {
  console.log("Sandbox:     none — agents run on the host (no image; pre-allowlist permissions or a nohup run hangs)");
}

// GH_TOKEN vs THIS repo. A fine-grained PAT is scoped per-repo: one minted for
// another project authenticates fine but 404s here — and that surfaces as
// "Could not resolve to a Repository" deep inside the planner's first gh call.
// ponytail: repo parse breaks on dots in repo names; none of ours have them.
let ghProblem = "";
if (CONFIG.ISSUE_SOURCE === "github") {
  let ghRepo = "";
  if (process.env.GH_TOKEN) {
    try {
      ghRepo = execSync("git remote get-url origin", { encoding: "utf8" }).trim().match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1] ?? "";
      if (ghRepo) execSync(`gh api repos/${ghRepo}`, { stdio: "ignore" });
    } catch {
      ghProblem = `can't see ${ghRepo} ✗ — grant this repo to the fine-grained PAT (or mint one: Issues R/W + Metadata R)`;
    }
  }
  console.log(`GH token:    ${process.env.GH_TOKEN ? ghProblem || `sees ${ghRepo} ✓` : "not set — gh keychain auth"}`);
} else {
  const n = (() => {
    try { return readdirSync(join(process.cwd(), ".sandcastle", "issues")).filter((f) => f.endsWith(".md")).length; }
    catch { return 0; }
  })();
  console.log(`Issues:      local — ${n} open file(s) in .sandcastle/issues/${n === 0 ? " ⚠ planner will find nothing to do" : ""}`);
}

// Prompt wiring: the library HARD-FAILS a run when a prompt references a
// {{PLACEHOLDER}} main.mts never passes, and that throw lands deep inside the
// per-issue retry where it reads as a model failure. Catch it in 10ms instead.
// ponytail: matches the name anywhere in main.mts, not against the specific
// call site — catches "never wired at all", which is the bug that happens.
// SOURCE_BRANCH/TARGET_BRANCH are supplied by the library; passing them is an
// error, so they are legitimately absent from main.mts.
const BUILT_IN = new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]);
const here = join(process.cwd(), ".sandcastle");
const mainSrc = readFileSync(join(here, "main.mts"), "utf8");
const unwired: string[] = [];
for (const file of ["plan-prompt.md", "implement-prompt.md", "review-prompt.md", "merge-prompt.md"]) {
  for (const m of readFileSync(join(here, file), "utf8").matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = m[1]!;
    if (!BUILT_IN.has(name) && !new RegExp(`\\b${name}\\b`).test(mainSrc)) unwired.push(`${file}: {{${name}}}`);
  }
}
console.log(`Prompt args: ${unwired.length === 0 ? "all wired ✓" : `UNWIRED ✗ — ${[...new Set(unwired)].join(", ")}`}`);

const overridden = [...new Set([...mainSrc.matchAll(/^\s*(SOURCE_BRANCH|TARGET_BRANCH)\s*[,:]/gm)].map((m) => m[1]!))];
console.log(`Built-ins:   ${overridden.length === 0 ? "not overridden ✓" : `PASSED BY main.mts ✗ — ${overridden.join(", ")}`}`);

// Same verdict function the loop runs, so this CLI cannot predict something the
// loop won't do.
const verdict = reachable ? livenessVerdict(available, { plan: PLAN, review: REVIEW, merge: MERGE, small: IMPL_SMALL, large: IMPL_LARGE }) : null;
for (const w of verdict?.warnings ?? []) console.warn(`⚠ ${w}`);

const fail = (msg: string) => { console.error(`FAIL: ${msg}`); process.exit(1); };
for (const p of configProblems()) fail(p);
if (unwired.length) fail(`prompt placeholders never passed by main.mts: ${[...new Set(unwired)].join(", ")}`);
if (overridden.length) fail(`built-in prompt args passed by main.mts: ${overridden.join(", ")} — the library supplies these; passing one throws.`);
if (!reachable || !CONFIG.r9key()) fail("9router unreachable or no key");
if (sandboxProblem) fail(`sandbox — ${sandboxProblem}`);
if (ghProblem) fail(`GH_TOKEN ${ghProblem}`);
for (const f of verdict?.fatal ?? []) fail(f + ` (answering: ${[...available].sort().join(", ") || "none"})`);
console.log("OK — ready to run");
