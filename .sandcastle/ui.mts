// Zero-dependency local monitor UI for a sandcastle run.
//
// Reads only what already exists — watch.mts verdict, run.log, agent logs,
// sandcastle/* branches, list-issues.mts — and NEVER calls a model, so it's
// free to leave open all day. Answers "what is the run doing RIGHT NOW" first
// (phase, live agents, a merged LIVE FEED of every log), raw logs second.
//
//   npx tsx .sandcastle/ui.mts     →  http://localhost:7717
//   UI_PORT=8000 npx tsx .sandcastle/ui.mts
//   UI_HOST=0.0.0.0 npx tsx .sandcastle/ui.mts   # reachable over Tailscale/LAN —
//     the logs become visible to anyone who can reach this port; fine on a
//     private tailnet, don't do it on a network you don't trust.
//
// ponytail: shells out to watch.mts / list-issues.mts instead of importing
// them — slower per poll (cached below), but the UI can never disagree with
// the tools it mirrors. Feed timestamps are ARRIVAL times (the logs carry no
// per-line time — upstream #935); good enough to watch, not for forensics.
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.UI_PORT ?? 7717);
const HOST = process.env.UI_HOST ?? "127.0.0.1";
const SC = join(process.cwd(), ".sandcastle");

// Same 6-line .env loader as main.mts — the feed labels planner/reviewer/merger
// lines with their models, which live in .env (or these mirrored defaults).
for (const line of (() => {
  try { return readFileSync(join(SC, ".env"), "utf8").split("\n"); } catch { return []; }
})()) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const MODELS = {
  planner: process.env.MODEL_PLAN ?? "cc/claude-fable-5",
  reviewer: process.env.MODEL_REVIEW ?? "cc/claude-opus-5",
  merger: process.env.MODEL_MERGE ?? "cc/claude-opus-5",
};
const shortModel = (m: string) => m.split("/").pop() ?? m;

const sh = (cmd: string) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    // watch.mts exits 1 when unhealthy — its stdout is still the verdict.
    return ((e as { stdout?: Buffer }).stdout ?? "").toString().trim();
  }
};

// Strip ANSI codes and the streamed thinking-token JSON spam that makes agent
// logs unreadable.
const cleanLines = (path: string) => {
  try {
    return readFileSync(path, "utf8")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((l) => !l.startsWith('{"type":"system"'));
  } catch {
    return [] as string[];
  }
};

// watch.mts spawns ps+docker+git — cache it so browser polls don't stack spawns.
let watchAt = 0;
let watchText = "";
const watch = () => {
  if (Date.now() - watchAt > 5_000) {
    watchAt = Date.now();
    watchText = sh(`npx tsx ${join(SC, "watch.mts")}`) || "(watch.mts produced no output)";
  }
  return watchText;
};

// Issues poll GitHub in github mode — cache longer to stay off the rate limit.
let issuesAt = 0;
let issuesJson: unknown = [];
const issues = () => {
  if (Date.now() - issuesAt > 60_000) {
    issuesAt = Date.now();
    try {
      issuesJson = JSON.parse(sh(`npx tsx ${join(SC, "list-issues.mts")}`) || "[]");
    } catch {
      issuesJson = [];
    }
  }
  return issuesJson;
};

// 9router gateway traffic, read straight from its SQLite (read-only; WAL lets
// us read while the gateway writes). Every model call the run makes shows up
// here — including 429s that the harness quietly retries around.
// ponytail: shells the sqlite3 CLI (ships with macOS) — no driver dependency.
const R9DB = join(homedir(), ".9router/db/data.sqlite");
let r9At = 0;
let r9Data: unknown = null;
const r9stats = () => {
  if (Date.now() - r9At > 5_000) {
    r9At = Date.now();
    try {
      const q = (sql: string) => JSON.parse(sh(`sqlite3 -readonly -json "${R9DB}" "${sql}"`) || "[]");
      r9Data = {
        recent: q(
          "SELECT id, timestamp, provider || '/' || model AS model, status, " +
            "json_extract(data,'$.latency.total') AS ms, " +
            "json_extract(data,'$.tokens.prompt_tokens') AS ptok, " +
            "json_extract(data,'$.tokens.completion_tokens') AS ctok, " +
            "substr(coalesce(json_extract(data,'$.error'),''),1,120) AS err, " +
            "substr(coalesce(json_extract(data,'$.request._preview'), json_extract(data,'$.request'), ''),1,600) AS req, " +
            "substr(coalesce(json_extract(data,'$.response.content'),''),1,800) AS resp " +
            "FROM requestDetails ORDER BY timestamp DESC LIMIT 20",
        ),
        byModel: q(
          "SELECT provider || '/' || model AS model, COUNT(*) AS calls, " +
            "SUM(status!='success') AS errors, " +
            "SUM(CASE WHEN status!='success' AND data LIKE '%429%' THEN 1 ELSE 0 END) AS rate429 " +
            "FROM requestDetails WHERE timestamp > strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 minutes') " +
            "GROUP BY 1 ORDER BY calls DESC",
        ),
      };
    } catch {
      r9Data = null; // no sqlite3 / no 9router db → the panel just hides
    }
  }
  return r9Data;
};

type Agent = { name: string; ageS: number; tail: string; role: string; issue: string; model: string };
type Issue = {
  id: string; title: string; branch: string; size: string; model: string;
  impl: string; review: string; ageS: number | null; lastAction: string;
};

// Who is this agent? Role + issue id from the log name, model from the plan
// line (implementers) or the phase models above (planner/reviewer/merger).
const attrib = (name: string, issueModels: Record<string, string>) => {
  const m = name.match(/^sandcastle-issue-(.+)-(implementer|reviewer)$/);
  if (m) {
    const role = m[2];
    return { role, issue: m[1], model: shortModel(role === "implementer" ? issueModels[m[1]] ?? "?" : MODELS.reviewer) };
  }
  if (name.endsWith("-planner")) return { role: "planner", issue: "", model: shortModel(MODELS.planner) };
  if (name.endsWith("-merger")) return { role: "merger", issue: "", model: shortModel(MODELS.merger) };
  return { role: name, issue: "", model: "?" };
};

// Turn the run.log narrative into the pipeline the operator actually asks
// about: which iteration, which issues, who is working, what failed.
const parseRun = (raw: string, agents: Agent[]) => {
  let iteration = "";
  let issueMap: Record<string, Issue> = {};
  let failures: string[] = [];
  let merging = false;
  for (const l of raw.split("\n")) {
    if (/^=== Iteration \d+\/\d+ ===/.test(l)) {
      iteration = l.replace(/[=\s]+/g, " ").trim();
      issueMap = {}; failures = []; merging = false; // new round resets the board
    }
    const planned = l.match(/^\s+(\S+): (.+?) → (sandcastle\/\S+)\s+\[(\w+) → (\S+)\]/);
    if (planned) issueMap[planned[1]] = {
      id: planned[1], title: planned[2], branch: planned[3], size: planned[4],
      model: planned[5], impl: "pending", review: "pending", ageS: null, lastAction: "",
    };
    const impl = l.match(/^\[implementer\] Started on branch sandcastle\/issue-(\S+)/);
    if (impl && issueMap[impl[1]]) issueMap[impl[1]].impl = "running";
    const rev = l.match(/^\[reviewer\] Started on branch sandcastle\/issue-(\S+)/);
    if (rev && issueMap[rev[1]]) { issueMap[rev[1]].impl = "done"; issueMap[rev[1]].review = "running"; }
    if (/^\[merger\] Started/.test(l)) {
      merging = true;
      for (const i of Object.values(issueMap)) {
        if (i.impl === "running") i.impl = "done";
        if (i.review === "running") i.review = "done";
      }
    }
    const failed = l.match(/^\s*✗ (\S+) /);
    if (failed) { failures.push(l.trim()); if (issueMap[failed[1]]) issueMap[failed[1]].impl = "failed"; }
    else if (/^\s*⚠/.test(l)) failures.push(l.trim());
  }
  for (const i of Object.values(issueMap)) {
    const a = agents.find((x) => x.name === `sandcastle-issue-${i.id}-implementer` || x.name === `sandcastle-issue-${i.id}-reviewer`);
    if (a) {
      i.ageS = a.ageS;
      i.lastAction = (a.tail.split("\n").filter((x) => x.trim()).pop() ?? "").slice(0, 160);
    }
  }
  return { iteration, issues: Object.values(issueMap), failures, merging };
};

// The merged LIVE FEED: on every poll, new lines in any log are stamped with
// arrival time + who wrote them. In-memory only — restarting the monitor
// restarts the feed, never the run.
type FeedItem = { t: number; agent: string; role: string; issue: string; model: string; line: string };
const feedOffsets: Record<string, number> = {};
const feed: FeedItem[] = [];
const collectFeed = (name: string, lines: string[], who: { role: string; issue: string; model: string }) => {
  const meaningful = lines.filter((l) => l.trim());
  // First sighting seeds 3 lines of context; a shrunken file means a fresh run.
  const prev = feedOffsets[name] ?? Math.max(0, meaningful.length - 3);
  if (meaningful.length > prev) {
    for (const l of meaningful.slice(prev).slice(-8)) {
      feed.push({ t: Date.now(), agent: name, ...who, line: l.trim().slice(0, 220) });
    }
  }
  feedOffsets[name] = meaningful.length;
  if (feed.length > 400) feed.splice(0, feed.length - 400);
};

// The one-line answer at the top of the page: what is happening right now.
const headline = (run: ReturnType<typeof parseRun>, agents: Agent[], loop: number) => {
  const live = agents.filter((a) => a.ageS < 180).sort((a, b) => a.ageS - b.ageS)[0];
  if (live) {
    const issue = run.issues.find((i) => i.id === live.issue);
    return {
      state: "working",
      text: `${live.role.toUpperCase()}${issue ? ` — ${issue.id}: ${issue.title}` : ""}`,
      agent: `${live.name} · ${live.model}`, ageS: live.ageS,
    };
  }
  if (loop === 0) return { state: "stopped", text: "STOPPED", agent: "no loop process — start one from your terminal", ageS: null };
  const freshest = agents.sort((a, b) => a.ageS - b.ageS)[0];
  return { state: "waiting", text: "WAITING", agent: freshest ? "loop alive, quiet — check watch verdict" : "loop alive, no agent logs yet", ageS: freshest?.ageS ?? null };
};

const state = () => {
  const runLines = cleanLines(join(SC, "run.log"));
  const runLogRaw = runLines.slice(-400).join("\n");
  // Issue → implementer model comes from the plan lines, so read it first.
  const issueModels: Record<string, string> = {};
  for (const l of runLines) {
    const p = l.match(/^\s+(\S+): .+\[\w+ → (\S+)\]/);
    if (p) issueModels[p[1]] = p[2];
  }
  const agents: Agent[] = (() => {
    try {
      return readdirSync(join(SC, "logs"))
        .filter((f) => f.endsWith(".log"))
        .map((f) => {
          const p = join(SC, "logs", f);
          const name = f.replace(/\.log$/, "");
          const lines = cleanLines(p);
          const who = attrib(name, issueModels);
          collectFeed(name, lines, who);
          return { name, ageS: Math.round((Date.now() - statSync(p).mtimeMs) / 1000), tail: lines.slice(-40).join("\n"), ...who };
        })
        .sort((a, b) => a.ageS - b.ageS)
        .slice(0, 8);
    } catch {
      return [];
    }
  })();
  const run = parseRun(runLogRaw, agents);
  const watchOut = watch();
  const kv = Object.fromEntries((watchOut.split("\n")[0] ?? "").split(" ").map((p) => p.split("=")));
  const branches = sh(`git for-each-ref refs/heads/sandcastle --format="%(refname:short)"`)
    .split("\n")
    .filter(Boolean)
    // ponytail: counts against main; a repo looping on another base shows "?".
    .map((b) => ({ name: b, ahead: sh(`git rev-list --count main..${b}`) || "?" }));
  return {
    at: new Date().toISOString(),
    hero: headline(run, [...agents], Number(kv["loop"] ?? 0)),
    run,
    feed: feed.slice(-150),
    r9: r9stats(),
    watch: watchOut,
    tiles: kv,
    runLog: runLines.slice(-120).join("\n"),
    agents,
    branches,
    issues: issues(),
  };
};

/* Hallmark · component: monitor-ui · genre: editorial(terminal) · theme: Terminal
 * macrostructure: Workbench (tool page — no nav, no footer)
 * pre-emit critique: P4 H5 E5 S4 R4 V4
 * motion: dot-pulse · fresh-line fade-in · live seconds tick (3 primitives,
 *         opacity/transform only, reduced-motion collapses all)
 * states: working/waiting/stopped/problem — color always paired with a label;
 *         feed badges: fixed per-agent hue + full text label (never color alone)
 */
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sandcastle monitor</title><style>
  :root{
    --color-paper:oklch(20% 0.008 260);--color-paper-2:oklch(24% 0.01 260);
    --color-paper-3:oklch(17% 0.008 260);
    --color-ink:oklch(95% 0.005 260);--color-ink-2:oklch(74% 0.01 260);--color-ink-3:oklch(54% 0.012 260);
    --color-rule:oklch(32% 0.012 260);--color-accent:oklch(80% 0.11 230);
    --color-good:oklch(74% 0.17 148);--color-warn:oklch(82% 0.15 85);--color-critical:oklch(64% 0.2 25);
    --color-focus:oklch(80% 0.11 230);
    --agent-a:oklch(80% 0.11 230);--agent-b:oklch(78% 0.12 300);
    --agent-c:oklch(80% 0.12 190);--agent-d:oklch(80% 0.13 340);
    --space-xs:4px;--space-sm:8px;--space-md:16px;--space-lg:24px;--space-xl:40px;
    --text-sm:12px;--text-base:13.5px;--text-lg:16px;--text-display:clamp(21px,4.2vw,32px);
    --font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
    --ease-out:cubic-bezier(.22,1,.36,1);--radius:10px;
  }
  *{box-sizing:border-box;min-width:0}
  html,body{overflow-x:clip}
  body{margin:0;background:var(--color-paper);color:var(--color-ink);
       font:400 var(--text-base)/1.55 var(--font-mono);font-variant-numeric:tabular-nums}
  a{color:var(--color-accent)}

  .progress{position:fixed;top:0;left:0;right:0;height:3px;background:var(--color-rule);z-index:9}
  .progress i{display:block;height:100%;background:var(--color-accent);
              transform-origin:left;transform:scaleX(0);transition:transform .6s var(--ease-out)}

  .wrap{max-width:1200px;margin:0 auto;padding:var(--space-lg) var(--space-md) var(--space-xl)}

  .hero{position:relative;overflow:clip;border:1px solid var(--color-rule);border-radius:var(--radius);
        padding:var(--space-lg);background:var(--color-paper-2)}
  .hero::before{content:"";position:absolute;inset:-60% -20% auto;height:200%;pointer-events:none;
        background:radial-gradient(closest-side,var(--glow,transparent),transparent);opacity:.16}
  .hero.working{--glow:oklch(74% 0.17 148)} .hero.waiting{--glow:oklch(82% 0.15 85)}
  .hero.stopped{--glow:oklch(64% 0.2 25)}
  .hero .row{position:relative;display:flex;flex-wrap:wrap;gap:var(--space-sm) var(--space-lg);align-items:baseline}
  .hero .st{font-size:var(--text-display);font-weight:700;letter-spacing:.01em;overflow-wrap:anywhere}
  .hero .sub{position:relative;color:var(--color-ink-2);margin-top:var(--space-xs)}
  .hero .stamp{margin-left:auto;color:var(--color-ink-3);font-size:var(--text-sm)}
  .working{color:var(--color-good)} .waiting{color:var(--color-warn)}
  .stopped{color:var(--color-critical)} .problem{color:var(--color-critical)}

  .dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:var(--space-sm);
       background:currentColor;vertical-align:2%}
  .working .dot{animation:pulse 2s ease-in-out infinite}
  .waiting .dot{animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  .problems{margin-top:var(--space-md);border:1px solid var(--color-critical);border-radius:var(--radius);
            padding:var(--space-sm) var(--space-md);color:var(--color-critical);
            white-space:pre-wrap;overflow-wrap:anywhere}
  .problems b{text-transform:uppercase;letter-spacing:.08em;font-size:var(--text-sm)}

  .pipe{margin-top:var(--space-md);color:var(--color-ink-2);display:flex;flex-wrap:wrap;
        gap:var(--space-xs) var(--space-md);align-items:center}
  .pipe .iter{color:var(--color-ink);font-weight:700}

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:var(--space-sm);
         margin-top:var(--space-md)}
  .tile{background:var(--color-paper-2);border:1px solid var(--color-rule);border-radius:var(--radius);
        padding:var(--space-sm) var(--space-md)}
  .tile b{display:block;font-size:22px;font-weight:700;overflow-wrap:anywhere}
  .tile span{font-size:var(--text-sm);color:var(--color-ink-3);letter-spacing:.06em;text-transform:uppercase}

  /* ── the centrepiece: merged live feed ─────────────────────────────── */
  .feed-box{margin-top:var(--space-md);border:1px solid var(--color-rule);border-radius:var(--radius);
            background:var(--color-paper-3);overflow:clip}
  .feed-head{display:flex;gap:var(--space-sm);align-items:baseline;padding:var(--space-sm) var(--space-md);
             border-bottom:1px solid var(--color-rule);color:var(--color-ink-2);font-weight:700}
  .feed-head small{color:var(--color-ink-3);font-weight:400;margin-left:auto}
  .feed{height:min(44vh,420px);overflow-y:auto;padding:var(--space-sm) var(--space-md);
        font-size:var(--text-sm)}
  .fl{display:flex;gap:var(--space-sm);padding:2px 0;align-items:baseline}
  .fl.new{animation:fadein .5s var(--ease-out) 1}
  @keyframes fadein{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
  .fl .t{color:var(--color-ink-3);flex:none}
  .fl .badge{flex:none;color:var(--bc,var(--color-ink-2));font-weight:700}
  .fl .badge::before{content:"●";margin-right:5px}
  .fl .tx{color:var(--color-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}

  .chips{display:flex;flex-wrap:wrap;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);
         border-bottom:1px solid var(--color-rule)}
  .chipm{border:1px solid var(--color-rule);border-radius:999px;padding:2px 12px;
         font-size:var(--text-sm);color:var(--color-ink-2);background:none;font-family:inherit;
         cursor:pointer}
  .chipm.bad{border-color:var(--color-critical);color:var(--color-critical)}
  .chipm.off{opacity:.4;text-decoration:line-through}
  .chipm:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
  .r9feed{height:280px}
  .r9d{border:0;margin:0;background:none;border-radius:0}
  .r9d summary{padding:2px 0;font-weight:400;color:inherit;display:flex;gap:var(--space-sm);
               align-items:baseline}
  .r9x{margin:var(--space-xs) 0 var(--space-sm) var(--space-lg);padding:var(--space-sm) var(--space-md);
       border-left:2px solid var(--color-rule);color:var(--color-ink-2);font-size:var(--text-sm);
       white-space:pre-wrap;overflow-wrap:anywhere}
  .r9x b{color:var(--color-ink-3);text-transform:uppercase;letter-spacing:.06em;font-size:11px}
  .fl .ok{color:var(--color-good);flex:none} .fl .err{color:var(--color-critical);flex:none}

  .issues{margin-top:var(--space-md);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));
          gap:var(--space-sm)}
  .card{border:1px solid var(--color-rule);border-radius:var(--radius);background:var(--color-paper-2);
        padding:var(--space-md)}
  .card h3{margin:0;font-size:var(--text-lg);font-weight:700;overflow-wrap:anywhere}
  .card .meta{color:var(--color-ink-3);font-size:var(--text-sm);margin-top:var(--space-xs)}
  .steps{display:flex;gap:var(--space-md);margin-top:var(--space-sm);font-size:var(--text-sm)}
  .step{color:var(--color-ink-3)}
  .step.running{color:var(--color-good);font-weight:700}
  .step.done{color:var(--color-ink-2)}
  .step.failed{color:var(--color-critical);font-weight:700}
  .card .act{margin-top:var(--space-sm);color:var(--color-ink-2);font-size:var(--text-sm);
             white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid var(--color-rule);
             padding-top:var(--space-sm)}

  .logs{margin-top:var(--space-lg)}
  details{border:1px solid var(--color-rule);border-radius:var(--radius);margin-top:var(--space-sm);
          background:var(--color-paper-2)}
  summary{cursor:pointer;padding:var(--space-sm) var(--space-md);color:var(--color-ink-2);
          font-weight:700;list-style:none;display:flex;gap:var(--space-sm);align-items:baseline}
  summary::before{content:"▸";color:var(--color-ink-3)}
  details[open] summary::before{content:"▾"}
  summary:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px;border-radius:4px}
  summary small{color:var(--color-ink-3);font-weight:400;margin-left:auto}
  pre{margin:0;padding:var(--space-sm) var(--space-md);overflow:auto;max-height:300px;
      font-size:var(--text-sm);color:var(--color-ink-2);white-space:pre-wrap;overflow-wrap:anywhere;
      border-top:1px solid var(--color-rule)}

  .cols{margin-top:var(--space-md);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));
        gap:var(--space-sm)}
  ul{margin:0;padding:var(--space-sm) var(--space-md);list-style:none;max-height:260px;overflow:auto}
  li{padding:2px 0;color:var(--color-ink-2)}
  li b{color:var(--color-ink)}
  h2{font-size:var(--text-sm);letter-spacing:.08em;text-transform:uppercase;color:var(--color-ink-3);
     margin:var(--space-lg) 0 0;font-weight:700}

  @media (prefers-reduced-motion:reduce){
    .dot{animation:none}
    .fl.new{animation:none}
    .progress i{transition:none}
  }
</style></head><body>
<div class="progress" aria-hidden="true"><i id="prog"></i></div>
<div class="wrap">
  <div class="hero" id="hero-box"><div class="row">
      <span class="st" id="hero">loading…</span>
      <span class="stamp">updated <span class="age" id="stamp" data-t="">—</span></span></div>
    <div class="sub" id="hero-sub"></div></div>
  <div id="problems"></div>
  <div class="pipe" id="pipe"></div>
  <div class="tiles" id="tiles"></div>
  <div class="feed-box"><div class="feed-head">live feed
      <small>every log, merged · who · role · model</small></div>
    <div class="feed" id="feed"></div></div>
  <div class="feed-box" id="r9-box" hidden><div class="feed-head">9router traffic
      <small>every gateway call · last hour totals</small></div>
    <div class="chips" id="r9-chips"></div>
    <div class="feed r9feed" id="r9-feed"></div></div>
  <div class="issues" id="issues"></div>
  <h2>logs</h2><div class="logs" id="logs"></div>
  <div class="cols" id="cols"></div>
<script>
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const openLogs = new Set();
// Fixed per-agent hue, assigned in first-seen order; the text label always
// carries identity — the color is a redundant cue, never the only one.
const hues = ["var(--agent-a)","var(--agent-b)","var(--agent-c)","var(--agent-d)"];
const agentHue = {};
const hueFor = (name) => agentHue[name] ?? (agentHue[name] = hues[Object.keys(agentHue).length % hues.length]);
let feedSeen = 0;
const hiddenM = new Set();   // models toggled off via the 9router chips
const openR9 = new Set();    // expanded request/response rows, kept across polls
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-m]");
  if (!b) return;
  hiddenM.has(b.dataset.m) ? hiddenM.delete(b.dataset.m) : hiddenM.add(b.dataset.m);
  tick();
});
const fmtAge = (ms) => { const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? s + "s ago" : Math.round(s / 60) + "m ago"; };
setInterval(() => {
  for (const el of document.querySelectorAll(".age[data-t]"))
    if (el.dataset.t) el.textContent = fmtAge(Date.now() - Number(el.dataset.t));
}, 1000);
const ageSpan = (ageS) => '<span class="age" data-t="' + (Date.now() - ageS * 1000) + '">' + fmtAge(ageS * 1000) + "</span>";
const who = (f) => f.role + (f.issue ? " · " + f.issue : "") + " · " + f.model;

async function tick(){
  let s; try { s = await (await fetch("/api/state")).json(); }
  catch { const h = document.getElementById("hero");
          h.textContent = "MONITOR OFFLINE"; h.className = "st stopped"; return; }
  const h = document.getElementById("hero");
  h.innerHTML = '<span class="dot"></span>' + esc(s.hero.text);
  h.className = "st " + s.hero.state;
  document.getElementById("hero-box").className = "hero " + s.hero.state;
  document.getElementById("hero-sub").innerHTML = esc(s.hero.agent) +
    (s.hero.ageS !== null ? " · output " + ageSpan(s.hero.ageS) : "");
  const st = document.getElementById("stamp"); st.dataset.t = String(Date.now()); st.textContent = "0s ago";

  const it = (s.run.iteration.match(/(\\d+)\\/(\\d+)/) ?? []).slice(1).map(Number);
  document.getElementById("prog").style.transform = "scaleX(" + (it.length ? it[0] / it[1] : 0) + ")";

  const problems = s.watch.split("\\n").filter((l) => l.includes("PROBLEM")).concat(s.run.failures);
  document.getElementById("problems").innerHTML = problems.length
    ? '<div class="problems"><b>problem</b>\\n' + problems.map(esc).join("\\n") + "</div>" : "";

  const chip = (label, st) => '<span class="step ' + st + '">' + label + " " +
    ({pending:"○",running:"●",done:"✓",failed:"✗"}[st] ?? "") + "</span>";
  document.getElementById("pipe").innerHTML = s.run.iteration
    ? '<span class="iter">' + esc(s.run.iteration) + "</span>" +
      chip("plan", "done") + "→" +
      chip("implement", s.run.issues.some((i)=>i.impl==="running") ? "running" : s.run.issues.every((i)=>i.impl==="done") && s.run.issues.length ? "done" : s.run.issues.some((i)=>i.impl==="failed") ? "failed" : "pending") + "→" +
      chip("review", s.run.issues.some((i)=>i.review==="running") ? "running" : s.run.issues.every((i)=>i.review==="done") && s.run.issues.length ? "done" : "pending") + "→" +
      chip("merge", s.run.merging ? "running" : "pending")
    : '<span class="iter">no iteration in run.log yet</span>';

  document.getElementById("tiles").innerHTML =
    ["loop","iteration","branches-merged","containers","idle","base"]
      .filter((k) => s.tiles[k] !== undefined)
      .map((k) => '<div class="tile"><b>' + esc(s.tiles[k]) + "</b><span>" + k + "</span></div>").join("");

  // live feed — only lines newer than what's already on screen animate in
  const feedEl = document.getElementById("feed");
  const pinned = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
  feedEl.innerHTML = s.feed.map((f, idx) =>
    '<div class="fl' + (idx >= feedSeen ? " new" : "") + '">' +
    '<span class="t age" data-t="' + f.t + '">' + fmtAge(Date.now() - f.t) + "</span>" +
    '<span class="badge" style="--bc:' + hueFor(f.agent) + '">' + esc(who(f)) + "</span>" +
    '<span class="tx">' + esc(f.line) + "</span></div>").join("");
  feedSeen = s.feed.length;
  if (pinned) feedEl.scrollTop = feedEl.scrollHeight;

  // 9router traffic — totals per model (chips filter the list) + expandable
  // request/response per call (429s and errors included)
  const r9box = document.getElementById("r9-box");
  if (s.r9) {
    r9box.hidden = false;
    document.getElementById("r9-chips").innerHTML = s.r9.byModel.map((m) =>
      '<button class="chipm' + (m.errors > 0 ? " bad" : "") + (hiddenM.has(m.model) ? " off" : "") +
      '" data-m="' + esc(m.model) + '" aria-pressed="' + !hiddenM.has(m.model) + '">' +
      esc(m.model) + " · " + m.calls + " calls" +
      (m.errors > 0 ? " · " + m.errors + " err" + (m.rate429 > 0 ? " (" + m.rate429 + "×429)" : "") : "") + "</button>").join("")
      || '<span class="chipm">no calls in the last hour</span>';
    const r9f = document.getElementById("r9-feed");
    const pin9 = r9f.scrollHeight - r9f.scrollTop - r9f.clientHeight < 40;
    for (const d of document.querySelectorAll("details[data-r9]"))
      d.open ? openR9.add(d.dataset.r9) : openR9.delete(d.dataset.r9);
    r9f.innerHTML = s.r9.recent.slice().reverse()
      .filter((r) => !hiddenM.has(r.model))
      .map((r) =>
        '<details class="r9d" data-r9="' + esc(r.id) + '"' + (openR9.has(r.id) ? " open" : "") + "><summary>" +
        '<span class="t">' + new Date(r.timestamp).toLocaleTimeString() + "</span>" +
        '<span class="' + (r.status === "success" ? "ok" : "err") + '">' + (r.status === "success" ? "✓" : "✗") + "</span>" +
        '<span class="badge" style="--bc:' + hueFor(r.model) + '">' + esc(r.model) + "</span>" +
        '<span class="tx">' + (r.ms ? r.ms + "ms" : "…") +
          (r.ptok ? " · " + r.ptok + "→" + (r.ctok ?? 0) + " tok" : "") +
          (r.err ? " · " + esc(r.err) : "") + "</span></summary>" +
        '<div class="r9x"><b>→ request</b>\\n' + esc(r.req || "(empty)") +
        '\\n\\n<b>← response</b>\\n' + esc(r.resp || "(pending / streaming)") + "</div></details>").join("");
    if (pin9) r9f.scrollTop = r9f.scrollHeight;
  } else r9box.hidden = true;

  document.getElementById("issues").innerHTML = s.run.issues.map((i) =>
    '<div class="card"><h3>' + esc(i.id) + " · " + esc(i.title) + "</h3>" +
    '<div class="meta">' + esc(i.branch) + " · " + esc(i.size) + " → " + esc(i.model) +
      (i.ageS !== null ? " · output " + ageSpan(i.ageS) : "") + "</div>" +
    '<div class="steps">' + chip("implement", i.impl) + chip("review", i.review) + "</div>" +
    (i.lastAction ? '<div class="act">' + esc(i.lastAction) + "</div>" : "") + "</div>").join("");

  for (const d of document.querySelectorAll("details[data-id]"))
    d.open ? openLogs.add(d.dataset.id) : openLogs.delete(d.dataset.id);
  const scrolls = {};
  for (const el of document.querySelectorAll("pre[data-id]"))
    scrolls[el.dataset.id] = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  const pane = (id, sub, body) =>
    '<details data-id="' + esc(id) + '"' + (openLogs.has(id) ? " open" : "") + "><summary>" + esc(id) +
    "<small>" + sub + "</small></summary><pre data-id=\\"" + esc(id) + "\\">" + esc(body || "(empty)") + "</pre></details>";
  document.getElementById("logs").innerHTML =
    pane("run.log", "", s.runLog) +
    s.agents.map((a) => pane(a.name, esc(a.model) + " · " + (a.ageS < 120 ? "live · " : "idle · ") + ageSpan(a.ageS), a.tail)).join("");
  for (const el of document.querySelectorAll("pre[data-id]"))
    if (scrolls[el.dataset.id] !== false) el.scrollTop = el.scrollHeight;

  document.getElementById("cols").innerHTML =
    '<div class="card"><h3>issues (' + s.issues.length + ')</h3><ul>' +
      s.issues.map((i) => "<li><b>" + esc(i.number) + "</b> " + esc(i.title || "") + "</li>").join("") + "</ul></div>" +
    '<div class="card"><h3>branches</h3><ul>' +
      (s.branches.map((b) => "<li><b>" + esc(b.name) + "</b> +" + esc(b.ahead) + " commit(s)</li>").join("") || "<li>(none)</li>") + "</ul></div>";
}
tick(); setInterval(tick, 3000);
</script></div></body></html>`;

createServer((req, res) => {
  if (req.url === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state()));
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  }
})
  .listen(PORT, HOST, () => {
    console.log(`sandcastle monitor → http://${HOST === "0.0.0.0" ? "<this-machine>" : "localhost"}:${PORT}  (reads logs only — no model calls)`);
  })
  .on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `port ${PORT} is busy — a monitor is probably already running: open http://localhost:${PORT}\n` +
          `kill it (lsof -ti :${PORT} | xargs kill) or pick another port: UI_PORT=${PORT + 1} npx tsx .sandcastle/ui.mts`,
      );
      process.exit(1);
    }
    throw e;
  });
