#!/usr/bin/env bash
# Create a temp Obsidian test vault with the plugin symlinked in, plus the
# host-side Obsidian config that points the app at it on launch. Without the
# host-side config Obsidian shows the vault picker and quits headlessly;
# without the per-vault and workspace stubs Obsidian's first-run code path
# bails before painting a window.
#
# Env overrides:
#   PLUGIN_ROOT — path that becomes .obsidian/plugins/agentage-memory
#                 (defaults to $GITHUB_WORKSPACE, then PWD).
#   VAULT       — vault directory (defaults to /tmp/obsidian-test-vault).
#   VAULT_ID    — id used in obsidian.json (defaults to citest).
set -euo pipefail

PLUGIN_ROOT="${PLUGIN_ROOT:-${GITHUB_WORKSPACE:-$PWD}}"
VAULT="${VAULT:-/tmp/obsidian-test-vault}"
VAULT_ID="${VAULT_ID:-citest}"

mkdir -p "$VAULT/.obsidian/plugins"
ln -sfn "$PLUGIN_ROOT" "$VAULT/.obsidian/plugins/agentage-memory"
echo '["agentage-memory"]' > "$VAULT/.obsidian/community-plugins.json"
echo "# CI smoke" > "$VAULT/Welcome.md"
cat > "$VAULT/.obsidian/workspace.json" <<'WSEOF'
{ "main": { "id": "root", "type": "split", "children": [] }, "left": { "id": "left", "type": "split", "children": [] }, "right": { "id": "right", "type": "split", "children": [] }, "active": "root" }
WSEOF
echo '{}' > "$VAULT/.obsidian/appearance.json"

mkdir -p "$HOME/.config/obsidian"
TS=$(date +%s%3N)
cat > "$HOME/.config/obsidian/obsidian.json" <<EOF
{
  "vaults": {
    "$VAULT_ID": { "path": "$VAULT", "ts": $TS, "open": true }
  }
}
EOF
echo '{}' > "$HOME/.config/obsidian/$VAULT_ID.json"

ls -la "$VAULT/.obsidian/" "$HOME/.config/obsidian/"
