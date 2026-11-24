#!/bin/bash

# set -x
set -e

# 1. Global update: pulls ~/.claude and re-runs itself from the pulled version, then updates Claude Code, the plugin
#    marketplaces and mods, the skills, pnpm, and the CLI tools (gh, jq, linear-cli, sentry).
echo "Running global update..."
"$HOME/.claude/update.sh"
echo ""

# 2. Project-specific tasks
source "$HOME/.claude/lib/lint.sh"

echo "Running project-specific updates..."
# /update calls this script by absolute path from any cwd; outside the repo `pnpm check-biome` has no package.json to read.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
lint_and_fix "pnpm check-biome && pnpm check-markdown"

echo ""
echo "Done! You must restart Claude (or vscode) for the changes to take effect."
