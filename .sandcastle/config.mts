// Every knob the harness has, in one place: name, default, who reads it, and
// one line of prose. Before this module the same knob's default lived in up to
// three scripts and its documentation in four more files, so adding one cost
// four-to-six edits — and the copies drifted into shipped bugs (a documented
// MODEL_IMPL nobody read, a documented default that was wrong, a var watch.mts
// silently ignored because it lacked the copy-pasted .env parser).
//
// The interface is small on purpose: `CONFIG` (resolved values) and
// `configProblems()` (what is wrong with them). Everything else — parsing,
// defaults, cross-knob rules — is implementation.
//
//   npx tsx .sandcastle/config.mts            # print resolved config
//   npx tsx .sandcastle/config.mts --emit-env # regenerate the .env.example knob table
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── The knob table ───────────────────────────────────────────────────────────
// `doc` is the source of truth for .env.example and the README table. Keep it
// to one line: it has to read well in both.
type Knob = { name: string; def: string; doc: string; enum?: string[] };
export const KNOBS: Knob[] = [
  { name: "WORKSPACE_DIR", def: "", doc: "Subdir holding the pnpm workspace (empty = repo root)" },
  { name: "ISSUE_LABEL", def: "ready-for-agent", doc: "GitHub label the planner filters issues by" },
  { name: "ISSUE_SOURCE", def: "github", enum: ["github", "local"], doc: "github = GitHub issues by label; local = .md files in .sandcastle/issues/" },
  { name: "DEP_ORDER_FILE", def: "", doc: "Optional build-order file (sprint-status.yaml, roadmap…)" },
  { name: "SANDBOX", def: "docker", enum: ["docker", "none"], doc: "docker = isolated image; none = on the host, no isolation" },
  { name: "BATCH_SIZE", def: "3", doc: "Issues the planner may take per round (parallelism dial)" },
  { name: "MAX_ITERATIONS", def: "10", doc: "Plan→execute→merge rounds before the run stops" },
  { name: "REVIEW_SIZES", def: "small,large", doc: "Which difficulty tiers earn a reviewer pass (a reviewer roughly doubles a ticket's tokens)" },
  { name: "AUTO_PUSH", def: "", doc: "true = push main after each merge round (host credentials)" },
  { name: "INSTALL_CMD", def: "", doc: "What the sandbox runs to make the repo buildable (default: pnpm install)" },
  { name: "RATE_LIMIT_WAIT_S", def: "90", doc: "Pause before retrying an issue whose models were all rate-limited" },
  { name: "MODEL_PLAN", def: "cc/claude-opus-5", doc: "Planner model or 9router combo" },
  { name: "MODEL_REVIEW", def: "cc/claude-opus-5", doc: "Reviewer model or combo" },
  { name: "MODEL_MERGE", def: "cc/claude-opus-5", doc: "Merger model or combo" },
  { name: "MODEL_IMPL_SMALL", def: "ag/gemini-3.1-pro-low", doc: "Implementer for issues the planner tagged small" },
  { name: "MODEL_IMPL_LARGE", def: "kimi/kimi-k3", doc: "Implementer for issues the planner tagged large" },
  { name: "R9_URL", def: "", doc: "9router gateway URL (default follows SANDBOX: container vs host)" },
  { name: "R9_KEY", def: "", doc: "Gateway key; normally auto-read from ~/.9router/auth/cli-secret" },
  { name: "GH_TOKEN", def: "", doc: "GitHub token — Issues R/W + Metadata R on THIS repo" },
  { name: "SANDCASTLE_STALL_MIN", def: "20", doc: "Minutes without output before watch.mts calls a run stalled" },
  { name: "UI_PORT", def: "7717", doc: "Monitor port" },
  { name: "UI_HOST", def: "127.0.0.1", doc: "Monitor bind address (0.0.0.0 exposes your logs to the LAN/tailnet)" },
];

// ── .env → process.env ───────────────────────────────────────────────────────
// Was copy-pasted into four scripts (and a fifth time in bash inside SKILL.md).
// Inline env still wins: we never overwrite something already set.
// ponytail: a parser this size beats a dotenv dependency; one copy beats five.
export const loadEnv = (cwd = process.cwd()) => {
  let lines: string[] = [];
  try { lines = readFileSync(join(cwd, ".sandcastle", ".env"), "utf8").split("\n"); } catch { return; }
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
};
loadEnv();

const val = (name: string) => process.env[name] ?? KNOBS.find((k) => k.name === name)!.def;

// ── Derived values ───────────────────────────────────────────────────────────
const SANDBOX = val("SANDBOX");
const WORKSPACE_DIR = val("WORKSPACE_DIR");

// Read a project file that is configuration in all but name, or fall back.
const fileOr = (rel: string, fallback: string) => {
  try { return readFileSync(join(process.cwd(), ".sandcastle", rel), "utf8").trim() || fallback; }
  catch { return fallback; }
};

const CD_WS = WORKSPACE_DIR ? `cd ${WORKSPACE_DIR} && ` : "";
const STORE = "/home/agent/pnpm-store";

export const CONFIG = Object.freeze({
  WORKSPACE_DIR,
  CD_WS,
  STORE,
  ISSUE_LABEL: val("ISSUE_LABEL"),
  ISSUE_SOURCE: val("ISSUE_SOURCE"),
  DEP_ORDER_FILE: val("DEP_ORDER_FILE"),
  SANDBOX,
  BATCH_SIZE: val("BATCH_SIZE"),
  MAX_ITERATIONS: Number(val("MAX_ITERATIONS")),
  REVIEW_SIZES: val("REVIEW_SIZES").split(",").map((s) => s.trim()).filter(Boolean),
  AUTO_PUSH: /^(1|true|yes)$/i.test(val("AUTO_PUSH")),
  RATE_LIMIT_WAIT_S: Number(val("RATE_LIMIT_WAIT_S")),
  // pnpm's store lives outside the worktree in docker; on the host, leave the
  // user's own pnpm config alone.
  INSTALL_CMD:
    process.env.INSTALL_CMD ||
    (SANDBOX === "none" ? `${CD_WS}pnpm install` : `${CD_WS}pnpm config set store-dir ${STORE} && pnpm install`),
  MODEL: {
    PLAN: val("MODEL_PLAN"),
    REVIEW: val("MODEL_REVIEW"),
    MERGE: val("MODEL_MERGE"),
    IMPL_SMALL: val("MODEL_IMPL_SMALL"),
    IMPL_LARGE: val("MODEL_IMPL_LARGE"),
  },
  // Containers reach the gateway via host.docker.internal; a host-run agent via
  // localhost. One knob (SANDBOX) decides both — a cross-knob rule that used to
  // live in two scripts with two different answers.
  R9_URL: process.env.R9_URL || (SANDBOX === "none" ? "http://localhost:20128" : "http://host.docker.internal:20128"),
  r9key: () => {
    try { return readFileSync(join(homedir(), ".9router/auth/cli-secret"), "utf8").trim(); }
    catch { return process.env.R9_KEY ?? ""; }
  },
  SANDCASTLE_STALL_MIN: Number(val("SANDCASTLE_STALL_MIN")),
  UI_PORT: Number(val("UI_PORT")),
  UI_HOST: val("UI_HOST"),
  // Project knowledge that survives a harness re-sync because it lives in its
  // own file, not in a prompt the next sync overwrites.
  WORKSPACE_HINT: fileOr(
    "workspace-hint.md",
    WORKSPACE_DIR
      ? `The workspace lives in \`${WORKSPACE_DIR}/\` — **not** the repo root. Run every ` +
          `check from there: \`${CD_WS}pnpm typecheck && pnpm test\`, and both must pass ` +
          `before you commit.\n\nThe repo root is not the workspace: \`pnpm test\` there ` +
          `finds no tests and exits clean — that is NOT a green build.`
      : `Run \`pnpm typecheck && pnpm test\` (or this repo's equivalent — read the ` +
          `\`scripts\` in package.json) before committing. A command that finds no tests ` +
          `and exits clean is NOT a green build.`,
  ),
  PROJECT_RULES: (() => {
    const body = fileOr("planning-rules.md", "");
    return body ? `# PROJECT RULES (override the generic rules above)\n\n${body}` : "";
  })(),
});

// ── Validation ───────────────────────────────────────────────────────────────
// The Claude Code CLI rewrites its own aliases before a request leaves the
// machine: `--model opus` goes out as `claude-opus-5`, which no gateway knows.
// Naming a combo `opus` therefore fails with a model-not-found the gateway
// never even saw. Cost one run to learn; costs one line to never repeat.
const CLI_ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "default", "opusplan"]);

export const configProblems = (): string[] => {
  const problems: string[] = [];
  for (const k of KNOBS) {
    const v = process.env[k.name];
    if (k.enum && v !== undefined && v !== "" && !k.enum.includes(v))
      problems.push(`${k.name} must be one of ${k.enum.join(" | ")}, got "${v}"`);
  }
  const clashes = [...new Set(Object.values(CONFIG.MODEL))].filter((id) => CLI_ALIASES.has(id.toLowerCase()));
  if (clashes.length)
    problems.push(
      `model id(s) collide with a Claude Code CLI alias: ${clashes.join(", ")} — the CLI rewrites ` +
        `these before the call leaves the machine, so the gateway never sees them. Rename the combo (e.g. "qc").`,
    );
  if (!Number.isFinite(CONFIG.MAX_ITERATIONS) || CONFIG.MAX_ITERATIONS < 1)
    problems.push(`MAX_ITERATIONS must be a positive number, got "${process.env.MAX_ITERATIONS}"`);
  return problems;
};

// ── CLI ──────────────────────────────────────────────────────────────────────
// `--emit-env` is what stops .env.example from drifting: it is generated from
// the table above rather than maintained beside it.
if (process.argv[1]?.endsWith("config.mts")) {
  if (process.argv.includes("--emit-env")) {
    console.log("# ── Knobs (generated by: npx tsx .sandcastle/config.mts --emit-env) ──");
    for (const k of KNOBS) console.log(`\n# ${k.doc}${k.enum ? `  [${k.enum.join(" | ")}]` : ""}\n# ${k.name}=${k.def}`);
  } else {
    console.log(JSON.stringify({ ...CONFIG, r9key: "<fn>" }, null, 2));
    const p = configProblems();
    if (p.length) { console.error("\nproblems:\n  " + p.join("\n  ")); process.exit(1); }
  }
}
