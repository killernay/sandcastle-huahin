// Preflight check: does .env load, do model ids resolve, are they LIVE on
// 9router right now, and is every {{PLACEHOLDER}} in the prompts actually wired
// up in main.mts? Run before a real run to avoid burning tokens on a dead model
// id or an unwired prompt arg.  Usage: npx tsx .sandcastle/check-models.mts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

for (const line of (() => {
  try { return readFileSync(join(process.cwd(), ".sandcastle", ".env"), "utf8").split("\n"); }
  catch { return []; }
})()) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const R9_URL = process.env.R9_URL ?? "http://host.docker.internal:20128";
const r9key = () => {
  try { return readFileSync(join(homedir(), ".9router/auth/cli-secret"), "utf8").trim(); }
  catch { return process.env.R9_KEY ?? ""; }
};

const PLAN = process.env.MODEL_PLAN ?? "cc/claude-fable-5";
const REVIEW = process.env.MODEL_REVIEW ?? "cc/claude-opus-5";
const MERGE = process.env.MODEL_MERGE ?? "cc/claude-opus-5";
const IMPL_SMALL = process.env.MODEL_IMPL_SMALL ?? "ag/gemini-3.1-pro-low";
const IMPL_LARGE = process.env.MODEL_IMPL_LARGE ?? "kimi/kimi-k3";

// fetch live model list from 9router (localhost from host, not the container URL)
let available = new Set<string>();
let reachable = false;
try {
  const res = await fetch(`${R9_URL.replace("host.docker.internal", "localhost")}/v1/models`, {
    headers: { Authorization: `Bearer ${r9key()}` },
  });
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  available = new Set((body.data ?? []).map((m) => m.id));
  reachable = true;
} catch (e) {
  console.error(`✗ cannot reach 9router at ${R9_URL} — is it running? (${(e as Error).message})`);
}

// Listed on the gateway is not the same as usable: a rate-limited or
// unauthorized account keeps its entry in /v1/models and only fails when an
// agent actually calls it. Ask each model for one token instead. (The reverse
// is true too — the gateway answers 200 for an id that doesn't exist — so both
// checks have to pass.)
const answers = new Map<string, string>();
if (reachable) {
  const wanted = [...new Set([PLAN, REVIEW, MERGE, IMPL_SMALL, IMPL_LARGE])];
  await Promise.all(
    wanted.map(async (id) => {
      if (!available.has(id)) return answers.set(id, "not on the gateway");
      try {
        const r = await fetch(`${R9_URL.replace("host.docker.internal", "localhost")}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${r9key()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        });
        if (!r.ok) answers.set(id, `${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 70)}`);
      } catch (e) {
        answers.set(id, (e as Error).message.slice(0, 70));
      }
    }),
  );
}
const usable = (id: string) => reachable && available.has(id) && !answers.has(id);
const live = (id: string) => (usable(id) ? "answers ✓" : `✗ ${answers.get(id) ?? "MISSING"}`);
console.log("Phase          Model                      9router");
console.log("─".repeat(62));
console.log(`PLAN           ${PLAN.padEnd(26)} ${reachable ? live(PLAN) : "?"}`);
console.log(`IMPL (small)   ${IMPL_SMALL.padEnd(26)} ${reachable ? live(IMPL_SMALL) : "?"}`);
console.log(`IMPL (large)   ${IMPL_LARGE.padEnd(26)} ${reachable ? live(IMPL_LARGE) : "?"}`);
console.log(`REVIEW         ${REVIEW.padEnd(26)} ${reachable ? live(REVIEW) : "?"}`);
console.log(`MERGE          ${MERGE.padEnd(26)} ${reachable ? live(MERGE) : "?"}`);
console.log("─".repeat(62));
console.log(`9router key: ${r9key() ? "present ✓" : "MISSING ✗"}   reachable: ${reachable ? "yes ✓" : "NO ✗"}`);

// Prompt wiring: the library HARD-FAILS a run when a prompt references a
// {{PLACEHOLDER}} that main.mts never passes ("Prompt argument … has no
// matching value"), and that throw lands deep inside the per-issue retry, where
// it reads as a model failure. Catch it here in 10ms instead.
// ponytail: matches the name anywhere in main.mts, not against the specific
// call site — so a name used by one prompt and added to a second still reads as
// wired. Catches "never wired at all", which is the bug that actually happens.
// SOURCE_BRANCH/TARGET_BRANCH are supplied by the library itself; passing them
// is an error, so they are legitimately absent from main.mts.
const BUILT_IN = new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]);
const here = join(process.cwd(), ".sandcastle");
const mainSrc = readFileSync(join(here, "main.mts"), "utf8");
const unwired: string[] = [];
for (const file of ["plan-prompt.md", "implement-prompt.md", "review-prompt.md", "merge-prompt.md"]) {
  const names = new Set(
    [...readFileSync(join(here, file), "utf8").matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!),
  );
  for (const name of names) {
    if (BUILT_IN.has(name)) continue;
    if (!new RegExp(`\\b${name}\\b`).test(mainSrc)) unwired.push(`${file}: {{${name}}}`);
  }
}
console.log(`Prompt args: ${unwired.length === 0 ? "all wired ✓" : `UNWIRED ✗ — ${unwired.join(", ")}`}`);

// The inverse mistake, and the more expensive one: passing a built-in is a hard
// PromptError at run time, on every phase, however sensible it looks in a diff.
const overridden = [...mainSrc.matchAll(/^\s*(SOURCE_BRANCH|TARGET_BRANCH)\s*[,:]/gm)].map((m) => m[1]!);
console.log(`Built-ins:   ${overridden.length === 0 ? "not overridden ✓" : `PASSED BY main.mts ✗ — ${[...new Set(overridden)].join(", ")}`}`);

// Same rule main.mts enforces at run time, so this CLI can't disagree with the
// loop it is meant to predict: plan/review/merge have no fallback and must be
// live; the two IMPL tiers fall back to each other, so one being offline is a
// warning and only losing both is fatal.
const coreMissing = [...new Set([PLAN, REVIEW, MERGE])].filter((m) => !usable(m));
const implLive = [IMPL_SMALL, IMPL_LARGE].filter((m) => usable(m));
if (unwired.length) { console.error(`FAIL: prompt placeholders never passed by main.mts: ${unwired.join(", ")}`); process.exit(1); }
if (overridden.length) { console.error(`FAIL: built-in prompt args passed by main.mts: ${[...new Set(overridden)].join(", ")} — the library supplies these; passing one throws.`); process.exit(1); }
if (!reachable || !r9key()) { console.error("FAIL: 9router unreachable or no key"); process.exit(1); }
if (coreMissing.length) { console.error(`FAIL: plan/review/merge models not on 9router (no fallback for those): ${coreMissing.join(", ")}`); process.exit(1); }
if (implLive.length === 0) { console.error(`FAIL: both implementer models are offline: ${IMPL_SMALL}, ${IMPL_LARGE}`); process.exit(1); }
if (implLive.length === 1) { console.warn(`⚠ one implementer tier is offline — all IMPL work will run on ${implLive[0]}`); }
console.log("OK — ready to run");
