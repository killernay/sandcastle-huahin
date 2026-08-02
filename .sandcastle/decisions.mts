// The rules the loop follows, as plain functions over plain values.
//
// These used to be welded into main.mts's 727-line body, which exports nothing
// and starts a run on import — so the only way to exercise "does this size earn
// a review?" was Docker, a live gateway and fifteen minutes. Two of them were
// additionally re-implemented in check-models.mts and watch.mts, kept in step
// by comments that said "same rule as main.mts". A comment asserting two
// implementations agree is a seam that was needed and not taken.
//
// The seam sits here: everything in this file decides, nothing acts. Callers
// (the loop, the preflight, the monitor) supply the facts and perform the
// effects. Tests cross the same interface the callers do — see decisions.test.mts.
export type Size = "small" | "large";

// Is this failure "come back later" rather than "this is broken"? Providers say
// it in their own words, so match on what they actually send.
// ponytail: string matching, because the error crosses an Effect/CLI boundary
// that drops the status code. A false positive costs one extra wait.
export const isRateLimited = (e: unknown) =>
  /429|RESOURCE_EXHAUSTED|rate.?limit|quota|usage limit|too many requests/i.test(
    (e as Error)?.message ?? String(e),
  );

// Preferred model first, then the sibling tier — a dead k3 still gets the work
// done by the small model. Models preflight knows are offline are dropped; if
// that empties the list, fall back to the raw pair and let the per-run
// try/catch judge (a gateway can recover between preflight and use).
export const implChain = (
  size: Size,
  models: { small: string; large: string },
  live: Set<string> | null,
): string[] => {
  const raw = size === "large" ? [models.large, models.small] : [models.small, models.large];
  if (!live) return raw;
  const filtered = raw.filter((m) => live.has(m));
  return filtered.length > 0 ? filtered : raw;
};

// Which models must answer, and what it means when they don't. plan/review/merge
// have no fallback, so a missing one is fatal; the two implementer tiers fall
// back to each other, so one missing is a warning and only both missing is fatal.
// The preflight predicts this verdict and the loop enforces it — same function,
// so they cannot disagree.
export type Liveness = { fatal: string[]; warnings: string[]; live: string[] };
export const livenessVerdict = (
  available: Set<string>,
  models: { plan: string; review: string; merge: string; small: string; large: string },
): Liveness => {
  const core = [...new Set([models.plan, models.review, models.merge])];
  const coreMissing = core.filter((m) => !available.has(m));
  const smallOk = available.has(models.small);
  const largeOk = available.has(models.large);

  const fatal: string[] = [];
  const warnings: string[] = [];
  if (coreMissing.length)
    fatal.push(`plan/review/merge models did not answer (no fallback for those phases): ${coreMissing.join(", ")}`);
  if (!smallOk && !largeOk) fatal.push(`neither implementer model answered: ${models.small}, ${models.large}`);
  else {
    if (!smallOk) warnings.push(`IMPL small ${models.small} not answering — those jobs fall back to ${models.large}`);
    if (!largeOk) warnings.push(`IMPL large ${models.large} not answering — those jobs fall back to ${models.small}`);
  }
  return {
    fatal,
    warnings,
    live: [...new Set([...core, models.small, models.large])].filter((m) => available.has(m)),
  };
};

// A worktree a killed run left mid-edit. Agents drop their own runtime files
// (.claude/) in the tree; blocking a start on those trains you to ignore the
// signal, so they don't count as work.
// Takes `git status --porcelain` output — the caller runs git, this judges it.
export const isDirtyWorktree = (statusPorcelain: string): boolean =>
  statusPorcelain.split("\n").some((l) => l.trim() !== "" && !/^\?\?\s+\.claude\//.test(l));

// A reviewer is a second agent that opens the repo cold, so it roughly doubles
// a ticket's token cost — worth it on hard tickets, wasteful on CRUD.
export const wantsReview = (size: Size, reviewSizes: string[]): boolean => reviewSizes.includes(size);

// Which of this round's issues produced work worth merging. `ahead` is the
// commit count the caller measured per branch.
export const completedBranches = <T extends { branch: string }>(issues: T[], ahead: (b: string) => number): T[] =>
  issues.filter((i) => ahead(i.branch) > 0);
