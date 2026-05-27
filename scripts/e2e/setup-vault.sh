#!/usr/bin/env bash
# Create a temp Obsidian test vault with the *built* plugin copied in (not
# symlinked — so the vault's data.json doesn't clobber the repo's local
# data.json during dev), plus the host-side Obsidian config that points the
# app at the vault on launch.
#
# Env overrides:
#   PLUGIN_ROOT       — plugin repo root (defaults to $GITHUB_WORKSPACE, then PWD).
#   VAULT             — vault directory (defaults to /tmp/obsidian-test-vault).
#   VAULT_ID          — id in obsidian.json (defaults to citest).
#   COUCHDB_URL       — defaults to http://localhost:5984.
#   COUCHDB_USER      — defaults to admin.
#   COUCHDB_PASSWORD  — defaults to agentage.
#   COUCHDB_DB        — defaults to agentage-memory-e2e (isolated from dev data).
set -euo pipefail

PLUGIN_ROOT="${PLUGIN_ROOT:-${GITHUB_WORKSPACE:-$PWD}}"
VAULT="${VAULT:-/tmp/obsidian-test-vault}"
VAULT_ID="${VAULT_ID:-citest}"
COUCHDB_URL="${COUCHDB_URL:-http://localhost:5984}"
COUCHDB_USER="${COUCHDB_USER:-admin}"
COUCHDB_PASSWORD="${COUCHDB_PASSWORD:-agentage}"
COUCHDB_DB="${COUCHDB_DB:-agentage-memory-e2e}"

PLUGIN_DIR="$VAULT/.obsidian/plugins/agentage-memory"
mkdir -p "$PLUGIN_DIR"
cp "$PLUGIN_ROOT/main.js" "$PLUGIN_ROOT/manifest.json" "$PLUGIN_ROOT/styles.css" "$PLUGIN_DIR/"
echo '["agentage-memory"]' > "$VAULT/.obsidian/community-plugins.json"
echo "# CI smoke" > "$VAULT/Welcome.md"
cat > "$VAULT/.obsidian/workspace.json" <<'WSEOF'
{ "main": { "id": "root", "type": "split", "children": [] }, "left": { "id": "left", "type": "split", "children": [] }, "right": { "id": "right", "type": "split", "children": [] }, "active": "root" }
WSEOF
echo '{}' > "$VAULT/.obsidian/appearance.json"

cat > "$PLUGIN_DIR/data.json" <<EOF
{
  "serverUrl": "$COUCHDB_URL",
  "username": "$COUCHDB_USER",
  "password": "$COUCHDB_PASSWORD",
  "dbName": "$COUCHDB_DB"
}
EOF

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

ls -la "$PLUGIN_DIR" "$VAULT/.obsidian/" "$HOME/.config/obsidian/"
cat "$PLUGIN_DIR/data.json"
