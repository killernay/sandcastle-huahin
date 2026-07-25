#!/usr/bin/env bash
# Install the sandcastle-huahin harness into a target repo.
# Usage: ./install.sh /path/to/your-project
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: ./install.sh /path/to/your-project" >&2
  exit 1
fi
if [[ ! -d "$TARGET/.git" ]]; then
  echo "✗ $TARGET is not a git repo (Sandcastle needs git worktrees)." >&2
  exit 1
fi

SRC="$(cd "$(dirname "$0")" && pwd)/.sandcastle"
DEST="$TARGET/.sandcastle"

if [[ -d "$DEST" ]]; then
  echo "⚠ $DEST already exists. Back it up or remove it first." >&2
  exit 1
fi

# Copy harness (never the caller's secrets/logs — SRC has none anyway)
cp -R "$SRC" "$DEST"
# Ensure a fresh .env from the template
[[ -f "$DEST/.env" ]] || cp "$DEST/.env.example" "$DEST/.env"

echo "✓ Copied harness to $DEST"
echo
echo "Next steps:"
echo "  1. Edit $DEST/.env  (WORKSPACE_DIR, ISSUE_LABEL, GH_TOKEN, DEP_ORDER_FILE)"
echo "  2. cd $TARGET && npm install -D @ai-hero/sandcastle tsx zod"
echo "  3. npm pkg set scripts.sandcastle=\"tsx .sandcastle/main.mts\""
echo "  4. 9router &   # start the gateway"
echo "  5. npx tsx .sandcastle/check-models.mts   # verify models are live"
echo "  6. nohup npm run sandcastle > .sandcastle/run.log 2>&1 &"
