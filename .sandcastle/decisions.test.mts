// The harness's only automated check. Runs in milliseconds, needs no Docker,
// no gateway and no repo — which is the whole point of the seam in
// decisions.mts. Every case here is a failure this harness actually had.
//
//   npx tsx --test .sandcastle/decisions.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { completedBranches, implChain, isDirtyWorktree, isRateLimited, livenessVerdict, wantsReview } from "./decisions.mts";

const M = { plan: "plan", review: "review", merge: "merge", small: "impl-small", large: "impl-large" };

test("rate limit is recognised in each provider's own words", () => {
  for (const msg of ["429 Too Many Requests", "RESOURCE_EXHAUSTED", "rate limit reached", "usage limit exceeded", "quota exceeded"])
    assert.equal(isRateLimited(new Error(msg)), true, msg);
  assert.equal(isRateLimited(new Error("model may not exist")), false);
});

test("impl chain prefers its own tier, then the sibling", () => {
  assert.deepEqual(implChain("small", { small: "S", large: "L" }, null), ["S", "L"]);
  assert.deepEqual(implChain("large", { small: "S", large: "L" }, null), ["L", "S"]);
});

test("impl chain drops a model preflight knows is dead", () => {
  assert.deepEqual(implChain("small", { small: "S", large: "L" }, new Set(["L"])), ["L"]);
});

test("impl chain keeps the raw pair rather than returning nothing", () => {
  // A gateway can recover between preflight and use; an empty chain cannot.
  assert.deepEqual(implChain("small", { small: "S", large: "L" }, new Set(["other"])), ["S", "L"]);
});

test("all models live is no fatal, no warning", () => {
  const v = livenessVerdict(new Set(["plan", "review", "merge", "impl-small", "impl-large"]), M);
  assert.deepEqual(v.fatal, []);
  assert.deepEqual(v.warnings, []);
});

test("a missing core model is fatal — those phases have no fallback", () => {
  // The bug that killed a run: MODEL_REVIEW pointed at a combo that no longer
  // existed on the gateway, and the loop died at the first reviewer.
  const v = livenessVerdict(new Set(["plan", "merge", "impl-small", "impl-large"]), M);
  assert.equal(v.fatal.length, 1);
  assert.match(v.fatal[0]!, /review/);
});

test("one dead implementer tier warns, both are fatal", () => {
  const one = livenessVerdict(new Set(["plan", "review", "merge", "impl-large"]), M);
  assert.deepEqual(one.fatal, []);
  assert.equal(one.warnings.length, 1);

  const both = livenessVerdict(new Set(["plan", "review", "merge"]), M);
  assert.equal(both.fatal.length, 1);
  assert.match(both.fatal[0]!, /neither implementer/);
});

test("agent runtime droppings do not count as a dirty worktree", () => {
  assert.equal(isDirtyWorktree("?? .claude/settings.local.json\n"), false);
  assert.equal(isDirtyWorktree(""), false);
  assert.equal(isDirtyWorktree(" M api/router.mjs\n"), true);
  assert.equal(isDirtyWorktree("?? .claude/x\n M db/schema.sql\n"), true);
});

test("review is skipped only for tiers left out of REVIEW_SIZES", () => {
  assert.equal(wantsReview("small", ["small", "large"]), true);
  assert.equal(wantsReview("small", ["large"]), false);
  assert.equal(wantsReview("large", ["large"]), true);
  assert.equal(wantsReview("large", []), false);
});

test("only branches carrying commits are merged", () => {
  const issues = [{ branch: "a" }, { branch: "b" }];
  assert.deepEqual(completedBranches(issues, (b) => (b === "a" ? 2 : 0)), [{ branch: "a" }]);
});
