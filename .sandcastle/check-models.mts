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

const PLAN = process.env.MODEL_PLAN ?? "cc/claude-opus-4-8";
const REVIEW = process.env.MODEL_REVIEW ?? "cc/claude-opus-4-8";
const MERGE = process.env.MODEL_MERGE ?? "cc/claude-opus-4-8";
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

const live = (id: string) => (available.has(id) ? "live ✓" : "MISSING ✗");
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

const wanted = [...new Set([PLAN, REVIEW, MERGE, IMPL_SMALL, IMPL_LARGE])];
const missing = reachable ? wanted.filter((m) => !available.has(m)) : wanted;
if (unwired.length) { console.error(`FAIL: prompt placeholders never passed by main.mts: ${unwired.join(", ")}`); process.exit(1); }
if (!reachable || !r9key()) { console.error("FAIL: 9router unreachable or no key"); process.exit(1); }
if (missing.length) { console.error(`FAIL: not on 9router: ${missing.join(", ")}`); process.exit(1); }
console.log("OK — all models live");
