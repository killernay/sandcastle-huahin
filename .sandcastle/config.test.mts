// Guards the thing that actually broke: documentation drifting away from code.
// Every knob in config.mts must appear in .env.example and in the README table,
// and nothing may document a knob the code doesn't read. Before this check the
// repo shipped a documented MODEL_IMPL nobody read, a documented default that
// was wrong, and a knob (SANDCASTLE_STALL_MIN) that was silently ignored.
//
//   npx tsx --test .sandcastle/config.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, KNOBS, configProblems } from "./config.mts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("every knob is documented in .env.example", () => {
  const env = read(".sandcastle/.env.example");
  const missing = KNOBS.filter((k) => !env.includes(k.name)).map((k) => k.name);
  assert.deepEqual(missing, [], `undocumented in .env.example: ${missing.join(", ")}`);
});

test("no MODEL_* variable is documented that the code does not read", () => {
  // MODELS.md taught MODEL_IMPL for months; setting it was a silent no-op.
  const known = new Set(KNOBS.map((k) => k.name));
  // Only docs the harness owns. The repo root README belongs to whatever
  // project the harness was installed into — except in the harness's own repo,
  // where it is the manual and worth checking.
  const docs = [".sandcastle/.env.example", ".sandcastle/MODELS.md"];
  try { if (read("README.md").includes("sandcastle-huahin")) docs.push("README.md"); } catch {}
  for (const doc of docs) {
    // `MODEL_*` in prose is a wildcard, not a variable name.
    const ghosts = [...new Set([...read(doc).matchAll(/\bMODEL_[A-Z][A-Z_]*\b/g)].map((m) => m[0]))]
      .filter((name) => !known.has(name));
    assert.deepEqual(ghosts, [], `${doc} documents unread variable(s): ${ghosts.join(", ")}`);
  }
});

test("a default value is written once, in the knob table", () => {
  // The five-file tax: the same default used to be repeated in main.mts,
  // check-models.mts and ui.mts. Those files must now name no model id at all.
  for (const src of [".sandcastle/main.mts", ".sandcastle/check-models.mts", ".sandcastle/ui.mts"]) {
    const body = read(src);
    assert.equal(/["'`](cc|ag|kimi|cx)\/[a-z0-9.\-]+["'`]/.test(body), false,
      `${src} hard-codes a model id — defaults belong in config.mts`);
  }
});

test("the .env loader exists in exactly one module", () => {
  const parser = /readFileSync\([^)]*\.sandcastle[^)]*\.env/;
  const copies = [".sandcastle/main.mts", ".sandcastle/check-models.mts", ".sandcastle/list-issues.mts",
                  ".sandcastle/ui.mts", ".sandcastle/watch.mts"].filter((f) => parser.test(read(f)));
  assert.deepEqual(copies, [], `these still parse .env themselves: ${copies.join(", ")}`);
});

test("a clean config reports no problems", () => {
  assert.deepEqual(configProblems(), []);
});

test("resolved config is internally consistent", () => {
  assert.ok(CONFIG.MAX_ITERATIONS >= 1);
  assert.ok(CONFIG.REVIEW_SIZES.every((s) => s === "small" || s === "large"));
  // SANDBOX decides how an agent reaches the gateway — one knob, one answer.
  assert.match(CONFIG.R9_URL, CONFIG.SANDBOX === "none" ? /localhost/ : /host\.docker\.internal|localhost/);
});
