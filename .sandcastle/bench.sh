#!/usr/bin/env bash
# CLI bench: the same ticket prompt, four native CLIs, four isolated worktrees.
# Mirrors what sandcastle does per issue (own worktree, own branch) minus the
# container — comparing native CLIs is the whole point, so they run on the host.
#
#   ./.sandcastle/bench.sh            # start all four, detached
#   ./.sandcastle/bench.sh status     # who's still running, elapsed, commits
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$REPO/.sandcastle/bench"
JOBS=("claude:47" "codex:54" "kimi:56" "agy:51")

prompt_for() {
  cat <<EOF
Implement GitHub issue #$1 in this repo. Read it first: gh issue view $1

Follow .sandcastle/workspace-hint.md for how to run this repo's checks, and
.sandcastle/CODING_STANDARDS.md for conventions. Both checks must pass before
you commit. Commit on the current branch when done. Do not push.
EOF
}

if [[ "${1:-}" == "status" ]]; then
  printf "%-8s %-6s %-9s %-8s %s\n" TOOL ISSUE STATE ELAPSED COMMITS
  for j in "${JOBS[@]}"; do
    tool="${j%%:*}"; n="${j##*:}"; wt="$BENCH/$tool"
    [[ -f "$BENCH/$tool.start" ]] || { printf "%-8s %-6s %s\n" "$tool" "#$n" "not started"; continue; }
    start=$(cat "$BENCH/$tool.start")
    if [[ -f "$BENCH/$tool.end" ]]; then state=done; end=$(cat "$BENCH/$tool.end"); else state=running; end=$(date +%s); fi
    commits=$(git -C "$wt" rev-list --count main..HEAD 2>/dev/null || echo "?")
    printf "%-8s %-6s %-9s %-8s %s\n" "$tool" "#$n" "$state" "$(( (end-start)/60 ))m" "$commits"
  done
  exit 0
fi

# `bench.sh <tool>` restarts one runner; bare `bench.sh` starts all four.
# Restarting one must not wipe the other three — each is its own worktree.
if [[ -n "${1:-}" ]]; then
  JOBS=($(printf '%s\n' "${JOBS[@]}" | /usr/bin/grep "^$1:")) || { echo "unknown tool: $1"; exit 1; }
  [[ ${#JOBS[@]} -gt 0 ]] || { echo "unknown tool: $1"; exit 1; }
fi

mkdir -p "$BENCH"
for j in "${JOBS[@]}"; do
  tool="${j%%:*}"; n="${j##*:}"; wt="$BENCH/$tool"; branch="bench/$tool-$n"
  rm -rf "$wt"; git -C "$REPO" worktree prune
  git -C "$REPO" branch -D "$branch" >/dev/null 2>&1
  git -C "$REPO" worktree add -q -b "$branch" "$wt" main || { echo "✗ $tool: worktree failed"; continue; }
  # Tests need deps. Symlinking beats four pnpm installs, and install time is
  # setup, not the thing being measured.
  ln -s "$REPO/node_modules" "$wt/node_modules" 2>/dev/null

  case "$tool" in
    claude) cmd=(claude -p "$(prompt_for "$n")" --dangerously-skip-permissions) ;;
    codex)  cmd=(codex exec --dangerously-bypass-approvals-and-sandbox "$(prompt_for "$n")") ;;
    kimi)   cmd=(kimi -p "$(prompt_for "$n")") ;;   # print mode is already non-interactive; -y/--auto are rejected with -p
    agy)    cmd=(agy --print-timeout 45m --dangerously-skip-permissions -p "$(prompt_for "$n")") ;;
  esac

  # Double-fork + nohup: the inner job is reparented away from this script, so
  # it survives the terminal (or agent session) that started it. macOS has no
  # setsid; orphaning does the same job here.
  date +%s > "$BENCH/$tool.start"; rm -f "$BENCH/$tool.end"
  ( cd "$wt" && nohup bash -c '"$@"; date +%s > '"$BENCH/$tool.end" _ "${cmd[@]}" \
      > "$BENCH/$tool.log" 2>&1 & ) &
  disown 2>/dev/null
  echo "▶ $tool → #$n  ($branch)"
done

echo
echo "watch:  ./.sandcastle/bench.sh status"
echo "logs:   tail -f .sandcastle/bench/<tool>.log"
