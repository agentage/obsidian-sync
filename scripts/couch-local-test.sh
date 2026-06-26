#!/bin/bash
# Local end-to-end test rig for the experimental CouchDB sync channel.
# Stands up: a CouchDB on :5985, a per-memory db, a bare git repo flipped to the
# couch channel, and the server bridge - then prints the exact plugin settings and
# LIVE-watches the chain so you can SEE: edit a note in Obsidian -> couch doc -> git commit.
#
# Usage:  bash scripts/couch-local-test.sh
# Stop:   Ctrl-C (leaves the couch container + test dir; re-run is idempotent).
set -u
C=http://127.0.0.1:5985
ADMIN_USER=admin
ADMIN_PASS=password
AUTHB="Basic $(printf '%s' "$ADMIN_USER:$ADMIN_PASS" | base64 | tr -d '\n')"
MEMORY_ID="utest/notes"
TESTDIR="${COUCH_TEST_DIR:-$HOME/couch-sync-test}"
REPOS="$TESTDIR/git-repos"
BARE="$REPOS/utest/notes.git"
# The bridge entry built in the agentage/web couch-deploy worktree (PR #379). Override
# with BRIDGE_JS=... if you built it elsewhere (cd web && npm run build -w @agentage/memory-mcp).
BRIDGE_JS="${BRIDGE_JS:-$HOME/.worktrees/web/couch-channel-gate/packages/memory-mcp/dist/bridge.js}"

DB="mem_$(node -e "import('node:crypto').then(c=>process.stdout.write(c.createHash('sha256').update('$MEMORY_ID').digest('hex').slice(0,40)))")"

echo "== 1. CouchDB on :5985 =="
if ! curl -sf -m3 "$C/_up" >/dev/null 2>&1; then
  echo "starting couchdb:3.4 ..."
  docker run -d --name couch-localtest -p 127.0.0.1:5985:5984 \
    -e COUCHDB_USER=$ADMIN_USER -e COUCHDB_PASSWORD=$ADMIN_PASS couchdb:3.4 >/dev/null
  for i in $(seq 1 30); do curl -sf -m2 "$C/_up" >/dev/null 2>&1 && break; sleep 1; done
  sleep 2; curl -s -u $ADMIN_USER:$ADMIN_PASS -X PUT "$C/_users" >/dev/null
fi
echo "couch up."

echo "== 2. provision the per-memory db: $DB =="
curl -s -u $ADMIN_USER:$ADMIN_PASS -X PUT "$C/$DB?q=1" >/dev/null

echo "== 3. bare git repo on the couch channel: $BARE =="
mkdir -p "$(dirname "$BARE")"
[ -d "$BARE" ] || git init --bare -b main "$BARE" >/dev/null
printf 'couch\n' > "$BARE/agentage-channel"   # the per-memory gate marker

echo "== 4. start the bridge (couch <-> git) =="
if [ -f "$BRIDGE_JS" ]; then
  GIT_REPOS_ROOT="$REPOS" COUCH_CLUSTER_URL="$C" COUCH_ADMIN_USER=$ADMIN_USER \
    COUCH_ADMIN_PASSWORD=$ADMIN_PASS PORT=3099 COUCH_BRIDGE_INTERVAL_MS=500 \
    node "$BRIDGE_JS" > "$TESTDIR/bridge.log" 2>&1 &
  BPID=$!; sleep 1.5
  echo "bridge running (pid $BPID, log $TESTDIR/bridge.log)."
else
  BPID=""
  echo "!! bridge not found at $BRIDGE_JS — couch<->git step is OFF."
  echo "   You'll still see Obsidian -> couch. To enable -> git, build PR #379's bridge and set BRIDGE_JS."
fi

cat <<EOF

============================================================
 PLUGIN SETTINGS  (Obsidian → Settings → Agentage Sync → CouchDB sync)
   Enable CouchDB sync : ON
   Couch endpoint      : $C
   Couch database      : $DB
   Authorization header: $AUTHB
============================================================
 HOW YOU KNOW IT'S WIRED:
   Edit/create a markdown note in your test vault. Within ~1s you'll see below:
     [couch]  f:<path>     <- the plugin pushed it to CouchDB
     [git]    sync: <path> <- the bridge committed it to git (the source of truth)
============================================================

EOF
echo "watching (Ctrl-C to stop)..."
cleanup() { [ -n "$BPID" ] && kill "$BPID" 2>/dev/null; echo; echo "stopped (couch container + $TESTDIR left in place)."; exit 0; }
trap cleanup INT TERM
lastdocs=""; lastcommit=""
while true; do
  docs=$(curl -s -u $ADMIN_USER:$ADMIN_PASS "$C/$DB/_all_docs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.rows||[]).map(r=>r.id).filter(i=>i.startsWith('f:')).join('\n'))}catch{}})" 2>/dev/null)
  if [ "$docs" != "$lastdocs" ]; then echo "$docs" | grep -vF "$lastdocs" 2>/dev/null | sed 's/^/[couch]  /'; lastdocs="$docs"; fi
  commit=$(git --git-dir="$BARE" log --pretty='%s' -1 2>/dev/null)
  if [ -n "$commit" ] && [ "$commit" != "$lastcommit" ]; then echo "[git]    $commit"; lastcommit="$commit"; fi
  sleep 1
done
