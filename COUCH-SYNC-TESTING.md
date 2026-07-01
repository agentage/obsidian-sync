# Testing the experimental CouchDB sync channel

This adds an **opt-in CouchDB sync channel** to the plugin (alongside the existing git
sync). The plugin replicates your vault's markdown into a per-memory CouchDB; the server
**bridge** then commits every couch edit to git. So the proof it's wired is simple:

> **Edit a note in Obsidian → it appears as a CouchDB doc → the bridge makes a git commit.**

It's a **thin client** (Obsidian `requestUrl` + Web Crypto, no PouchDB), experimental, desktop-only.

## 1. Build + install the plugin into a test vault

```bash
npm install && npm run build          # produces main.js
# copy the 3 plugin files into a TEST vault (not your real one):
DEST="<your-test-vault>/.obsidian/plugins/agentage-memory"
mkdir -p "$DEST" && cp main.js manifest.json styles.css "$DEST"/
```

Open the test vault in Obsidian → **Settings → Community plugins → enable "Agentage Sync"**.

## 2. Stand up couch + the bridge locally (one command)

```bash
bash scripts/couch-local-test.sh
```

It starts CouchDB on `:5985`, provisions the per-memory db, creates a bare git repo flipped
to the couch channel, starts the **bridge**, then prints the exact settings and **live-watches
the chain**. (The bridge entry comes from `agentage/web` PR #379 — by default the script looks
for it at `~/.worktrees/web/couch-channel-gate/packages/memory-mcp/dist/bridge.js`; set
`BRIDGE_JS=...` if you built it elsewhere via `npm run build -w @agentage/memory-mcp`.)

## 3. Point the plugin at it

In Obsidian → **Settings → Agentage Sync → CouchDB sync (experimental)**:

- **Enable CouchDB sync**: ON
- **Couch endpoint** / **Couch database** / **Authorization header**: paste the three values
  the script printed (endpoint `http://localhost:5985`, the `mem_…` db, and `Basic …`).

Then **reload the plugin** (toggle it off/on in Community plugins, or reload Obsidian) so the
sync starts with the new settings.

## 4. Watch it get wired

Create or edit a markdown note in the test vault. Within ~1 second the watching terminal prints:

```
[couch]  f:notes/your-note.md     <- the plugin pushed it to CouchDB
[git]    sync: notes/your-note.md <- the bridge committed it to git (the source of truth)
```

That's the end-to-end proof. You can also check directly:

```bash
# the couch doc:
curl -s -u admin:password http://localhost:5985/<the-mem_-db>/_all_docs | grep f:
# the git commit (the real source of truth):
git --git-dir ~/couch-sync-test/git-repos/utest/notes.git log --oneline
```

A **server-side** edit also flows back: commit a change into that bare repo (or let MCP/REST
write it) and the bridge projects it to couch; the plugin pulls it into the vault on its next tick.

## Notes / scope

- **Experimental + thin client.** Conflict handling is the server's (CouchDB winner + git
  `.dup`); the production-grade offline-queue (PouchDB) is the reliability upgrade (onepager
  decision 8). This MVP proves the wiring.
- **Dev auth.** For local testing the Authorization header is `Basic admin:password` (couch
  admin). The real flow is per-(user,memory) JWTs minted by the auth service
  (`/account/couch-token`) once the cloud couch edge is deployed (web PR #379 + infra PR #63).
- **Desktop-only**, markdown files only, one configured db = one memory.
