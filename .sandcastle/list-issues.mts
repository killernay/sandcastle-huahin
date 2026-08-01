// Prints the work-ready issue list as JSON [{number, title, body, labels}].
// This is the ONE place the ISSUE_SOURCE switch lives — plan-prompt.md shells
// out to this script, so the planner never knows where issues come from.
//
//   github (default): gh issue list filtered by ISSUE_LABEL (needs GH_TOKEN
//                     that can see THIS repo — preflight checks that).
//   local:            .sandcastle/issues/*.md — one file per issue.
//                     id = filename stem (keep it branch-safe: letters, digits,
//                     dashes — it becomes sandcastle/issue-<stem>),
//                     title = first line (leading #s stripped),
//                     body = the whole file, labels = [].
//                     Done = the merger moves the file to .sandcastle/issues/done/.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Same 6-line .env loader as main.mts, so a standalone run behaves like the loop.
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

const SOURCE = process.env.ISSUE_SOURCE ?? "github";

if (SOURCE === "github") {
  const LABEL = process.env.ISSUE_LABEL ?? "ready-for-agent";
  process.stdout.write(
    execSync(
      `gh issue list --state open --label ${LABEL} --limit 100 --json number,title,body,labels ` +
        `--jq '[.[] | {number, title, body, labels: [.labels[].name]}]'`,
      { encoding: "utf8" },
    ),
  );
} else if (SOURCE === "local") {
  const dir = join(process.cwd(), ".sandcastle", "issues");
  const files = (() => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  })().sort();
  const issues = files.map((f) => {
    const body = readFileSync(join(dir, f), "utf8");
    const id = f.replace(/\.md$/, "");
    return {
      number: id,
      title: (body.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim() || id,
      body,
      labels: [] as string[],
    };
  });
  console.log(JSON.stringify(issues));
} else {
  console.error(`ISSUE_SOURCE must be "github" or "local", got "${SOURCE}"`);
  process.exit(1);
}
